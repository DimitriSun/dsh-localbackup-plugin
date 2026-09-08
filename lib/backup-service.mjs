// dsh-backup-plugin — BackupService (pure Node, no external deps).
// Enumerates the real files under a source dir (never descending into
// junction/symlink directories such as the profile->runtime mirror),
// streams them into an UNCOMPRESSED tar via the system native `tar`
// (bsdtar, ships with Windows 10+), then prunes the backup library to
// keep the newest N versions.
import { spawn } from "node:child_process";
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";

const TAR_CANDIDATES = ["tar", "C:\\Windows\\System32\\tar.exe"];

export class BackupError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.details = details;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local-time stamp: YYYYMMDD-HHmmss */
export function stampOf(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/** Convert a windows path to tar-friendly relative posix name. */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

async function isSymlinkDir(abs) {
  try {
    const st = await fsp.lstat(abs);
    return st.isSymbolicLink();
  } catch {
    return false; // vanished between readdir and lstat — skip entirely downstream
  }
}

/**
 * Recursively collect real files under `absRoot`.
 * @returns {Promise<{files: string[], skippedLinks: number}>}
 *   files are sourceDir-relative posix paths.
 */
export async function enumerateFiles(absRoot) {
  const files = [];
  let skippedLinks = 0;
  const walk = async (absDir, relDir) => {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      throw new BackupError("io", `cannot read directory ${absDir}: ${err.message}`);
    }
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        // junction/symlink (reparse point): never descend, never store content
        skippedLinks += 1;
        continue;
      }
      if (ent.isDirectory()) {
        // readdir-withFileTypes reports junctions as plain dirs on Windows;
        // double check with lstat so the runtime mirror is never followed.
        if (await isSymlinkDir(abs)) {
          skippedLinks += 1;
          continue;
        }
        await walk(abs, rel);
        continue;
      }
      if (ent.isFile()) {
        files.push(toPosix(rel));
      }
      // fifo/socket/device on Windows: ignore
    }
  };
  await walk(absRoot, "");
  return { files, skippedLinks };
}

async function resolveTar() {
  for (const cand of TAR_CANDIDATES) {
    try {
      const probe = spawn(cand, ["--version"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.once("exit", (code) => resolve(code === 0));
      });
      return cand;
    } catch {
      /* try next candidate */
    }
  }
  throw new BackupError("io", "tar (bsdtar) not found on this system");
}

export class BackupService {
  /**
   * @param {object} o
   * @param {string} o.sourceDir  directory tree to back up (real files only)
   * @param {string} o.backupsDir backup library directory (must NOT live inside sourceDir)
   * @param {number} [o.keep=3]
   * @param {number} [o.timeoutMs=120000]
   */
  constructor({ sourceDir, backupsDir, keep = 3, timeoutMs = 120_000 }) {
    this.sourceDir = path.resolve(sourceDir);
    this.backupsDir = path.resolve(backupsDir);
    this.keep = Math.max(1, Math.floor(Number(keep) || 3));
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 120_000);
    this.busy = false;
    this.child = null;
    this.aborted = false;
    this.lastRun = null;
    this.configWarning = null;
    this.recomputeWarning();
  }

  /** Re-derive the nested-backupsDir warning after any runtime config change. */
  recomputeWarning() {
    this.configWarning = this.backupsNested()
      ? `backupsDir (${this.backupsDir}) is inside sourceDir (${this.sourceDir}) — versions would be archived into themselves`
      : null;
  }

  /** Hot-apply setting changes (caller guards against mid-backup mutation). */
  applyRuntime({ backupsDir, keep } = {}) {
    if (typeof backupsDir === "string" && backupsDir.trim()) {
      this.backupsDir = path.resolve(backupsDir.trim());
    }
    if (Number.isInteger(keep)) {
      this.keep = Math.max(1, Math.min(999, keep));
    }
    this.recomputeWarning();
  }

  /** True when `candidate` sits inside `sourceDir` (config mistake). */
  backupsNested() {
    const rel = path.relative(this.sourceDir, this.backupsDir);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /** Kill any in-flight tar child (host unload / abort / timeout). */
  killChild() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  dispose() {
    this.aborted = true;
    this.killChild();
  }

  /**
   * List archived versions already stored, newest first.
   * @returns {Promise<{file:string, size:number, mtime:number}[]>}
   */
  async listBackups() {
    try {
      const names = await fsp.readdir(this.backupsDir);
      const rows = [];
      for (const name of names) {
        if (!/^dsh-backup-\d{8}-\d{6}(?:-\d+)?\.tar$/.test(name)) continue;
        try {
          const st = await fsp.stat(path.join(this.backupsDir, name));
          if (st.isFile()) rows.push({ file: name, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
      rows.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? 1 : -1));
      return rows;
    } catch {
      return [];
    }
  }

  /** One-shot backup: archive + rename + prune. Throws BackupError on failure. */
  async run() {
    if (this.busy) throw new BackupError("busy", "a backup is already running");
    this.busy = true;
    this.aborted = false;
    const started = Date.now();
    let tmpPath = null;
    let listPath = null;
    try {
      if (!existsSync(this.sourceDir)) {
        throw new BackupError("source-missing", `source directory not found: ${this.sourceDir}`);
      }
      await fsp.mkdir(this.backupsDir, { recursive: true });

      // 1. enumerate real files (skip junctions/symlinks)
      const { files, skippedLinks } = await enumerateFiles(this.sourceDir);

      // 2. unique name
      let base = `dsh-backup-${stampOf()}`;
      let finalName = `${base}.tar`;
      let suffix = 2;
      while (existsSync(path.join(this.backupsDir, finalName))) {
        finalName = `${base}-${suffix}.tar`;
        suffix += 1;
      }
      const finalPath = path.join(this.backupsDir, finalName);
      tmpPath = `${finalPath}.tmp`;
      listPath = path.join(this.backupsDir, `.${base}.list`);

      // 3. write the file list
      await fsp.writeFile(listPath, files.join("\n"), { encoding: "utf8" });

      // 4. native uncompressed tar: tar -T <list> -cf <tmp>
      const tar = await resolveTar();
      const startedProbe = Date.now();
      await this._spawnTar(tar, listPath, tmpPath);

      // 5. atomic publish
      try {
        await fsp.rename(tmpPath, finalPath);
      } catch (err) {
        throw new BackupError("io", `rename failed: ${err.message}`);
      }
      const st = await fsp.stat(finalPath);

      // 6. prune to keep
      const existing = await this.listBackups();
      const kept = existing.map((r) => r.file);
      const removed = [];
      const removedErrors = [];
      for (const row of existing.slice(this.keep)) {
        try {
          await fsp.unlink(path.join(this.backupsDir, row.file));
          removed.push(row.file);
        } catch (err) {
          removedErrors.push({ file: row.file, message: err.message });
        }
      }

      const result = {
        ok: true,
        file: finalName,
        bytes: st.size,
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        entries: files.length,
        skippedLinks,
        archiveMs: Date.now() - startedProbe,
        kept,
        removed,
        removedErrors,
      };
      this.lastRun = result;
      this.busy = false;
      return result;
    } catch (err) {
      this.busy = false;
      // best-effort cleanup of partial artifacts
      if (tmpPath) await fsp.unlink(tmpPath).catch(() => {});
      if (listPath) await fsp.unlink(listPath).catch(() => {});
      if (err instanceof BackupError) throw err;
      throw new BackupError("io", `backup failed: ${err.message}`);
    } finally {
      if (tmpPath && existsSync(tmpPath)) await fsp.unlink(tmpPath).catch(() => {});
      if (listPath && existsSync(listPath)) await fsp.unlink(listPath).catch(() => {});
    }
  }

  _spawnTar(tarBin, listPath, tmpPath) {
    return new Promise((resolve, reject) => {
      const args = ["-T", listPath, "-cf", tmpPath];
      let stderr = "";
      let settled = false;
      let child;
      try {
        child = spawn(tarBin, args, {
          cwd: this.sourceDir,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (err) {
        reject(new BackupError("io", `cannot start tar: ${err.message}`));
        return;
      }
      this.child = child;
      child.stderr.on("data", (c) => {
        stderr = (stderr + c.toString("utf8")).slice(-8192);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.child = null;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new BackupError("timeout", `tar exceeded ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        reject(new BackupError("io", `tar spawn error: ${err.message}`));
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        if (this.aborted || signal !== null || code === null) {
          reject(new BackupError("aborted", "backup aborted"));
        } else if (code !== 0) {
          reject(
            new BackupError(
              "archive-failed",
              `tar exited with code ${code}: ${stderr.trim() || "no stderr"}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }
}

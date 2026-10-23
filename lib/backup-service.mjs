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

/** Retry rounds allowed when individual members fail for per-file reasons. */
const MAX_ROUNDS = 5;

/** Windows caps a process command line near 32767 characters; keep a wide margin. */
const ARGV_BUDGET_CHARS = 12000;
const ARGV_BUDGET_ITEMS = 200;

/**
 * Whether a member path is printable ASCII.
 *
 * bsdtar reads a `-T` list as raw bytes in the active ANSI code page, but the
 * Windows entry point converts argv through wmain (UTF-16 -> UTF-8). A member
 * whose path carries any non-ASCII character therefore cannot be resolved from
 * a list — bsdtar reports its parent directory as unvisitable — and must travel
 * as a command-line operand instead.
 * @param {string} value
 * @returns {boolean}
 */
export function isAsciiPath(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Split members into the list-file part and argv-safe chunks.
 * @param {string[]} entries
 * @param {number} [budgetChars]
 * @param {number} [budgetItems]
 * @returns {{ascii: string[], wideChunks: string[][]}}
 */
export function splitForTar(entries, budgetChars = ARGV_BUDGET_CHARS, budgetItems = ARGV_BUDGET_ITEMS) {
  const ascii = [];
  const wideChunks = [];
  let chunk = [];
  let chars = 0;
  for (const entry of entries) {
    if (isAsciiPath(entry)) {
      ascii.push(entry);
      continue;
    }
    if (chunk.length > 0 && (chunk.length >= budgetItems || chars + entry.length > budgetChars)) {
      wideChunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(entry);
    chars += entry.length + 1;
  }
  if (chunk.length > 0) wideChunks.push(chunk);
  return { ascii, wideChunks };
}

/** bsdtar stderr lines that name one member it could not archive. */
const TAR_FAILURE_PATTERNS = [
  [/^tar(?:\.exe)?: (.+): (?:Couldn't visit directory|Cannot stat|Couldn't stat|File removed before we read it):?\s*(.*)$/i, "missing"],
  [/^tar(?:\.exe)?: Couldn't open (.+): (.*)$/i, "locked"],
  [/^tar(?:\.exe)?: (.+): (?:File changed as we read it|File shrank)/i, "unstable"],
];

/**
 * Parse bsdtar stderr into per-member failures.
 *
 * `missing` means the entry is gone, `locked` means another process holds a
 * share mode that denies bsdtar's open (Windows reports that as "Permission
 * denied"), and `unstable` means the member was archived while it changed.
 * @param {string} stderr
 * @returns {{kind: "missing" | "locked" | "unstable", path: string, detail: string}[]}
 */
export function parseTarFailures(stderr) {
  const failures = [];
  for (const rawLine of String(stderr ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("tar")) continue;
    for (const [pattern, kind] of TAR_FAILURE_PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const entryPath = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
      failures.push({ kind, path: entryPath, detail: (match[2] ?? "").trim() });
      break;
    }
  }
  return failures;
}

/** Whether one reported member failure covers a listed member. */
export function coversPath(entry, failedPath) {
  if (failedPath === "") return false;
  return entry === failedPath || entry.startsWith(`${failedPath}/`);
}

/**
 * Build the ordered tar invocations for one archive attempt.
 * @param {{tmpPath: string, sourceDir: string, stageDir: string, listPath: string, stageListPath: string,
 *   source: {ascii: string[], wideChunks: string[][]}, staged: {ascii: string[], wideChunks: string[][]}}} plan
 * @returns {{mode: "cf" | "rf", args: string[]}[]}
 */
export function buildTarRuns({ tmpPath, sourceDir, stageDir, listPath, stageListPath, source, staged }) {
  const runs = [];
  const wide = source.wideChunks.slice();
  if (source.ascii.length > 0) {
    runs.push({ mode: "cf", args: [tmpPath, "-C", sourceDir, "-T", listPath, ...(wide.shift() ?? [])] });
  } else if (wide.length > 0) {
    runs.push({ mode: "cf", args: [tmpPath, "-C", sourceDir, ...wide.shift()] });
  } else {
    // An empty list still creates a valid, empty archive.
    runs.push({ mode: "cf", args: [tmpPath, "-C", sourceDir, "-T", listPath] });
  }
  for (const chunk of wide) runs.push({ mode: "rf", args: [tmpPath, "-C", sourceDir, ...chunk] });

  const stagedWide = staged.wideChunks.slice();
  if (staged.ascii.length > 0) {
    runs.push({ mode: "rf", args: [tmpPath, "-C", stageDir, "-T", stageListPath, ...(stagedWide.shift() ?? [])] });
  }
  for (const chunk of stagedWide) runs.push({ mode: "rf", args: [tmpPath, "-C", stageDir, ...chunk] });
  return runs;
}

/** Remove one value from a list in place. */
function removeFrom(list, value) {
  const index = list.indexOf(value);
  if (index !== -1) list.splice(index, 1);
}

/** Append a value once, keeping report order. */
function noteUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * Human-readable archive failure summary naming every member bsdtar refused.
 * @param {{kind: string, path: string, detail: string}[]} failures
 * @param {string} stderr
 * @returns {string}
 */
function describeFailures(failures, stderr) {
  const named = failures
    .filter((failure) => failure.path !== "")
    .map((failure) => `${failure.path} (${failure.kind}${failure.detail ? `: ${failure.detail}` : ""})`);
  const head = named.slice(0, 5).join(", ");
  return `tar could not archive ${failures.length} member(s)${head ? `: ${head}${named.length > 5 ? ", …" : ""}` : ""}`
    + `${stderr.trim() ? `; tar said: ${stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}` : ""}`;
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
    this.lastError = null;
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
    let stageListPath = null;
    let stageDir = null;
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
      stageListPath = path.join(this.backupsDir, `.${base}.stage.list`);

      // 3. native uncompressed tar; per-member failures are tolerated and reported
      stageDir = path.join(this.backupsDir, `.${base}.stage`);
      const tar = await resolveTar();
      const startedProbe = Date.now();
      const plan = { active: files.slice(), staged: [], skipped: [], unstable: [], rounds: 0 };
      await this._writeArchive(tar, plan, { tmpPath, listPath, stageListPath, stageDir });

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
        rounds: plan.rounds,
        liveCopies: plan.staged.length,
        skipped: plan.skipped.slice(0, 50),
        skippedCount: plan.skipped.length,
        unstable: plan.unstable.slice(0, 50),
        archiveMs: Date.now() - startedProbe,
        kept,
        removed,
        removedErrors,
      };
      this.lastRun = result;
      this.lastError = null;
      const notes = [];
      if (result.liveCopies > 0) notes.push(`${result.liveCopies} live copy(ies)`);
      if (result.skippedCount > 0) notes.push(`${result.skippedCount} skipped`);
      if (result.unstable.length > 0) notes.push(`${result.unstable.length} changing while read`);
      console.log(
        `[dsh-backup] wrote ${finalName} (${(st.size / 1048576).toFixed(1)} MB, ${files.length} entries,`
          + ` ${result.rounds} tar pass(es))${notes.length > 0 ? ` — ${notes.join(", ")}` : ""}`,
      );
      for (const row of result.skipped.slice(0, 10)) {
        console.warn(`[dsh-backup] skipped ${row.path} (${row.reason}${row.detail ? `: ${row.detail}` : ""})`);
      }
      this.busy = false;
      return result;
    } catch (err) {
      this.busy = false;
      this.lastError = { message: err && err.message ? err.message : String(err), at: new Date().toISOString() };
      // best-effort cleanup of partial artifacts
      if (tmpPath) await fsp.unlink(tmpPath).catch(() => {});
      if (listPath) await fsp.unlink(listPath).catch(() => {});
      if (stageListPath) await fsp.unlink(stageListPath).catch(() => {});
      if (stageDir) await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof BackupError) throw err;
      throw new BackupError("io", `backup failed: ${err.message}`);
    } finally {
      if (tmpPath && existsSync(tmpPath)) await fsp.unlink(tmpPath).catch(() => {});
      if (listPath && existsSync(listPath)) await fsp.unlink(listPath).catch(() => {});
      if (stageListPath && existsSync(stageListPath)) await fsp.unlink(stageListPath).catch(() => {});
      if (stageDir) await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Run one tar invocation.
   * @param {string} tarBin
   * @param {string[]} args
   * @returns {Promise<{code: number, stderr: string}>} exit code and captured stderr (non-zero is returned, not thrown)
   */
  _spawnTar(tarBin, args) {
    return new Promise((resolve, reject) => {
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
        } else {
          resolve({ code, stderr });
        }
      });
    });
  }

  /**
   * Archive every member, tolerating per-member failures.
   *
   * A round runs the whole planned sequence. Members bsdtar cannot read are
   * resolved for the next round: a locked member is copied into the staging
   * tree (Node opens it with permissive sharing) and appended from there; a
   * vanished member is dropped and reported. The loop stops as soon as a round
   * succeeds, and fails when a round makes no progress.
   * @param {string} tar
   * @param {{active: string[], staged: string[], skipped: object[], unstable: string[], rounds: number}} plan
   * @param {{tmpPath: string, listPath: string, stageListPath: string, stageDir: string}} paths
   */
  async _writeArchive(tar, plan, paths) {
    let lastStderr = "";
    let lastCode = 1;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      await fsp.rm(paths.tmpPath, { force: true }).catch(() => {});
      const source = splitForTar(plan.active);
      const staged = splitForTar(plan.staged);
      await fsp.writeFile(paths.listPath, source.ascii.join("\n"), { encoding: "utf8" });
      await fsp.writeFile(paths.stageListPath, staged.ascii.join("\n"), { encoding: "utf8" });
      const runs = buildTarRuns({
        tmpPath: paths.tmpPath,
        sourceDir: this.sourceDir,
        stageDir: paths.stageDir,
        listPath: paths.listPath,
        stageListPath: paths.stageListPath,
        source,
        staged,
      });
      let stderr = "";
      let code = 0;
      for (const run of runs) {
        const result = await this._spawnTar(tar, [run.mode === "cf" ? "-cf" : "-rf", ...run.args]);
        stderr += result.stderr;
        if (result.code !== 0) {
          code = result.code;
          break;
        }
      }
      if (code === 0) {
        plan.rounds = round;
        return;
      }
      lastStderr = stderr;
      lastCode = code;
      const failures = parseTarFailures(stderr);
      if (failures.length === 0) {
        throw new BackupError("archive-failed", `tar exited with code ${code}: ${stderr.trim() || "no stderr"}`);
      }
      for (const failure of failures) {
        if (failure.kind === "unstable") noteUnique(plan.unstable, failure.path);
      }
      const progressed = await this._applyFailures(plan, failures, paths.stageDir);
      if (!progressed) throw new BackupError("archive-failed", describeFailures(failures, stderr));
    }
    throw new BackupError(
      "archive-failed",
      `tar still exited with code ${lastCode} after ${MAX_ROUNDS} attempts: ${lastStderr.trim()}`,
    );
  }

  /**
   * Apply one round of member failures to the plan.
   * @param {{active: string[], staged: string[], skipped: object[], unstable: string[]}} plan
   * @param {{kind: string, path: string, detail: string}[]} failures
   * @param {string} stageDir
   * @returns {Promise<boolean>} whether the plan changed (a further round is worth running)
   */
  async _applyFailures(plan, failures, stageDir) {
    let progressed = false;
    for (const failure of failures) {
      if (failure.kind === "unstable") continue;
      const activeHits = plan.active.filter((entry) => coversPath(entry, failure.path));
      const stagedHits = plan.staged.filter((entry) => coversPath(entry, failure.path));
      if (failure.kind === "locked") {
        for (const entry of activeHits) {
          const target = path.join(stageDir, entry);
          try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(path.join(this.sourceDir, entry), target);
            removeFrom(plan.active, entry);
            plan.staged.push(entry);
          } catch (error) {
            removeFrom(plan.active, entry);
            plan.skipped.push({ path: entry, reason: "locked", detail: error.code ?? error.message });
          }
          progressed = true;
        }
        for (const entry of stagedHits) {
          removeFrom(plan.staged, entry);
          plan.skipped.push({ path: entry, reason: "locked", detail: "staged copy unreadable" });
          progressed = true;
        }
        continue;
      }
      for (const entry of [...activeHits, ...stagedHits]) {
        removeFrom(plan.active, entry);
        removeFrom(plan.staged, entry);
        plan.skipped.push({ path: entry, reason: "missing", detail: failure.detail });
        progressed = true;
      }
      if (activeHits.length === 0 && stagedHits.length === 0) {
        // bsdtar can report an unnamed parent directory; re-check existence directly.
        if ((await this._dropMissing(plan)) > 0) progressed = true;
      }
    }
    return progressed;
  }

  /**
   * Drop every planned member that no longer exists.
   * @param {{active: string[], staged: string[], skipped: object[]}} plan
   * @returns {Promise<number>} how many members were dropped
   */
  async _dropMissing(plan) {
    let dropped = 0;
    for (const entry of [...plan.active, ...plan.staged]) {
      try {
        await fsp.stat(path.join(this.sourceDir, entry));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") continue;
        removeFrom(plan.active, entry);
        removeFrom(plan.staged, entry);
        plan.skipped.push({ path: entry, reason: "missing", detail: error.code });
        dropped += 1;
      }
    }
    return dropped;
  }
}

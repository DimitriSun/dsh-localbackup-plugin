// Archived-member robustness tests for dsh-backup-plugin.
// Covers the two failures seen on a live dsh home:
//  1) a non-ASCII member name that bsdtar cannot resolve from a -T list
//  2) a member held open by another process (Windows sharing violation)
// plus the failure classification those retries rely on.
// Run: node test/archive.test.mjs
import { spawn, spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BackupService,
  buildTarRuns,
  coversPath,
  parseTarFailures,
  splitForTar,
} from "../lib/backup-service.mjs";

const root = path.join(os.tmpdir(), `dsh-backup-archive-test-${process.pid}`);
const src = path.join(root, "src");
const bkp = path.join(root, "backups");
const CJK_FILE = "V100摆件_中板丝印排版_B型板_1比1_UTF8.dxf";
const CJK_DIR = "目录";

let failures = 0;
function check(name, cond, extra) {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  -> ${extra}` : ""}`);
  if (!ok) failures += 1;
}

async function mkfile(p, content = "x") {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
}

/** Members of one tar archive, or [] when tar rejects it. `tar -tf` prints in the ANSI code page. */
function listTar(archive) {
  const out = spawnSync("tar", ["-tf", archive]);
  if (out.status !== 0) return [];
  const decoded = new Set();
  for (const encoding of ["gbk", "utf8"]) {
    try {
      for (const line of new TextDecoder(encoding).decode(out.stdout).split(/\r?\n/)) {
        if (line) decoded.add(line);
      }
    } catch {
      /* encoding unavailable in this Node build */
    }
  }
  return [...decoded];
}

/** Hold one file open with write access and read-only sharing, like SQLite does. */
function lockFile(target, seconds) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$h=[System.IO.File]::Open('${target.replace(/'/g, "''")}','Open','ReadWrite','Read')`,
    `Start-Sleep -Seconds ${seconds}`,
    "$h.Close()",
  ].join("; ");
  const exe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0
    ? "powershell.exe"
    : "pwsh";
  return spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}

try {
  // ---------------------------------------------------------------- pure helpers
  const liveStderr = [
    `tar: attachments/v1/files/3a/3a498e2edf4261dc2a6f3f6c76469ca874d7ddf3505535c30822dc688d43e80f: Couldn't visit directory: No such file or directory`,
    "tar: Couldn't open integrations/dsh-im/group-history.sqlite: Permission denied",
    "tar: Couldn't open integrations/dsh-im/group-history.sqlite-shm: Permission denied",
    "tar: Couldn't open integrations/dsh-im/group-history.sqlite-wal: Permission denied",
    "tar: Error exit delayed from previous errors.",
  ].join("\r\n");

  const parsed = parseTarFailures(liveStderr);
  check("parse: live log yields 4 failures", parsed.length === 4, JSON.stringify(parsed));
  check(
    "parse: unvisitable directory is a missing member",
    parsed[0].kind === "missing" && parsed[0].path === "attachments/v1/files/3a/3a498e2edf4261dc2a6f3f6c76469ca874d7ddf3505535c30822dc688d43e80f",
  );
  check(
    "parse: permission denied is a locked member",
    parsed[1].kind === "locked" && parsed[1].path === "integrations/dsh-im/group-history.sqlite",
  );
  check(
    "parse: changing-while-read is a warning, not a failure",
    parseTarFailures("tar: x.db: File changed as we read it").every((f) => f.kind === "unstable"),
  );

  check("covers: exact member", coversPath("a/b.txt", "a/b.txt"));
  check("covers: descendants of a reported directory", coversPath("a/b/c.txt", "a/b"));
  check("covers: sibling is untouched", !coversPath("a/bc.txt", "a/b"));
  check("covers: empty report matches nothing", !coversPath("a/b.txt", ""));

  const split = splitForTar(["ascii.txt", `a/${CJK_FILE}`, "b.txt", `${CJK_DIR}/inner.txt`]);
  check("split: ascii members stay in the list", JSON.stringify(split.ascii) === JSON.stringify(["ascii.txt", "b.txt"]), JSON.stringify(split.ascii));
  check("split: non-ascii members become argv", split.wideChunks.length === 1 && split.wideChunks[0].length === 2, JSON.stringify(split.wideChunks));
  const chunked = splitForTar(["a/一.txt", "a/二.txt", "a/三.txt"], 1, 2);
  check(
    "split: argv chunks respect the budget and never empty",
    chunked.wideChunks.length === 3 && chunked.wideChunks.every((chunk) => chunk.length === 1),
    JSON.stringify(chunked.wideChunks),
  );
  check(
    "split: no empty chunk is ever produced",
    splitForTar(["a/一.txt", "b.txt"], 0, 1).wideChunks.every((chunk) => chunk.length > 0),
  );

  const runs = buildTarRuns({
    tmpPath: "T",
    sourceDir: "S",
    stageDir: "G",
    listPath: "L",
    stageListPath: "SL",
    source: splitForTar(["ascii.txt", `a/${CJK_FILE}`]),
    staged: splitForTar([]),
  });
  check("runs: first invocation creates the archive", runs[0].mode === "cf" && runs[0].args[0] === "T" && runs[0].args.includes("-T"), JSON.stringify(runs[0]));
  check("runs: the non-ascii member travels as an operand", runs[0].args.includes(`a/${CJK_FILE}`), JSON.stringify(runs[0]));
  const stagedRuns = buildTarRuns({
    tmpPath: "T",
    sourceDir: "S",
    stageDir: "G",
    listPath: "L",
    stageListPath: "SL",
    source: splitForTar(["ascii.txt"]),
    staged: splitForTar(["integrations/x.sqlite"]),
  });
  check(
    "runs: staged members append from the staging tree",
    stagedRuns.length === 2 && stagedRuns[1].mode === "rf" && stagedRuns[1].args.includes("G") && stagedRuns[1].args.includes("SL"),
    JSON.stringify(stagedRuns),
  );
  const emptyRuns = buildTarRuns({
    tmpPath: "T", sourceDir: "S", stageDir: "G", listPath: "L", stageListPath: "SL",
    source: splitForTar([]), staged: splitForTar([]),
  });
  check("runs: an empty tree still creates an archive", emptyRuns.length === 1 && emptyRuns[0].mode === "cf");

  // ---------------------------------------------------------------- end to end
  await fsp.mkdir(root, { recursive: true });
  await mkfile(path.join(src, "settings.yaml"), "a: 1\n");
  await mkfile(path.join(src, CJK_DIR, "inner.txt"), "inner\n");
  await mkfile(path.join(src, "attachments", "v1", "files", "3a", "deadbeef", CJK_FILE), "dxf-bytes\n");
  await mkfile(path.join(src, "integrations", "dsh-im", "group-history.sqlite"), "sqlite-bytes\n".repeat(30));

  const service = new BackupService({ sourceDir: src, backupsDir: bkp, keep: 2, timeoutMs: 60_000 });

  const first = await service.run();
  check("e2e: plain tree archives", first.ok === true && first.bytes > 0, JSON.stringify({ ok: first.ok, bytes: first.bytes }));
  const firstArchive = path.join(bkp, first.file);
  const members = listTar(firstArchive);
  check("e2e: ascii member archived", members.includes("settings.yaml"), JSON.stringify(members));
  check(
    "e2e: non-ascii member archived through argv",
    members.includes(`attachments/v1/files/3a/deadbeef/${CJK_FILE}`),
    JSON.stringify(members),
  );
  check("e2e: non-ascii directory archived", members.includes(`${CJK_DIR}/inner.txt`), JSON.stringify(members));
  check("e2e: no skipped members on a quiet tree", first.skippedCount === 0 && first.liveCopies === 0, JSON.stringify(first.skipped));

  const extractDir = path.join(root, "extract");
  await fsp.mkdir(extractDir, { recursive: true });
  spawnSync("tar", ["-xf", firstArchive, "-C", extractDir], { encoding: "utf8" });
  const extracted = await fsp.readFile(path.join(extractDir, "attachments", "v1", "files", "3a", "deadbeef", CJK_FILE), "utf8");
  check("e2e: non-ascii name and content round-trip", extracted === "dxf-bytes\n", JSON.stringify(extracted));

  // A member another process holds open: bsdtar cannot open it, Node can copy it.
  if (process.platform === "win32") {
    const lockedPath = path.join(src, "integrations", "dsh-im", "group-history.sqlite");
    const holder = lockFile(lockedPath, 25);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await service.run();
    holder.kill();
    check("e2e: locked member does not fail the run", second.ok === true, JSON.stringify(second.skipped));
    check("e2e: locked member is included as a live copy", second.liveCopies >= 1, JSON.stringify(second));
    const secondMembers = listTar(path.join(bkp, second.file));
    check(
      "e2e: locked member present in the archive",
      secondMembers.includes("integrations/dsh-im/group-history.sqlite"),
      JSON.stringify(secondMembers),
    );
  } else {
    console.log("SKIP  locked-member case (Windows only)");
  }

  // A reported directory that vanished drops its descendants rather than failing.
  if (process.platform === "win32") {
    const vanishDir = path.join(src, "gone");
    await mkfile(path.join(vanishDir, "a.txt"), "a\n");
    await mkfile(path.join(vanishDir, "b", "c.txt"), "c\n");
    const plan = { active: ["gone/a.txt", "gone/b/c.txt", "settings.yaml"], staged: [], skipped: [], unstable: [] };
    const progressed = await service._applyFailures(plan, [{ kind: "missing", path: "gone", detail: "ENOENT" }], path.join(root, "stage"));
    check("apply: vanished directory drops its descendants", progressed && plan.active.length === 1, JSON.stringify(plan.active));
    check("apply: dropped members are reported", plan.skipped.length === 2 && plan.skipped.every((row) => row.reason === "missing"), JSON.stringify(plan.skipped));
  }
} finally {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

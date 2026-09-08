// Standalone core self-test for dsh-backup-plugin BackupService.
// Creates a fake source tree with a junction, runs backups, and asserts:
//  1) tar contains only real files (junction content excluded)
//  2) archive is produced and bytes > 0
//  3) prune keeps exactly `keep` versions
// Run: node test/core.test.mjs
import { spawnSync } from "node:child_process";
import { promises as fsp, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackupService, enumerateFiles } from "../lib/backup-service.mjs";

const root = path.join(os.tmpdir(), `dsh-backup-core-test-${process.pid}`);
const src = path.join(root, "src");
const ext = path.join(root, "external-target");
const bkp = path.join(root, "backups");
const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, cond, extra) {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  -> " + extra : ""}`);
  if (!ok) failures += 1;
}

async function mkfile(p, content = "x") {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
}

try {
  // fake source tree
  await mkfile(path.join(src, "settings.yaml"), "a: 1\n");
  await mkfile(path.join(src, "sessions", "s1.jsonl"), "line1\nline2\n");
  await mkfile(path.join(src, "logs", "app.log"), "hello\n");
  await mkfile(path.join(src, ".hidden"), "dot\n");
  await mkfile(path.join(src, "storages", "db", "index.bin"), Buffer.alloc(300, 7));

  // external folder that a junction points to (must NOT end up in the archive)
  await mkfile(path.join(ext, "marker-outside.txt"), "outside-content\n");
  const linkAbs = path.join(src, "link-mirror");
  const jr = spawnSync("cmd", ["/c", "mklink", "/J", linkAbs, ext], { encoding: "utf8" });
  check("junction created", jr.status === 0, jr.stderr || jr.stdout);

  const { files, skippedLinks } = await enumerateFiles(src);
  check("enumerate counts real files only", files.length === 5, `got ${files.length}`);
  check("junction link skipped", skippedLinks >= 1, `skipped ${skippedLinks}`);
  check("no link-mirror entry in list", files.every((f) => !f.startsWith("link-mirror")), files.join(","));

  const svc = new BackupService({ sourceDir: src, backupsDir: bkp, keep: 3, timeoutMs: 60_000 });
  const r1 = await svc.run();
  check("run ok", r1.ok === true, JSON.stringify(r1));
  check("archive exists", existsSync(path.join(bkp, r1.file)));
  check("archive bytes > 0", r1.bytes > 0, String(r1.bytes));
  check("entries == 5", r1.entries === 5, String(r1.entries));

  // inspect the archive listing
  const listing = spawnSync("tar", ["-tf", path.join(bkp, r1.file)], { encoding: "utf8" });
  check("tar lists 5 files", listing.status === 0 && listing.stdout.trim().split(/\r?\n/).filter(Boolean).length === 5, listing.stdout);
  check("junction content excluded from archive", !listing.stdout.includes("marker-outside"), listing.stdout);
  check("real file present", listing.stdout.includes("sessions/s1.jsonl"), listing.stdout);

  // run 3 more times -> keep == 3
  await svc.run();
  await svc.run();
  const r4 = await svc.run();
  const kept = await svc.listBackups();
  check("prune keeps exactly 3", kept.length === 3, JSON.stringify(kept));
  check("4th run removed one older version", r4.removed.length === 1, JSON.stringify(r4.removed));
  check("newest file retained", kept.some((k) => k.file === r4.file), r4.file);

  // busy lock
  svc.busy = true;
  let busyErr = null;
  try {
    await svc.run();
  } catch (err) {
    busyErr = err;
  }
  svc.busy = false;
  check("busy lock throws code=busy", busyErr && busyErr.code === "busy", busyErr && busyErr.message);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

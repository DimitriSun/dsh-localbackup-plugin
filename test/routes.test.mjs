// Route-level self-test for the dsh-backup-plugin host entry, without a GUI.
// Drives apply() with a stubbed cordis ctx / webServer and real HTTP-like
// req/res objects, against a TEMPORARY USERPROFILE so the settings file
// (~/.dsh-backup.json) never touches the real user home.
// Run: node test/routes.test.mjs
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const here = path.dirname(fileURLToPath(import.meta.url));

// Isolate home dir BEFORE importing the plugin entry.
const sandbox = path.join(os.tmpdir(), `dbk-routes-test-${process.pid}`);
const fakeUserProfile = path.join(sandbox, "home");
process.env.USERPROFILE = fakeUserProfile;
// NOTE: this test process inherits the harness DSH_HOME, so the plugin's
// "default DSH home" resolves to the real one (resolveDshHome: DSH_HOME env
// first). Only the settings file (~/.dsh-backup.json via os.homedir) is
// isolated into the sandbox USERPROFILE.
const realDshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(fakeUserProfile, ".dsh");
await fsp.mkdir(path.join(fakeUserProfile, ".dsh"), { recursive: true });

const mod = await import("../lib/index.mjs");

let failures = 0;
function check(name, cond, extra) {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  -> " + extra : ""}`);
  if (!ok) failures += 1;
}

function makeRes() {
  let resolveFn;
  const settled = new Promise((resolve) => {
    resolveFn = resolve;
  });
  const res = {
    status: 200,
    body: "",
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.body = String(b);
      resolveFn(this);
    },
  };
  res.settled = settled;
  return res;
}

function jsonReq({ method = "GET", body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {
    host: "127.0.0.1:3080",
    origin: "http://127.0.0.1:3080",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

// ---- stubs ----
const routes = new Map();
const ws = {
  register(spec) {
    routes.set(spec.path, spec.handler);
    return () => routes.delete(spec.path);
  },
};
const ctx = {
  get(svc) {
    return svc === "webServer" ? ws : undefined;
  },
  inject(svcs, fn) {
    return fn({ webServer: ws });
  },
  effect() {},
};

// ---- run apply like the loader ----
mod.apply(ctx, {});

async function call(method, p, body) {
  const handler = routes.get(p);
  check(`route registered ${method} ${p}`, typeof handler === "function");
  const res = makeRes();
  await handler(jsonReq({ method, body }), res);
  await res.settled;
  return { status: res.status, body: JSON.parse(res.body) };
}

try {
  // GET settings (defaults)
  let r = await call("GET", "/dsh-backup/settings");
  check("GET settings 200", r.status === 200, String(r.status));
  check("default keep 3", r.body.effective && r.body.effective.keep === 3, JSON.stringify(r.body.effective));
  check(
    "default backupsDir sibling of DSH home",
    r.body.effective && r.body.effective.backupsDir === `${realDshHome}-backups`,
    JSON.stringify(r.body.effective),
  );

  // POST keep=7
  r = await call("POST", "/dsh-backup/settings", { keep: 7 });
  check("POST keep=7 -> 200", r.status === 200, String(r.status));
  check("effective keep now 7", r.body.effective.keep === 7, JSON.stringify(r.body.effective));
  const storedFile = r.body.settingsPath;
  const stored = JSON.parse(await fsp.readFile(storedFile, "utf8"));
  check("settings file persisted keep", stored.keep === 7, JSON.stringify(stored));

  // POST invalid keep 0 -> 400
  r = await call("POST", "/dsh-backup/settings", { keep: 0 });
  check("POST keep=0 rejected 400", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // POST backupsDir inside source -> 400 (source = real DSH home here)
  r = await call("POST", "/dsh-backup/settings", { backupsDir: path.join(realDshHome, "inside-source-test") });
  check("nested backupsDir rejected 400", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // POST valid backupsDir absolute
  const good = path.join(fakeUserProfile, "MyBackups");
  r = await call("POST", "/dsh-backup/settings", { backupsDir: good });
  check("POST backupsDir ok", r.status === 200 && r.body.effective.backupsDir === good, `${r.status} ${JSON.stringify(r.body.effective)}`);

  // POST relative backupsDir -> 400
  r = await call("POST", "/dsh-backup/settings", { backupsDir: "relative/path" });
  check("relative backupsDir rejected 400", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // clear keep (null) -> effective keep back to 3 (no patch)
  r = await call("POST", "/dsh-backup/settings", { keep: null });
  check("clear keep -> default 3", r.status === 200 && r.body.effective.keep === 3, JSON.stringify(r.body.effective));

  // GET state
  r = await call("GET", "/dsh-backup/state");
  check("GET state 200", r.status === 200, String(r.status));
  check("state exposes backups array", Array.isArray(r.body.backups), JSON.stringify(r.body).slice(0, 200));

  // fence: foreign host rejected
  const resF = makeRes();
  const reqF = jsonReq({ method: "GET" });
  reqF.headers.host = "10.0.0.5:3080";
  reqF.headers.origin = "http://10.0.0.5:3080";
  await routes.get("/dsh-backup/state")(reqF, resF);
  await resF.settled;
  check("fence blocks non-loopback", resF.status === 403, String(resF.status));
} finally {
  await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

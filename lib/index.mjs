// dsh-backup-plugin — host (node) face.
// Cordis bundle entry: exports { name, Config, apply }. Registers loopback-only
// HTTP routes on the dsh `webServer` seam:
//   POST /dsh-backup/run       -> run one backup
//   GET  /dsh-backup/state     -> enabled/busy/lastRun/versions/effective config
//   GET  /dsh-backup/settings  -> effective + stored + patch settings (UI)
//   POST /dsh-backup/settings  -> persist UI overrides (backupsDir / keep)
// Effective settings precedence: stored (~/.dsh-backup.json) > patch config > defaults.
import Schema from "@deepseek-ai/schemastery";
import os from "node:os";
import path from "node:path";
import { BackupService } from "./backup-service.mjs";
import {
  SETTINGS_FILENAME,
  effectiveSettingsSync,
  effectiveFrom,
  loadStored,
  writeStored,
  pickPatch,
} from "./settings-store.mjs";

export const name = "dsh-backup-plugin";

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description("是否启用插件"),
  sourceDir: Schema.string().description("要备份的目录；缺省为当前 DSH home"),
  backupsDir: Schema.string().description("备份库目录；缺省为 DSH home 同级 <home>-backups"),
  keep: Schema.number().default(3).min(1).description("保留版本数"),
  timeoutMs: Schema.number().default(120_000).description("单次打包超时（ms）"),
});

const ROUTE_BASE = "/dsh-backup";

/** Resolve the DSH home the same way @deepseek-ai/dsh-home-paths does. */
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim()) return env.trim();
  return path.join(os.homedir(), ".dsh");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Cross-site fence (loopback-only, same as bsk plugin's observation routes). */
function fenceViolation(req) {
  const host = req.headers.host ?? "";
  const hostname = /^\[.*\](?::\d+)?$/.test(host)
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  if (
    !(
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    )
  ) {
    return "host is not a loopback authority";
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "unparseable Origin header";
    }
    if (originHost !== host) return "Origin does not match Host";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "sec-fetch-site: cross-site";
  if (req.method === "POST") {
    const ct = req.headers["content-type"] ?? "";
    if (!/^\s*application\/json\s*(;|$)/.test(ct)) return "POST requires an application/json body";
  }
  return undefined;
}

function fenceRejected(req, res) {
  const violation = fenceViolation(req);
  if (violation === undefined) return false;
  console.warn(
    `[dsh-backup] fence rejected ${req.method} ${req.url}: ${violation}` +
      ` (host=${req.headers.host ?? "-"} origin=${req.headers.origin ?? "-"}` +
      ` sec-fetch-site=${req.headers["sec-fetch-site"] ?? "-"})`,
  );
  sendJson(res, 403, { ok: false, error: { code: "forbidden", message: violation } });
  return true;
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const codeToStatus = {
  busy: 409,
  "source-missing": 422,
  forbidden: 403,
  "bad-request": 400,
};

function respondError(res, err) {
  const code = err && typeof err === "object" && err.code ? err.code : "io";
  const message = err && err.message ? err.message : String(err);
  const status = codeToStatus[code] ?? 500;
  sendJson(res, status, { ok: false, error: { code, message } });
}

/** Validation guard shared by both settings routes: reject nested backups dir. */
function assertDirAllowed(sourceDir, candidateDir) {
  const rel = path.relative(sourceDir, candidateDir);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    const err = new Error(`backupsDir must NOT be inside sourceDir (${sourceDir})`);
    err.code = "bad-request";
    throw err;
  }
}

/**
 * Register the backup + settings routes.
 * @param ctx
 * @param {BackupService} service
 * @param {{home:string, sourceDir:string, timeoutMs:number, settingsFile:string, patchCfg:object}} env
 * @returns disposer that unregisters the routes.
 */
function registerRoutes(ctx, service, env) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return () => {};

  /** Fresh effective view (re-reads the stored file) for state/settings responses. */
  const view = async () => {
    const stored = await loadStored(env.settingsFile);
    const eff = effectiveFrom({
      home: env.home,
      settingsFile: env.settingsFile,
      patch: env.patchCfg,
      stored,
    });
    return {
      ok: true,
      enabled: service.enabled,
      configWarning: service.configWarning ?? null,
      settingsPath: env.settingsFile,
      stored,
      patch: pickPatch(env.patchCfg),
      effective: {
        sourceDir: service.sourceDir,
        backupsDir: service.backupsDir,
        keep: service.keep,
        timeoutMs: env.timeoutMs,
      },
    };
  };

  const disposers = [
    webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/run`,
      handler: async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "method", message: "method not allowed" } });
        if (fenceRejected(req, res)) return;
        try {
          await readJsonBody(req); // consume & tolerate an optional {} body
          if (service.enabled === false) {
            return sendJson(res, 403, { ok: false, error: { code: "disabled", message: "plugin disabled by config" } });
          }
          const result = await service.run();
          sendJson(res, 200, result);
        } catch (err) {
          respondError(res, err);
        }
      },
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/state`,
      handler: async (req, res) => {
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: { code: "method", message: "method not allowed" } });
        if (fenceRejected(req, res)) return;
        try {
          const backups = await service.listBackups();
          const base = await view();
          sendJson(res, 200, {
            ...base,
            busy: service.busy,
            lastRun: service.lastRun,
            backups: backups.map((b) => ({ file: b.file, size: b.size, mtime: new Date(b.mtime).toISOString() })),
          });
        } catch (err) {
          respondError(res, err);
        }
      },
    }),
    webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/settings`,
      handler: async (req, res) => {
        if (fenceRejected(req, res)) return;
        if (req.method === "GET") {
          try {
            sendJson(res, 200, await view());
          } catch (err) {
            respondError(res, err);
          }
          return;
        }
        if (req.method === "POST") {
          try {
            if (service.busy) return sendJson(res, 409, { ok: false, error: { code: "busy", message: "a backup is running; wait for it to finish" } });
            const body = await readJsonBody(req);
            const storedBefore = await loadStored(env.settingsFile);

            // Build the prospective stored overrides; validate before persisting.
            const prospective = { ...storedBefore };
            if (Object.prototype.hasOwnProperty.call(body, "backupsDir")) {
              const v = typeof body.backupsDir === "string" ? body.backupsDir.trim() : "";
              if (v) {
                if (!path.isAbsolute(v)) {
                  const err = new Error("backupsDir must be an absolute path");
                  err.code = "bad-request";
                  throw err;
                }
                assertDirAllowed(service.sourceDir, path.resolve(v));
                prospective.backupsDir = path.resolve(v);
              } else {
                delete prospective.backupsDir; // clear -> fall back to patch/default
              }
            }
            if (Object.prototype.hasOwnProperty.call(body, "keep")) {
              if (body.keep === null || body.keep === undefined || body.keep === "") {
                delete prospective.keep; // clear -> default 3 / patch value
              } else {
                const n = typeof body.keep === "number" ? body.keep : Number(body.keep);
                if (!Number.isInteger(n) || n < 1 || n > 999) {
                  const err = new Error("keep must be an integer between 1 and 999");
                  err.code = "bad-request";
                  throw err;
                }
                prospective.keep = n;
              }
            }

            await writeStored(env.settingsFile, prospective);
            // Hot-apply the new effective state to the live service.
            const eff = effectiveFrom({
              home: env.home,
              settingsFile: env.settingsFile,
              patch: env.patchCfg,
              stored: prospective,
            });
            service.applyRuntime({ backupsDir: eff.backupsDir, keep: eff.keep });
            sendJson(res, 200, await view());
          } catch (err) {
            respondError(res, err);
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: { code: "method", message: "method not allowed" } });
      },
    }),
  ];
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}

export function apply(ctx, config = {}, options = {}) {
  const enabled = config.enabled !== false;
  const home = resolveDshHome();
  const sourceDir = path.resolve(config.sourceDir || home);
  const timeoutMs = config.timeoutMs ?? 120_000;
  const settingsFile = path.join(os.homedir(), SETTINGS_FILENAME);

  const eff = effectiveSettingsSync({ home, settingsFile, patch: config });
  const service = new BackupService({
    sourceDir,
    backupsDir: eff.backupsDir,
    keep: eff.keep,
    timeoutMs,
  });
  service.enabled = enabled;
  // NOTE: configWarning is computed inside BackupService (recomputeWarning).

  let removeRoutes = () => {};
  ctx.inject(["webServer"], (injected) => {
    removeRoutes = registerRoutes(ctx, service, {
      home,
      sourceDir,
      timeoutMs,
      settingsFile,
      patchCfg: config,
    });
    return () => removeRoutes();
  });

  ctx.effect(() => () => {
    removeRoutes();
    service.dispose();
  });

  console.log(
    `[dsh-backup] ${enabled ? "ready" : "disabled"} source=${service.sourceDir} backups=${service.backupsDir} keep=${service.keep}` +
      ` settings=${settingsFile}` +
      (service.configWarning ? ` WARNING: ${service.configWarning}` : ""),
  );
}

// dsh-backup-plugin — runtime settings store (pure Node, no external deps).
// The web Settings menu writes UI-level overrides (backupsDir / keep) through
// the plugin's own HTTP routes into a small JSON file OUTSIDE the DSH home
// (default: ~/.dsh-backup.json). Precedence for the effective value is:
//   stored (this file)  >  profile patch config  >  built-in defaults.
// An empty string / null stored value means "not set" (fall back to the next
// layer), which lets the UI offer a one-click reset to default.
import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";

export const SETTINGS_FILENAME = ".dsh-backup.json";
export const DEFAULT_KEEP = 3;

function parse(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return {};
}

/** @returns {Promise<Record<string, unknown>>} current stored overrides ({} when missing). */
export async function loadStored(file) {
  try {
    return parse(JSON.parse(await fsp.readFile(file, "utf8")));
  } catch {
    return {};
  }
}

/** Synchronous variant (used during the sync plugin apply()). */
export function loadStoredSync(file) {
  try {
    return parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

/** Atomic write of the stored overrides object. */
export async function writeStored(file, stored) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(stored, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

/** Strip only the keys this plugin manages from a raw patch config object. */
export function pickPatch(config) {
  const out = {};
  if (config && typeof config === "object") {
    if (typeof config.backupsDir === "string" && config.backupsDir.trim()) {
      out.backupsDir = config.backupsDir.trim();
    }
    if (Number.isInteger(config.keep)) out.keep = config.keep;
  }
  return out;
}

/**
 * Compute the effective resolved settings from stored + patch layers.
 * @returns {{backupsDir:string, keep:number, stored:object, patch:object, settingsPath:string}}
 */
export function effectiveFrom({ home, settingsFile, patch, stored }) {
  const patched = pickPatch(patch);
  const storedBkp = typeof stored.backupsDir === "string" ? stored.backupsDir.trim() : "";
  const patchBkp = typeof patched.backupsDir === "string" ? patched.backupsDir : "";
  const storedKeep = Number.isInteger(stored.keep) ? stored.keep : NaN;
  const patchKeep = Number.isInteger(patched.keep) ? patched.keep : NaN;
  return {
    backupsDir: path.resolve(storedBkp || patchBkp || `${home}-backups`),
    keep: Number.isInteger(storedKeep) ? storedKeep : Number.isInteger(patchKeep) ? patchKeep : DEFAULT_KEEP,
    stored,
    patch: patched,
    settingsPath: settingsFile,
  };
}

/** Sync shorthand used at plugin boot. */
export function effectiveSettingsSync({ home, settingsFile, patch }) {
  return effectiveFrom({ home, settingsFile, patch, stored: loadStoredSync(settingsFile) });
}

/**
 * Persist one UI update into the stored overrides file.
 * Semantics (validated by caller): a present key with value "" / null / undefined
 * clears that key (revert to patch/default); otherwise the value is kept verbatim.
 * @param {string} file
 * @param {{backupsDir?: unknown, keep?: unknown}} body
 * @returns {Promise<Record<string, unknown>>} the updated stored object
 */
export async function updateStored(file, body) {
  const stored = await loadStored(file);
  if (Object.prototype.hasOwnProperty.call(body, "backupsDir")) {
    const v = typeof body.backupsDir === "string" ? body.backupsDir.trim() : "";
    if (v) stored.backupsDir = v;
    else delete stored.backupsDir;
  }
  if (Object.prototype.hasOwnProperty.call(body, "keep")) {
    if (body.keep === null || body.keep === undefined || body.keep === "" ) delete stored.keep;
    else {
      const n = typeof body.keep === "number" ? body.keep : Number(body.keep);
      if (Number.isInteger(n)) stored.keep = n;
      else delete stored.keep;
    }
  }
  await writeStored(file, stored);
  return stored;
}

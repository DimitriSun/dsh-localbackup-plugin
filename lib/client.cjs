/* dsh-backup-plugin v0.2 — web (client) face.
 * Loaded through the dsh client module loader.
 *  - session-header action "Backup" (conversation.session.header.actions)
 *  - two preference rows in Settings -> General (settings.general.item)
 *
 * UI source-of-truth rules:
 *  - header backup action: v0.1 scheme (self-contained 28x28 icon button).
 *  - settings rows: native — chrome copied verbatim from the built-in
 *    AppearanceRow (theme plugin); controls are the shared native atoms
 *    Button (variant outline) / Input from
 *    @deepseek-ai/dsh-client-ui-primitives.
 *  - localization identical to built-ins: ctx.locale.register + `t` props.
 *
 * Transport robustness (dsh 0.1.5): plugin fibers can have their in-flight
 * requests aborted during app boot/HMR reconciliation (observed for several
 * third-party plugins). So every call here goes through `requestJson`, which
 * uses a manual AbortController (never AbortSignal.timeout), retries network
 * aborts with backoff, logs diagnostics to the console, and — for the long
 * running backup — confirms completion by polling /state instead of trusting
 * a single POST. The backup POST itself gets a 30-minute budget because a
 * full snapshot can legitimately take a while on a busy machine.
 */
window.__ModuleLoader__.load({
  id: "dsh-backup-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const Button = primitives && primitives.Button;
    const Input = primitives && primitives.Input;

    const inject = ["slots", "locale"];

    const NS = "dsh-backup";
    const ROUTE_RUN = "/dsh-backup/run";
    const ROUTE_STATE = "/dsh-backup/state";
    const ROUTE_SETTINGS = "/dsh-backup/settings";

    const RUN_TIMEOUT_MS = 30 * 60 * 1000; // a full snapshot may take minutes
    const POLL_INTERVAL_MS = 1500;

    /* ------------------------------------------------------------------ */
    /* Dictionaries (flat dotted keys, mirroring built-in plugins)         */
    /* ------------------------------------------------------------------ */
    const zh = {
      "action.idle": "备份",
      "action.running": "正在备份…",
      "action.done": "备份完成：{file}（{size}）",
      "action.fail": "备份失败：{message}",
      "dir.title": "备份保存目录",
      "dir.save": "保存",
      "dir.saving": "保存中…",
      "dir.saved": "已保存（立即生效）",
      "dir.saveFail": "保存失败：{message}",
      "dir.hintAbs": "请输入绝对路径（留空恢复默认）",
      "dir.placeholder": "留空 = 恢复默认",
      "keep.title": "保留备份份数",
      "keep.hint": "1–999 的整数，默认 3；清空恢复默认",
      "keep.bad": "份数需为 1–999 的整数",
      "src.stored": "自定义 · 存于 ~/.dsh-backup.json",
      "src.patch": "来自 profile 配置覆盖",
      "src.default": "默认值",
      "load.retrying": "读取设置失败，正在重试…",
    };

    const en = {
      "action.idle": "Backup",
      "action.running": "Backing up…",
      "action.done": "Backup finished: {file} ({size})",
      "action.fail": "Backup failed: {message}",
      "dir.title": "Backup directory",
      "dir.save": "Save",
      "dir.saving": "Saving…",
      "dir.saved": "Saved (applied now)",
      "dir.saveFail": "Save failed: {message}",
      "dir.hintAbs": "Enter an absolute path (leave empty for default)",
      "dir.placeholder": "Leave empty to reset to default",
      "keep.title": "Backups to keep",
      "keep.hint": "Integer 1–999, default 3; clear to reset",
      "keep.bad": "Keep must be an integer 1–999",
      "src.stored": "Custom · stored in ~/.dsh-backup.json",
      "src.patch": "From profile config override",
      "src.default": "Default",
      "load.retrying": "Couldn't load settings — retrying…",
    };

    const ZHLIKE = typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language || "");

    function interpolate(text, params) {
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, (_, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
      );
    }

    function makeT(dict, isZh) {
      return (key, params) => {
        const raw = dict[key] ?? (isZh ? zh[key] : en[key]) ?? key;
        return interpolate(raw, params);
      };
    }

    function resolveT(props) {
      if (props && typeof props.t === "function") return props.t;
      return makeT(ZHLIKE ? zh : en, ZHLIKE);
    }

    /* ------------------------------------------------------------------ */
    /* Styles (v0.1 header button + native settings-row chrome)            */
    /* ------------------------------------------------------------------ */
    const CSS_ID = "dsh-backup-plugin/styles.css";
    const CSS = [
      /* header backup action — v0.1 scheme (kept per user review) */
      ".dbp-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);cursor:pointer;border-radius:6px}",
      ".dbp-action:hover{background:color-mix(in srgb,currentColor 10%,transparent);color:var(--dsw-alias-label-secondary,currentColor)}",
      ".dbp-action:disabled{cursor:default;opacity:.55}",
      ".dbp-action svg{display:block}",
      ".dbp-action[data-state=error]{color:#d64541}",
      ".dbp-action[data-state=ok]{color:#1f9d55}",
      ".dbp-spin{animation:dbpSpin .9s linear infinite}",
      "@keyframes dbpSpin{to{transform:rotate(360deg)}}",
      /* settings row — verbatim AppearanceRow.group / .title */
      ".dbp-row{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}",
      ".dbp-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
      ".dbp-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;min-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dbp-meta[data-state=error]{color:var(--dsw-alias-label-error)}",
      ".dbp-meta[data-state=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".dbp-controls{align-items:center;gap:8px;min-width:0;display:flex}",
    ].join("");

    function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-backup-plugin";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* Backup action glyph (v0.1 scheme — kept per user review). */
    function BackupGlyph({ className }) {
      return React.createElement(
        "svg",
        {
          className,
          width: 17,
          height: 17,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.9,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        React.createElement("path", { d: "M3 10.5V19a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 19v-8.5" }),
        React.createElement("path", { d: "M12 3.5v9" }),
        React.createElement("path", { d: "M8 7.5l4-4 4 4" }),
        React.createElement("path", { d: "M3 10.5h18" }),
      );
    }
    const BackupGlyphMemo = BackupGlyph;

    function fmtBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
      return bytes > 1024 * 1024
        ? (bytes / (1024 * 1024)).toFixed(1) + " MB"
        : Math.max(1, Math.round(bytes / 1024)) + " KB";
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Loopback JSON request with a manual AbortController and bounded retries.
     * HTTP errors (a real response) are never retried; network aborts/timeouts
     * are, because the shell can cancel plugin requests during boot/HMR.
     */
    async function requestJson(url, opts = {}) {
      const {
        method = "GET",
        body,
        timeoutMs = 8000,
        attempts = 4,
        delays = [250, 800, 2000],
      } = opts;
      let lastErr;
      for (let i = 0; i < attempts; i += 1) {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
          const res = await fetch(url, {
            method,
            headers: body !== undefined ? { "content-type": "application/json" } : undefined,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller ? controller.signal : undefined,
          });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data || data.ok !== true) {
            const message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
            const err = new Error(message);
            err.status = res.status;
            err.code = data && data.error && data.error.code;
            throw err;
          }
          return data;
        } catch (err) {
          lastErr = err;
          const hasStatus = Boolean(err && err.status);
          if (typeof console !== "undefined" && console.warn) {
            console.warn(
              "[dsh-backup] request failed:",
              method,
              url,
              err && err.name,
              err && err.message,
              `(attempt ${i + 1}/${attempts})`,
            );
          }
          if (hasStatus || i === attempts - 1) break;
          await sleep(delays[Math.min(i, delays.length - 1)]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw lastErr;
    }

    /**
     * Wait for the run that was (or may have been) started around `startedAt`.
     * Used when the POST is refused as busy or torn down mid-flight: the host
     * keeps working, so completion is confirmed through /state.
     */
    async function waitForRun(startedAt, attempts = 1200) {
      let sawBusy = false;
      for (let i = 0; i < attempts; i += 1) {
        let state = null;
        try {
          state = await requestJson(ROUTE_STATE, { timeoutMs: 6000, attempts: 2, delays: [400] });
        } catch {
          /* keep polling through transient failures */
        }
        if (state) {
          if (state.busy) sawBusy = true;
          const finished = state.lastRun && Date.parse(state.lastRun.finishedAt || 0);
          if (!state.busy && finished && finished >= startedAt - 2000) return state.lastRun;
          if (!state.busy && !sawBusy && Date.now() > startedAt + 8000) {
            throw new Error("backup request was interrupted before the host started");
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error("timed out waiting for the backup to finish");
    }

    /* ------------------------------------------------------------------ */
    /* Header backup action                                                */
    /* ------------------------------------------------------------------ */
    function BackupAction(props) {
      injectCss();
      const t = resolveT(props);
      const [phase, setPhase] = useState("idle"); // idle | running | ok | error
      const [note, setNote] = useState(null); // {file,bytes}
      const [message, setMessage] = useState("");

      useEffect(() => {
        let alive = true;
        requestJson(ROUTE_STATE, { timeoutMs: 6000, attempts: 5 })
          .then((state) => {
            if (alive && state.lastRun) setNote({ file: state.lastRun.file, bytes: state.lastRun.bytes });
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const run = useCallback(async () => {
        setPhase("running");
        setMessage("");
        const startedAt = Date.now();
        try {
          let data;
          try {
            data = await requestJson(ROUTE_RUN, {
              method: "POST",
              body: {},
              timeoutMs: RUN_TIMEOUT_MS,
              attempts: 1,
            });
          } catch (err) {
            // 409 busy, or the request was torn down client-side while the host
            // kept working: fall back to polling the authoritative state.
            if ((err && err.status === 409) || !(err && err.status)) {
              data = await waitForRun(startedAt);
            } else {
              throw err;
            }
          }
          if (data && data.ok === false) {
            throw new Error((data.error && data.error.message) || "backup failed");
          }
          setNote({ file: data.file, bytes: data.bytes });
          setPhase("ok");
          setMessage(t("action.done", { file: data.file, size: fmtBytes(data.bytes) }));
          setTimeout(() => setPhase((p) => (p === "ok" ? "idle" : p)), 2600);
        } catch (err) {
          setPhase("error");
          setMessage(t("action.fail", { message: err && err.message ? err.message : String(err) }));
          setTimeout(() => setPhase((p) => (p === "error" ? "idle" : p)), 6000);
        }
      }, [t]);

      const busy = phase === "running";
      const title =
        phase === "running"
          ? t("action.running")
          : message && (phase === "error" || phase === "ok")
            ? message
            : note
              ? `${t("action.idle")} · ${t("action.done", { file: note.file, size: fmtBytes(note.bytes) })}`
              : t("action.idle");

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dbp-action" + (busy ? " dbp-spin" : ""),
          "data-state": phase === "error" ? "error" : phase === "ok" ? "ok" : undefined,
          title,
          "aria-label": title,
          disabled: busy,
          onClick: busy ? undefined : run,
        },
        React.createElement(BackupGlyphMemo),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Settings rows (Settings -> General; chrome mirrors AppearanceRow)   */
    /* ------------------------------------------------------------------ */
    function sourceCaption(t, res, hasStored, hasPatch) {
      if (hasStored) return t("src.stored");
      if (hasPatch) return t("src.patch");
      return t("src.default");
    }

    /**
     * Load the effective settings with self-healing retries: if the shell
     * cancels the request (boot/HMR), keep trying a bounded number of rounds
     * instead of leaving the rows silently empty.
     */
    function useBackupSettings() {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const rounds = useRef(0);
      const aliveRef = useRef(true);

      const load = useCallback(async () => {
        try {
          const data = await requestJson(ROUTE_SETTINGS, {
            timeoutMs: 6000,
            attempts: 3,
            delays: [300, 900],
          });
          if (!aliveRef.current) return;
          rounds.current = 0;
          setState({ loading: false, data, error: null });
        } catch (err) {
          if (!aliveRef.current) return;
          rounds.current += 1;
          setState({ loading: false, data: null, error: err });
          if (rounds.current <= 6) setTimeout(load, 5000);
        }
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        load();
        return () => {
          aliveRef.current = false;
        };
      }, [load]);

      return state;
    }

    function SettingsDirRow(props) {
      injectCss();
      const t = resolveT(props);
      const [value, setValue] = useState("");
      const [status, setStatus] = useState("idle"); // idle | saving | ok | error
      const [meta, setMeta] = useState("");
      const settings = useBackupSettings();

      useEffect(() => {
        if (settings.data) {
          setValue(settings.data.effective.backupsDir);
          setStatus((s) => (s === "saving" ? s : "idle"));
          setMeta(
            sourceCaption(
              t,
              settings.data,
              settings.data.stored &&
                typeof settings.data.stored.backupsDir === "string" &&
                settings.data.stored.backupsDir,
              settings.data.patch && typeof settings.data.patch.backupsDir === "string",
            ),
          );
        } else if (settings.error) {
          setStatus("error");
          setMeta(t("load.retrying"));
        }
      }, [settings, t]);

      const save = useCallback(async () => {
        const raw = value.trim();
        if (raw && !/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(raw)) {
          setStatus("error");
          setMeta(t("dir.hintAbs"));
          return;
        }
        setStatus("saving");
        setMeta(t("dir.saving"));
        try {
          const res = await requestJson(ROUTE_SETTINGS, {
            method: "POST",
            body: { backupsDir: raw },
            timeoutMs: 15000,
            attempts: 3,
            delays: [300, 900],
          });
          setStatus("ok");
          setMeta(
            `${t("dir.saved")} · ${sourceCaption(
              t,
              res,
              res.stored && typeof res.stored.backupsDir === "string" && res.stored.backupsDir,
              res.patch && typeof res.patch.backupsDir === "string",
            )}`,
          );
        } catch (err) {
          setStatus("error");
          setMeta(t("dir.saveFail", { message: err && err.message ? err.message : String(err) }));
        }
      }, [value, t]);

      return React.createElement(
        "div",
        { className: "dbp-row" },
        React.createElement("div", { className: "dbp-title" }, t("dir.title")),
        React.createElement(
          "div",
          { className: "dbp-controls" },
          Input
            ? React.createElement(Input, {
                type: "text",
                spellCheck: false,
                value,
                disabled: status === "saving",
                placeholder: t("dir.placeholder"),
                style: { flex: "1 1 auto", minWidth: 0 },
                onChange: (e) => {
                  setValue(e.target.value);
                  if (status === "ok" || status === "error") setStatus("idle");
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter") save();
                },
              })
            : React.createElement("input", {
                type: "text",
                value,
                onChange: (e) => setValue(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") save();
                },
              }),
          Button
            ? React.createElement(
                Button,
                {
                  variant: "outline",
                  disabled: status === "saving",
                  onClick: save,
                },
                t("dir.save"),
              )
            : React.createElement("button", { type: "button", onClick: save }, t("dir.save")),
        ),
        React.createElement("div", { className: "dbp-meta", "data-state": status }, meta),
      );
    }

    function SettingsKeepRow(props) {
      injectCss();
      const t = resolveT(props);
      const [value, setValue] = useState("");
      const [status, setStatus] = useState("idle");
      const [meta, setMeta] = useState("");
      const settings = useBackupSettings();

      useEffect(() => {
        if (settings.data) {
          setValue(String(settings.data.effective.keep));
          setStatus((s) => (s === "saving" ? s : "idle"));
          setMeta(
            sourceCaption(
              t,
              settings.data,
              settings.data.stored && Number.isInteger(settings.data.stored.keep),
              settings.data.patch && Number.isInteger(settings.data.patch.keep),
            ),
          );
        } else if (settings.error) {
          setStatus("error");
          setMeta(t("load.retrying"));
        }
      }, [settings, t]);

      const save = useCallback(async () => {
        const raw = value.trim();
        if (raw !== "" && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 999)) {
          setStatus("error");
          setMeta(t("keep.bad"));
          return;
        }
        setStatus("saving");
        setMeta(t("dir.saving"));
        try {
          const res = await requestJson(ROUTE_SETTINGS, {
            method: "POST",
            body: { keep: raw === "" ? null : Number(raw) },
            timeoutMs: 15000,
            attempts: 3,
            delays: [300, 900],
          });
          setValue(String(res.effective.keep));
          setStatus("ok");
          setMeta(
            `${t("dir.saved")} · ${sourceCaption(
              t,
              res,
              res.stored && Number.isInteger(res.stored.keep),
              res.patch && Number.isInteger(res.patch.keep),
            )}`,
          );
        } catch (err) {
          setStatus("error");
          setMeta(t("dir.saveFail", { message: err && err.message ? err.message : String(err) }));
        }
      }, [value, t]);

      return React.createElement(
        "div",
        { className: "dbp-row" },
        React.createElement("div", { className: "dbp-title" }, t("keep.title")),
        React.createElement(
          "div",
          { className: "dbp-controls" },
          Input
            ? React.createElement(Input, {
                type: "number",
                min: 1,
                max: 999,
                value,
                disabled: status === "saving",
                placeholder: "3",
                style: { flex: "1 1 auto", minWidth: 0 },
                onChange: (e) => {
                  setValue(e.target.value);
                  if (status === "ok" || status === "error") setStatus("idle");
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter") save();
                },
              })
            : React.createElement("input", {
                type: "number",
                value,
                onChange: (e) => setValue(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") save();
                },
              }),
          Button
            ? React.createElement(
                Button,
                {
                  variant: "outline",
                  disabled: status === "saving",
                  onClick: save,
                },
                t("dir.save"),
              )
            : React.createElement("button", { type: "button", onClick: save }, t("dir.save")),
        ),
        React.createElement("div", { className: "dbp-meta", "data-state": status }, meta || t("keep.hint")),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Client plugin body                                                  */
    /* ------------------------------------------------------------------ */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-backup: dictionaries");
      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register(
          { name: "conversation.session.header.actions", id: "dsh-backup", order: 30, locale: NS },
          BackupAction,
        ),
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          { name: "settings.general.item", id: "dsh-backup.dir", order: 40, locale: NS },
          SettingsDirRow,
        ),
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          { name: "settings.general.item", id: "dsh-backup.keep", order: 41, locale: NS },
          SettingsKeepRow,
        ),
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});

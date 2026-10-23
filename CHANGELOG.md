# Changelog / 更新记录

English | [简体中文](#中文)

## v0.2.3 — 2026-10-23

**Fixed: one unreadable member no longer fails the whole backup.**

- A member whose path contains non-ASCII characters (a Chinese file name, for example) could not be archived through bsdtar's `-T` list: bsdtar reads that list in the active ANSI code page, so it could not resolve the name and reported the parent directory as unvisitable. Those members now travel as command-line operands and are archived with their names intact.
- A member another process holds open — a plugin's live SQLite database, for example — was refused by bsdtar with "Permission denied" (on Windows a sharing violation, because bsdtar opens with read-only sharing). It is now copied through Node's permissive open and appended to the same archive, and reported as `liveCopies`.
- A member that disappears between listing and archiving is skipped and reported instead of failing the run; `File changed as we read it` is a warning, not a failure.
- The archive is now written in up to five passes, resolving each round's failures, and fails only when a round makes no progress.
- The run result reports `rounds`, `liveCopies`, `skipped`, `skippedCount` and `unstable`; `GET /dsh-backup/state` also reports `lastError`.
- Added `test/archive.test.mjs` covering the failure classification, the member split, and both real-world cases.

## v0.2.2 — 2026-09-30

**Declared the supported DSH versions.**

- `peerDependencies` on `@deepseek-ai/dsh` (`>=0.1.5-rc.2 <0.3.0-0`) and the same range under `engines.dsh`, so dsh 0.2.0 and later refuse the plugin instead of activating it against a harness it was not built for. The `<0.3.0-0` upper bound is deliberate: dsh matches ranges with prereleases included, so `<0.3.0` would still admit `0.3.0-rc.1`.

## v0.2.1 — 2026-09-10

**Client robustness against shell boot and HMR aborts.**

- Every request uses a manual `AbortController` with bounded retry; HTTP errors are never retried.
- The long-running backup is confirmed by polling `/dsh-backup/state` instead of trusting a single POST, with a 30-minute budget.

## v0.2.0 — 2026-09-08

**Frontend settings.**

- Backup directory and retained-version count are editable in **dsh Settings → General**; overrides live in `~/.dsh-backup.json`.
- Header **Backup** action from v0.1, settings rows in native chrome.

---

## 中文

## v0.2.3 — 2026-10-23

**修复：单个文件读不到不再让整次备份失败。**

- 路径里带非 ASCII 字符（比如中文文件名）的成员，之前没法通过 bsdtar 的 `-T` 清单归档：bsdtar 按当前 ANSI 代码页读清单，解析不到名字，就把它所在的目录报成「无法访问」。现在这类成员改走命令行参数，文件名原样归档。
- 被别的进程占着的成员（比如插件正在用的 SQLite 数据库），之前被 bsdtar 拒绝并报 "Permission denied"（Windows 上的共享冲突：bsdtar 打开文件时只声明共享读）。现在会先用 Node 的宽松打开方式复制一份，再追加进同一个包，并在结果里记为 `liveCopies`。
- 列清单之后消失的成员会被跳过并记录，不再让整次备份失败；`File changed as we read it` 只当警告。
- 归档最多分五轮完成，每轮处理上一轮失败的成员；只有某一轮毫无进展才真正报错。
- 结果新增 `rounds`、`liveCopies`、`skipped`、`skippedCount`、`unstable`；`GET /dsh-backup/state` 新增 `lastError`。
- 新增 `test/archive.test.mjs`，覆盖失败分类、成员拆分以及上面两种真实场景。

## v0.2.2 — 2026-09-30

**声明支持的 DSH 版本。**

- 在 `peerDependencies` 与 `engines.dsh` 里声明 `>=0.1.5-rc.2 <0.3.0-0`：dsh 0.2.0 起会直接拒绝加载不匹配的插件，而不是让它跑在不认识的 harness 上。上界写 `<0.3.0-0` 而不是 `<0.3.0` 是故意的：dsh 匹配范围时把预发布版也算在内，`<0.3.0` 会连 `0.3.0-rc.1` 一起放进来。

## v0.2.1 — 2026-09-10

**针对 shell 启动与 HMR 中断的客户端加固。**

- 所有请求都用手动 `AbortController` + 有界重试；HTTP 错误绝不重试。
- 长时间的备份改成轮询 `/dsh-backup/state` 确认完成，不再依赖单次 POST，预算 30 分钟。

## v0.2.0 — 2026-09-08

**前端设置。**

- 备份目录与保留份数在 **dsh 设置 → 通用** 里改，覆盖值存在 `~/.dsh-backup.json`。
- 顶部「备份」按钮沿用 v0.1 方案，设置行用原生外观。

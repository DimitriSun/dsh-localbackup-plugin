> 本文件是原 README 的详细介绍版（含配置写法、已知边界、开发与自测），
> 仓库主页 README 已替换为面向 GitHub 访客的简版，详见根目录 [README.md](../README.md)。

# dsh-backup-plugin

个人用 dsh 备份插件：在 Web 页面会话头部放一个「备份」按钮，点击后把 **DSH home**（`$DSH_HOME`，默认 `~/.dsh`）的**真实文件**打成单个**无压缩 `.tar`** 快照，存入本地备份库，备份库只保留最近 **N**（默认 3）个版本。

- **v0.2**：新增前端设置——左下角「设置 → 通用」里可直接改**备份保存目录**与**保留份数**（存于 `~/.dsh-backup.json`，保存即生效）。
- **本地化**：简体中文 / English 双语，走 dsh 原生 `ctx.locale` 机制（`dsh-backup` 命名空间），语言自动跟随界面语言并即时切换，无需任何设置。
- **视觉一致性（原生化）**：不再自绘控件——按钮/输入框直接使用 dsh 运行时共享原生原子（`@deepseek-ai/dsh-client-ui-primitives` 的 `Button`/`Input`/`IconArchiveOutline20`）；布局样式逐字照搬内置实现的真实规则（头部按钮 = Jobs 的 trigger，设置行 = 主题 AppearanceRow 的行分隔/留白/字号/行高），颜色只用 `--dsw-alias-*` 设计 token；字体继承原生，无第三方 UI/图标库。
- 仅供个人使用，不发布 npm。

## 特性

- 一键备份：会话页头部动作区新增按钮（与 Jobs / Schedule 同行），点击即备份。
- 前端设置：设置菜单 → 通用，两行：**备份保存目录**（留空恢复默认）、**保留备份份数**（1–999，默认 3）。
- 速度快：只归档真实文件，**跳过 junction / 符号链接**（`.dsh/profiles/node_modules` 是 dsh 运行时依赖镜像，含大量 junction；跟随会把整个运行时依赖树卷进来，体积/耗时翻 2~3 倍）。本机实测：全量 9,718 文件 ≈ **123 MB / 3 秒**。
- 无压缩 tar：产物 ≈ 源体积；用 7-Zip 或 `tar -xf` 打开。
- 保留策略：默认最近 3 份，超出自动删旧（`keep` 可配）。
- 卸载逃生：安装遵循标准 bundle 机制，可用 `dsh plugin remove` 干净卸载（不加载插件代码，dsh 起不来时也能卸）。

## 安装

```sh
# 把插件目录指给 dsh（以解压到用户目录 ~\dsh-backup-plugin 为例）
npx @deepseek-ai/dsh plugin --profile web add ~\dsh-backup-plugin

# 重启 dsh web 生效
dsh web
```

重启后：页面会话头部出现「备份」按钮；左下角设置 → 通用出现两行备份设置；host 注册 `POST/GET /dsh-backup/*`（仅 loopback，带 Origin/fence 护栏）。

## 配置（两种方式）

### 方式一（推荐）：前端设置

左下角「设置 → 通用」修改，点「保存」后**立即生效**（改动写入 `~/.dsh-backup.json`，由插件自动生成）：

```json
// ~/.dsh-backup.json（示例）
{ "backupsDir": "D:\\dsh-backups", "keep": 5 }
```

- **保存目录留空 + 保存** = 恢复默认（DSH home 同级 `<home>-backups`）。
- **份数输入清空 + 保存** = 恢复默认 3。
- 服务端校验：目录必须是**绝对路径**且**不得位于 `.dsh` 内部**；份数为 1–999 的整数。

### 方式二：profile 补丁（手动）

追加到 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-backup
  config:
    backupsDir: D:\dsh-backups
    keep: 5
```

### 生效优先级

**前端设置（`~/.dsh-backup.json`）> profile 补丁（`cordis.patch.yml`）> 内置默认**。
即：前端改过目录/份数后，补丁里的同名项不再生效；前端“留空/清空 + 保存”会删除对应自定义值，让位给补丁或默认。

> 注：`backupsDir` 若被配到 `sourceDir` 内部，`/dsh-backup/settings` 保存会被拒绝；若来自补丁无法改，`/dsh-backup/state` 会返回 `configWarning`。

## 卸载（逃生通道）

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-backup-plugin
dsh web   # 重启验证恢复
```

`dsh plugin` 只操作 profile 清单与 pnpm，**不加载插件代码**。卸载后如用过前端设置，`~/.dsh-backup.json` 可自行删除；备份库目录不会被卸载删除（属用户数据）。

## 已知边界

- 备份为“运行态快照”：若有会话正在写 JSONL / SQLite / 日志，个别文件可能捕获半写行；建议空闲时点击。
- junction / 符号链接目录只记录不跟随；恢复后 `profiles/*/node_modules` 需重新 `npx/pnpm install`。
- 产物为 `.tar`，Windows 资源管理器不能直接预览。
- 前端设置保存在 `~/.dsh-backup.json`（用户主目录），卸载插件不会自动删除它。
- UI 进度为“进行中（不定进度）”，无百分比。

## 开发

```sh
node test/core.test.mjs      # 核心自测：枚举跳过链接 / tar / 修剪 / 单飞锁
node test/routes.test.mjs    # 路由自测：/settings 读写校验 / /state / fence（沙箱化主目录）
```

- host 面：`lib/index.mjs` + `lib/backup-service.mjs` + `lib/settings-store.mjs`（纯 Node，无第三方归档依赖）
- web 面：`lib/client.cjs`（`window.__ModuleLoader__.load` 契约，手写，无需构建）

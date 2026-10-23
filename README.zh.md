# dsh-backup-plugin

[English](README.md) | **简体中文**

不到一个月我的 dsh 已经搞坏 3 次了，这个插件采用最简单最不绕弯子的方式直接备份整个 dsh。

## 功能

点击备份按钮，整个 dsh 目录整个打包成一份快照存到本地（默认dsh同级目录，可配置）；保留最近 3 份，可配置。
配置在dsh通用设置中
自定义配置记录在 `~/.dsh-backup.json`

警告！不要把备份目录放在dsh本体里，没做这方面的防呆设计。

## 遇到占用的文件

- 被别的程序占着的文件（比如某个插件正在用的 SQLite 数据库）会先复制一份再打进包，所以照样能备份到。但这份副本是在对方运行中抓的，数据库可能需要自己再恢复一次。
- 在列清单之后消失的文件会被跳过并在结果里说明，不会让整次备份失败；确实读不了的文件同理。
- 中文/非 ASCII 文件名能正常归档。
- 结果里会给出 `liveCopies`（占用中被复制）、`skipped`（跳过及原因）、`unstable`（读取时被改动）。

## 安装方式

将发布的zip解压到任意目录，然后：

```sh
npx @deepseek-ai/dsh plugin --profile web add ~\dsh-backup-plugin
```

重启即可

## 版本兼容

dsh 0.2.0 起会在安装/启用插件前校验它对 dsh 版本的要求，所以本插件声明了自己支持的版本，让 dsh 直接拒绝加载，而不是跑到一半出错：

```json
"peerDependencies": { "@deepseek-ai/dsh": ">=0.1.5-rc.2 <0.3.0-0" }
```

上界写成 `<0.3.0-0` 而不是 `<0.3.0`：dsh 匹配范围时把预发布版也算在内，`<0.3.0` 会连 `0.3.0-rc.1` 一起放进来。

已在 0.1.5-rc.2 和 0.2.0-rc.2 上实测可用。如果 dsh 提示不兼容，请更新插件，不要随手给版本豁免——那是把崩溃和数据损坏的风险自己扛下来。

**桌面版**用的是独立的 `desktop` 配置档，装在 `web` 档里的插件在桌面版里不会加载。先把桌面版打开一次，然后完全退出，再执行：

```sh
npx @deepseek-ai/dsh plugin --profile desktop add ~\dsh-backup-plugin
```

## 卸载

如果dsh唐突更新，本插件导致dsh无法启动，运行以下命令卸载：

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-backup-plugin
```

## License

MIT License

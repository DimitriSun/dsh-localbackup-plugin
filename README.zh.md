# dsh-backup-plugin

[English](README.md) | **简体中文**

不到一个月我的 dsh 已经搞坏 3 次了，这个插件采用最简单最不绕弯子的方式直接备份整个 dsh。

## 功能

点击备份按钮，整个 dsh 目录整个打包成一份快照存到本地（默认dsh同级目录，可配置）；保留最近 3 份，可配置。
配置在dsh通用设置中
自定义配置记录在 `~/.dsh-backup.json`

警告！不要把备份目录放在dsh本体里，没做这方面的防呆设计。

## 安装方式

将发布的zip解压到任意目录，然后：

```sh
npx @deepseek-ai/dsh plugin --profile web add ~\dsh-backup-plugin
```

重启即可

## 卸载

如果dsh唐突更新，本插件导致dsh无法启动，运行以下命令卸载：

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-backup-plugin
```

## License

MIT License

# dsh-backup-plugin

**English** | [简体中文](README.zh.md)

My dsh broke three times in under a month, so this plugin takes the simplest, most no-nonsense approach: it just backs up the whole dsh directory.

## Features

Click the backup button and the entire dsh directory gets packed into one snapshot stored locally (by default in a folder next to your dsh directory — configurable). Only the latest 3 snapshots are kept (also configurable).

Settings live in dsh's **General** settings page. Custom values are recorded in `~/.dsh-backup.json`.

> ⚠️ Warning: don't put the backup folder inside the dsh directory itself — there's no guardrail for that.

## Install

Extract the release archive to any folder, then run:

```sh
npx @deepseek-ai/dsh plugin --profile web add ~\dsh-backup-plugin
```

Restart dsh — done.

## Uninstall

If a dsh update goes sideways and this plugin ends up keeping dsh from starting, remove it with:

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-backup-plugin
```

## License

MIT License — see [LICENSE](LICENSE).

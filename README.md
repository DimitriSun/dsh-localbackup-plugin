# dsh-backup-plugin

**English** | [简体中文](README.zh.md)

My dsh broke three times in under a month, so this plugin takes the simplest, most no-nonsense approach: it just backs up the whole dsh directory.

## Features

Click the backup button and the entire dsh directory gets packed into one snapshot stored locally (by default in a folder next to your dsh directory — configurable). Only the latest 3 snapshots are kept (also configurable).

Settings live in dsh's **General** settings page. Custom values are recorded in `~/.dsh-backup.json`.

> ⚠️ Warning: don't put the backup folder inside the dsh directory itself — there's no guardrail for that.

## Awkward files

- A file another program holds open — a plugin's live SQLite database, for example — is copied first and then archived, so it still lands in the backup. That copy is taken while the owner keeps running, so a database captured this way may need its own recovery.
- A file that disappears between listing and archiving is skipped and reported instead of failing the whole run; the same goes for a file that is genuinely unreadable.
- Non-ASCII file names are archived correctly.
- The result reports `liveCopies` (copied while held open), `skipped` (with a reason each) and `unstable` (changed while being read).

## Install

Extract the release archive to any folder, then run:

```sh
npx @deepseek-ai/dsh plugin --profile web add ~\dsh-backup-plugin
```

Restart dsh — done.

## Compatibility

dsh 0.2.0 and later check a plugin's DSH peer range before installing or activating it, so this plugin declares what it supports and dsh refuses it instead of failing halfway:

```json
"peerDependencies": { "@deepseek-ai/dsh": ">=0.1.5-rc.2 <0.3.0-0" }
```

The upper bound is `<0.3.0-0` rather than `<0.3.0` on purpose: dsh matches the range with prereleases included, and `<0.3.0` would still admit `0.3.0-rc.1`.

Verified running on 0.1.5-rc.2 and 0.2.0-rc.2. If dsh reports the plugin as incompatible, update it instead of granting a version exemption — the harness may have changed underneath it.

**Desktop:** the desktop application runs its own `desktop` profile, so a plugin installed into `web` is not loaded there. Open Desktop once, quit it completely, then run:

```sh
npx @deepseek-ai/dsh plugin --profile desktop add ~\dsh-backup-plugin
```

## Uninstall

If a dsh update goes sideways and this plugin ends up keeping dsh from starting, remove it with:

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-backup-plugin
```

## License

MIT License — see [LICENSE](LICENSE).

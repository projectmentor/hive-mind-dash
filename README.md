# hive-mind-dash (hdash)

The HiveMind dashboard as a module: one place to see your hive, your devices and your modules, and to set them up
without the command line.

**Status: 0.1, the dashboard moved as it is.** `hdash` is the dashboard that used to ship inside
[hive-mind](https://github.com/projectmentor/hive-mind), unchanged, now a module (manifest contract 1, hive-mind 3.1).
`hv dash` forwards to it in 3.1 and goes in 4.0. The declarative UI slots and the install wizard below are still
planned; the design is tracked on [hive-mind#298](https://github.com/projectmentor/hive-mind/issues/298).

```
hive-mind module install hdash --from <this repo> --publisher <key>   # the installer does this on every node
hv dash                                                              # or: hdash dash
```

It is read-only. **Modules** (nav) is Settings › Modules: the installed modules from `hive-mind module list --json` with each one's cached doctor result and its age (`.module-doctor/<name>.json`, which a web request only reads), and a generic page per module (overview, health, and a declared action as a command line to copy). It never runs module code and runs no action; configuration forms wait for hconfig. `hdash serve` listens on `127.0.0.1` (config key `port`, default 9896), answers GET only and only
for the loopback Host, and maps the page's `/api/*` reads to the core's signed `/v1` routes (overview, tags, related,
audit, peers, verify, search, item) or, for status, telemetry, entities and a peer's `?node=` view, to the sync
daemon's loopback `/api/*`. `/v1/search` and `/v1/item` leave out facts the owner forgot, which the old page showed.

## What it will do

- **Come with HiveMind.** A first-party module, installed by default on every device; a device may remove it.
- **Show every module the same way.** Other modules don't ship UI code. Each module's signed manifest declares what it
  wants shown (an overview card, a config form, health, actions, activity), and hdash renders it from a small fixed set
  of generic widgets. A new widget type is added only when at least two modules need it.
- **One setup path.** One config schema drives both the command-line install and the dashboard's install wizard.
- **Keep owner actions safe.** Owner actions are signed outside the dashboard, so the owner passphrase never enters it.

Moving the dashboard out of hive-mind follows the 3.1 core split
([hive-mind#293](https://github.com/projectmentor/hive-mind/issues/293)) and the module contract in
[hive-mind#294](https://github.com/projectmentor/hive-mind/issues/294).

If this is useful to you, a star on the [hive-mind repo](https://github.com/projectmentor/hive-mind) helps.

## License

MIT. See [LICENSE](LICENSE).

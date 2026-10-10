# hive-mind-dash (hdash)

The HiveMind dashboard as a module: one place to see your hive, your devices and your modules, and to set them up
without the command line.

**Status: planned, no code yet.** hdash work is deferred until after 3.0. Today the dashboard is part of
[hive-mind](https://github.com/projectmentor/hive-mind) itself: run `hv dash` to open it, read-only, in your browser.
The design is tracked on [hive-mind#298](https://github.com/projectmentor/hive-mind/issues/298).

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

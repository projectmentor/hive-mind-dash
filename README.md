# hive-mind-dash (hdash)

The HiveMind dashboard as a module. This repository is new and has no code yet; the design is tracked on [hive-mind#298](https://github.com/projectmentor/hive-mind/issues/298).

- **First-party module**, installed by default on every node; a node may remove it.
- **Declarative slots.** Other modules don't ship UI code. Each module's signed manifest declares a `ui` block (overview card, config form from a config schema, health from its doctor JSON, actions, activity, standard layouts), and hdash renders it from a small fixed set of generic widgets. A widget type is added only when at least two modules need it.
- **One config schema** drives both the CLI install and the dashboard install wizard.
- **Owner actions are signed outside the dashboard.** The owner passphrase never enters the dashboard process.

Extraction from [hive-mind](https://github.com/projectmentor/hive-mind) `dashboard/` is part of the 3.1 core split (hive-mind#293), on the module contract in hive-mind#294.

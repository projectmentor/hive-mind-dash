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

It is read-only. **Modules** (nav) is Settings › Modules: the installed modules from `hive-mind module list --json` with each one's cached doctor result and its age (`.module-doctor/<name>.json`, which a web request only reads), and a generic page per module (overview, health, and a declared action as a command line to copy). Every non-GET request must pass a Host check, an exact same-origin `Origin`, `Sec-Fetch-Site: same-origin` when sent, and a per-process CSRF token (`GET /api/csrf`, header `X-HDash-CSRF`) before any write route is looked up; The one write route is `POST /api/settings` `{id, value}`, which runs `hconfig set` with the value on stdin (never argv) and, beyond the guard above, refuses a non-loopback source and any request carrying a `Tailscale-*` header (hive-mind#100 gates 6a–6c). **Settings** (nav) is Settings › Node, and each module page has a **Config** tab; both render `hconfig list --json` records (`GET /api/settings?prefix=&class=`) and never read a config file, manifest or governance entry themselves. A key whose `writable_by` is `owner` is signed by the core through the owner-unlock agent: while it is unlocked Save works, otherwise the form shows the unlock hint (`exit 5`, `owner-locked`). hdash signs nothing and never sees the owner passphrase; `core:` keys and `node:owner_quota` are read-only with the exact command to run on your terminal. A same-uid process can run `hconfig set` itself, so the endpoint adds no authority a local process lacks. hconfig must be installed (`hive-mind module add hconfig`). hdash never runs module code and runs no action. `hdash serve` listens on `127.0.0.1` (config key `port`, default 9896), answers GET only and only
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

## Who can save settings

`POST /api/settings` runs `hconfig set` as the operator, so it is not open to every local process. `hdash serve` writes a
random launch token to `$HIVE_HOME/.hdash-launch-token` (mode 0600, new on each start). `hv dash` opens
`http://127.0.0.1:<port>/#k=<token>`; the page keeps the token for the tab, drops it from the address bar, and sends it as
`X-HDash-Launch` to get the CSRF token from `/api/csrf`. Another OS account on the node can reach the port but cannot read
the file, so it gets no CSRF token and no write. Residual (for THREAT_MODEL): a process running as the operator's own uid
can read the file, as it can read every other 0600 file; keep `$HIVE_HOME` private to the operator.

## License

MIT. See [LICENSE](LICENSE).

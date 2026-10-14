# hive-mind-dash (hdash)

The HiveMind dashboard as a module: one place to see your hive, your devices and your modules, and to set them up
without the command line.

**Status: 0.1, the dashboard moved as it is.** `hdash` is the dashboard that used to ship inside
[hive-mind](https://github.com/projectmentor/hive-mind), unchanged, now a module (manifest contract 1, hive-mind 3.1).
`hv dash` forwards to it in 3.1 and goes in 4.0. The declarative UI slots and the install wizard below are still
planned; the design is tracked on [hive-mind#298](https://github.com/projectmentor/hive-mind/issues/298).

```
hive-mind module add hconfig --from https://github.com/projectmentor/hive-mind-config --publisher <hconfig key>
hive-mind module add hdash --from <this repo> --publisher <hdash key>   # needs hive-mind 4.0 and hconfig
hv dash                                                              # or: hdash dash
```

It is read-only. **Modules** (nav) is Settings › Modules: the installed modules from `hive-mind module list --json` with each one's cached doctor result and its age (`.module-doctor/<name>.json`, which a web request only reads), and a generic page per module (overview, health, and a declared action as a command line to copy). Every non-GET request must pass a Host check, an exact same-origin `Origin`, `Sec-Fetch-Site: same-origin` when sent, and a per-process CSRF token (`GET /api/csrf`, header `X-HDash-CSRF`) before any write route is looked up; The one write route is `POST /api/settings` `{id, value}`, which runs `hconfig set` with the value on stdin (never argv) and, beyond the guard above, refuses a non-loopback source and any request carrying a `Tailscale-*` header (hive-mind#100 gates 6a–6c). **Settings** (nav) is Settings › Node, and each module page has a **Config** tab; both render `hconfig list --json` records (`GET /api/settings?prefix=&class=`) and never read a config file, manifest or governance entry themselves. A key whose `writable_by` is `owner` is signed by the core through the owner-unlock agent: while it is unlocked Save works, otherwise the form shows the unlock hint (`exit 5`, `owner-locked`). hdash signs nothing and never sees the owner passphrase; `core:` keys and `node:owner_quota` are read-only with the exact command to run on your terminal. A same-uid process can run `hconfig set` itself, so the endpoint adds no authority a local process lacks. hconfig must be installed (`hive-mind module add hconfig`). hdash never runs module code and runs no action. `hdash serve` listens on `127.0.0.1` (config key `port`, default 9896), answers GET only and only
for the loopback Host, and maps the page's `/api/*` reads to the core's signed `/v1` routes (overview, tags, related,
audit, peers, verify, search, item) or, for status, telemetry, entities and a peer's `?node=` view, to the sync
daemon's loopback `/api/*`. `/v1/search` and `/v1/item` leave out facts the owner forgot, which the old page showed.

## Hive and Telemetry: devices and module identities

**Hive** lists the devices admitted to the group, one row each: name, device id, principal, address, last seen and status. A module that holds an admitted key of its own (a module identity) is not a device. When the core reports the device it runs on (the `host` field on `/api/peers`), that identity nests under its device: the device row shows a `▸` toggle and "N modules", and the toggle (`▾` when open) expands one indented row per identity, each linking to Modules › name. A module identity with no `host`, or whose host is not listed, is not hidden: it stays in one **Module identities** section grouped by module name. A core that sends no `module` field shows every row as a device, as before. The **Telemetry** devices list splits the same way, under **Devices** and **Module identities**, and shares the open or closed state of each device with Hive.

The purge hint (`hive-mind group purge <device>`, for removing a device that will not return) appears only on a device row that is stale or offline. It is never on the current device, never on an online device, and never on a nested module identity row; purge a module identity by removing the module, not the device.

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

## Sharing the dashboard read-only (viewer mode)

```
hdash share [--allow LOGIN] [--port N]   # start the viewer listener, run `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`
hdash unshare                            # turn the 8443 front end off, clear dashboard_share
hdash viewers [--json]                   # the allowlist and the Serve status
hdash doctor                             # the dashboard-exposure check (the module doctor slot runs it)
```

Needs the `tailscale` CLI. `share` with no `--allow` lists this device's Tailscale login; the list, the switch and the port are the
node keys `dashboard_viewers`, `dashboard_share` and `dashboard_viewer_port`, and every write is `hv config node set` (hdash never
writes `.peers.json`). Viewers are tailnet logins, not admitted devices: they get a read-only page on a **separate listener** that
`hdash serve` binds on `127.0.0.1:9906` (configurable) only while `dashboard_share` is on, and unbinds when it goes off or hdash stops
(Serve then answers 502; nothing is exposed). It never falls back to another port.

Every request on it must carry exactly one `Tailscale-User-Login` that is on the list (compared lowercased), be a `GET`, and name a path
in the subset: the page and its assets; `/api/overview`, `/api/search`, `/api/tags`, `/api/related`, `/api/item`, `/api/audit`,
`/api/verify`, `/api/peers` (always `probe=0`); and `GET /api/config/records`. Everything else is `403` with `{"listener": "viewer"}`,
including a request from `127.0.0.1` with no header (that is how every Serve request arrives, so a source address proves nothing),
`?node=`, `/api/telemetry`, `/api/status`, `/api/daemon`, and any write; there is no `POST` handler. `config/records` is the hconfig
records a viewer may see: a governed value that is not `identifying`, or a non-secret module value whose panel is `viewer: true`; never a
`node:` key, a secret, `set_by`, a `write_via` command or an audit line. The listener has its own rate limit (per login), its own slots
and a few-second cache, and bounds the calls hdash makes to the core for viewers, so a viewer flood cannot starve the operator.

`share` refuses unless the viewer port is not hdash's operator port, the daemon's live port, inside the daemon's fallback range
(`range(base, base+5)`) or the module API's port, **and** a loopback probe of the port gets the viewer listener's signature reply
(not the dashboard); nothing already serves HTTPS 8443; and Funnel is off. Doctor repeats these checks and fails on Funnel for 8443.

Operator rules: the whole gate rests on Tailscale Serve stripping a client-supplied `Tailscale-User-*` header (verified against the
installed Tailscale version by a live request that sets the header, which this repository's tests do not do); if that ever failed it
would fail open. Never enable Funnel on 8443, never point Serve at hdash's operator port or the daemon's port, and run `hdash unshare`
before `hive-mind module remove hdash` (the module contract has no remove hook, so a Serve entry would be left aimed at a dead port).

## Install on a 4.1 node

`hive-mind module add hdash --from https://github.com/projectmentor/hive-mind-dash --publisher <key in module.json>` needs core 4.1
(`min_core` 4.1). The manifest is contract 1 and signed; it signs **no `trust` field, so the tier is `trusted`** (the install prints
that before you confirm): hdash writes its launch token under `$HIVE_HOME` and runs `hconfig`, `tailscale` and the core's verbs, which a
`confined` unit could not do. It installs the `hdash` command and a systemd user service that runs `hdash serve`
(`restart: always`), which opens **one listener, `127.0.0.1:9896`** (config key `port`), loopback only, `GET` for the page plus the
guarded `POST /api/settings`. A second loopback listener, `127.0.0.1:9906` (`dashboard_viewer_port`), is bound **only while
`hdash share` has turned `dashboard_share` on**, and Tailscale Serve (HTTPS 8443, run by `hdash share`, not by the install) is the
only way it is reachable from the tailnet. Nothing listens on a non-loopback address, and the install itself changes no Serve config.
It reads the core's `overview`, `tags`, `related`, `audit`, `peers` and `verify` routes (declared in `reads`).

The module contract has no dependency field, so the manifest cannot require hconfig: install it first. Without it Settings and the Config
tabs show nothing, and `hdash doctor` warns `hconfig is not installed` with the fix `hive-mind module add hconfig`.

## Who can save settings

`POST /api/settings` runs `hconfig set` as the operator, so it is not open to every local process. `hdash serve` writes a
random launch token to `$HIVE_HOME/.hdash-launch-token` (mode 0600, new on each start). `hv dash` writes a 0600 redirect page
`$HIVE_HOME/.hdash-open.html` (removed after about a minute) and opens that `file://` path, so the token is never in a command
line (argv is world-readable in `/proc`); the page redirects to `http://127.0.0.1:<port>/#k=<token>`; the page keeps the token for the tab, drops it from the address bar, and sends it as
`X-HDash-Launch` to get the CSRF token from `/api/csrf`. Another OS account on the node can reach the port but cannot read
the file, so it gets no CSRF token and no write. Residual (for THREAT_MODEL): a process running as the operator's own uid
can read the file, as it can read every other 0600 file; keep `$HIVE_HOME` private to the operator.

## License

MIT. See [LICENSE](LICENSE).

# Fleet

The Fleet tab (`/fleet`, and Fleet in the iPhone app's Overview apps) is a health page for the
owner's machines: whether each is up and for how long, what it is doing, what it draws from
the wall and what that costs. Opening a machine (`/fleet#<id>`) shows a btop-style view:
per-core CPU, memory and swap, disks, network, GPU, fans, temperatures and the process list.

Off on a fresh install. Switch it on from the tab.

## How readings arrive

- **The machine Totem runs on** is read by the bridge itself (`fleet/collect.mjs`), every 3 s
  while someone has the tab open and every 15 s otherwise. Only the bridge that runs the
  scheduler collects (`BRIDGE_NO_SCHEDULER=1` turns it off).
- **Every other machine** runs `fleet/agent.mjs`, which POSTs a reading to
  `/api/fleet/report` with the Fleet token as a bearer. The tab's Settings → "Add a machine"
  shows the install command with the token. On Linux:

  ```sh
  node fleet/agent.mjs --install --url http://<totem-host>:8787 --token <token> [--name "Desk PC"]
  ```

  This copies the agent to `~/.local/share/totem-fleet`, keeps the URL and token in
  `~/.config/totem-fleet/agent.env` (0600) and runs it as the systemd user unit
  `totem-fleet-agent.service`. `--uninstall` removes all three. The reply to each report tells the
  agent when to report next, and whether to include processes (only while that machine's page is
  open). Use an address the machine can reach without a browser sign-in: a Cloudflare Access
  hostname would refuse the agent, so prefer the Tailscale address.

A reading has no secrets in it, but the process list carries full command lines, as `ps` would
show them. It is kept in memory only.

## Uptime

`data/fleet-history.json` keeps, per machine and hour, the seconds it was up and the watt-hours it
used (400 days). Uptime is reconstructed rather than only observed:

- A machine first seen after it booted counts as up since its boot time (up to 30 days back).
  Energy starts when Totem first saw it.
- When readings resume after a gap and the boot time has not changed, the machine was up the
  whole time (Totem or the agent was away), and the gap is credited at the average of the
  readings either side. A new boot time means it went down; only the time since the new boot
  counts.
- A machine silent for five minutes raises a `fleet.offline` notification, and another when it
  reports again.

## Power

Each reading carries the parts its sensors can see; `wallWatts` in `fleet/power.mjs` adds what
none can see (`baseWatts`) and divides by the power supply's efficiency. Each machine's page
shows the sum and whether it is measured, partly measured or estimated.

| Platform | Measured | Estimated |
|---|---|---|
| macOS (Apple Silicon) | Whole-system power, CPU, GPU, temperatures and fans from [macmon](https://github.com/vladkens/macmon) (`brew install macmon`, no root). One `macmon pipe` runs beside the collector. | Without macmon: 4 W plus 36 W scaled by CPU load. |
| Linux | CPU package power from RAPL, once it is readable (below). NVIDIA GPU power from `nvidia-smi`. | CPU: 8% to 100% of its rated power by load. A discrete GPU nvidia-smi cannot read: 12 W. |

Defaults: Linux adds 25 W for the board, memory, drives and fans at 85% supply efficiency; macOS
adds nothing at 90% (macmon's system figure already covers the board). Both can be changed per
machine under "Adjust the estimate". A plug-in power meter's idle reading is the best way to set
the baseline.

RAPL's energy counter is root-only by default. `node fleet/agent.mjs --rapl-rule` prints a
systemd-tmpfiles rule that makes it readable by the user's group, kept across reboots. It needs
`sudo` once. A failed `nvidia-smi` ("Driver/library version mismatch") usually means a driver
update is waiting for a reboot; the agent retries every five minutes.

## Cost

Watt-hours × the price of a kWh. The price comes from, in order: a ¢/kWh typed into Settings
(from a bill), or the state average residential price for the ZIP code's state, or the US
average. State prices are EIA Electric Power Monthly table 5.6.A (`fleet/pricing.mjs`, with the
month they are from); refresh them from the URL in that file. They average delivery charges in,
but not a utility's tiers or time-of-use rates.

"Projected" figures use the average draw over the last seven days (or as long as the machine has
been watched).

## Files and settings

| | |
|---|---|
| `data/fleet.json` (0600) | on/off, the agent token, ZIP, ¢/kWh, per-machine name, hidden, `baseWatts`, `efficiency` |
| `data/fleet-history.json` (0600) | hourly uptime and energy per machine |
| `FLEET_CONFIG_FILE`, `FLEET_HISTORY_FILE` | move those files |
| `FLEET_DEVICE_ID` | the id this machine reports under (default: hostname) |
| `FLEET_MACMON` | path to macmon, if not in `/opt/homebrew/bin` or `/usr/local/bin` |

API (behind sign-in): `GET /api/fleet`, `GET|PUT|DELETE /api/fleet/devices/:id`,
`PUT /api/fleet/settings`, `GET /api/fleet/agent`, `POST /api/fleet/agent/token`. Agents:
`POST /api/fleet/report` with the Fleet token (404 while Fleet is off).

# Camera sync — plug the camera in, photos appear in iCloud

Plug the Olympus XZ-1 into **either** the Linux box or the MacBook and its new
JPEGs come off the card by themselves, into Apple Photos and up to iCloud. No
app, no button, no window.

Nothing is ever written to or deleted from the memory card.

## Two ways in

The camera can go into **either machine**, and there are two different stories
because the machines have very different capabilities.

```
  Plug into the MacBook — the direct path, nothing waits:

    XZ-1 ──USB──▶ MacBook ──▶ Photos ──▶ iCloud
                  launchd StartOnMount, then import within seconds


  Plug into the Linux box — store-and-forward, because it can't reach iCloud:

    XZ-1 ──USB──▶ linux box ─────────────▶ MacBook ──▶ Photos ──▶ iCloud
                  (instant, always on)    (whenever it's next awake)
```

Plugging into the **Mac** is strictly better when it's to hand: photos are in
Photos within seconds and there's no backlog to track. Plugging into the **Linux
box** works when the Mac is shut, which it usually is — but the photos then wait
for a laptop lid.

Both paths run **the same engine**. `sync.mjs`, the ledger, and the EXIF date
parsing are identical; only how the card arrives differs:

| | Linux | macOS |
|---|---|---|
| Trigger | udev rule on USB filesystem add | launchd `StartOnMount` |
| Card arrives as | a block device (`/dev/sdb1`) | an already-mounted path (`/Volumes/NO_NAME`) |
| Mounting | we mount it read-only ourselves | the system already did it |
| Runs as | root | the owner |
| After import | archived on the Linux box | archived on the Mac |
| Totem reports on it | yes | no — nothing waits, so there's nothing to report |

## Why the Linux path needs the Mac at all

The obvious design — one script that reads the card and uploads to iCloud —
cannot be written on Linux, because **there is no iCloud Photos upload client for
Linux**. `icloudpd` only downloads. The unofficial upload libraries authenticate
by impersonating a browser and break whenever Apple changes anything.

The only machines on the tailnet that can put a photo into iCloud Photos are the
MacBook and the two iOS devices, and of those only the MacBook can be driven
without someone tapping a screen.

So the Linux path is **store-and-forward**, split at exactly that seam. Getting
photos off the card is instant and unconditional, because that box is always on.
Getting them into iCloud waits for a laptop lid. Those are genuinely different
reliability stories and pretending otherwise would mean a sync that looks broken
every time the MacBook sleeps.

The **backlog nag** exists because of that seam. On the Linux box, `staging`
means "not in iCloud yet", so anything sitting in it is the honest measure of
what's stuck, and Totem says something when the oldest photo has been there too
long. Without it, a MacBook left shut for a month is indistinguishable from a
working sync.

None of that applies to a card plugged into the Mac — there is no seam, so there
is no backlog and no nag.

## The parts

Shared by both machines:

| Thing | Where |
|---|---|
| Card pull | `camera/sync.mjs` |
| Shot-date parsing | `camera/exif.mjs` |
| Dedupe + naming | `camera/ledger.mjs` |
| Path defaults per platform | `camera/paths.mjs` |
| Archive-on-import | `camera/ack.mjs` |
| Tests | `camera/*.test.mjs` — `npm test` |

Linux only:

| Thing | Where |
|---|---|
| udev rule | `camera/udev/99-totem-camera.rules` |
| Unit | `camera/systemd/totem-camera-sync@.service` |
| node resolver (root, no `HOME`) | `camera/run-sync.sh` → `/usr/local/lib/totem-camera/` |
| node resolver (non-login shell) | `camera/with-node.sh` |
| Totem reporting | `camera/report.mjs` + the `camera-sync` runner |
| Installer | `camera/install.sh` |

macOS only:

| Thing | Where |
|---|---|
| Find a mounted card | `camera/volumes.mjs` |
| Mount-triggered pull | `camera/mac/totem-camera-pull.sh` + `com.totem.camera-pull.plist` |
| Import into Photos | `camera/mac/totem-photo-import.sh` + `com.totem.photo-import.plist` |
| Installer | `camera/mac/install-mac.sh` |
| Installed engine | `~/.local/lib/totem-camera/` (copied, so moving the checkout is safe) |

State, Linux:

| Thing | File |
|---|---|
| Staging (the backlog) | `~/Pictures/camera-inbox/` |
| Archive (imported) | `~/Pictures/camera-archive/` |
| What has already been pulled | `data/camera-ledger.json` |
| Plug-in events for Totem | `data/camera-events.jsonl` |
| Backlog-nag throttle | `data/camera-report-state.json` |
| Config | `/etc/default/totem-camera` |

State, macOS:

| Thing | File |
|---|---|
| Staging, card plugged in here | `~/Pictures/camera-inbox/` |
| Staging, rsynced from Linux | `~/Pictures/TotemCameraInbox/` |
| Archive | `~/Pictures/camera-archive/` |
| What has already been pulled | `~/.local/state/totem-camera/camera-ledger.json` |
| What Photos has accepted | `~/.local/state/totem-photo-import/imported-{local,remote}.txt` |
| What the Linux box has been told | `~/.local/state/totem-photo-import/acked-remote.txt` |
| Config | `~/.config/totem-photo-import.conf` |

## Install

**On the camera, first.** Menu → Settings → **USB Mode → Storage**.

This is not optional and it is the single most likely reason for "I plugged it in
and nothing happened". On *Auto* or *MTP* the XZ-1 presents itself over PTP,
which creates no block device and no mounted volume, so neither the udev rule
nor `StartOnMount` ever matches.

You can set up either machine, or both, independently.

### The Linux box

```sh
sudo camera/install.sh
```

One sudo run: the udev rule, the unit, the config, and the node wrapper, then a
udev and systemd reload. Re-running is safe and is how you pick up an edit to a
template. `--uninstall` removes it.

Then turn the reporting job on — Studio → Jobs → *Camera sync*, or seed it with
`CAMERA_SYNC_ENABLED=true` in `.env`. **The job only reports; the pull happens
whether or not it's enabled.**

### The MacBook

From a checkout of this repo, on the Mac:

```sh
camera/mac/install-mac.sh              # both halves
camera/mac/install-mac.sh --local-only # only cards plugged into this Mac
```

No root. It needs **node** (`brew install node`) and checks for it up front
rather than failing the first time a card goes in. It installs two launchd
agents, copies the engine into `~/.local/lib/totem-camera`, and sets up
passwordless ssh to the Linux box unless you passed `--local-only`.

If the ssh step fails because the Linux box is asleep, that is **not** fatal —
cards plugged into the Mac still work, and re-running the installer later fixes
the remote pull.

### Three one-time macOS prompts

All three are at setup only, and the first two must be allowed or nothing
reaches iCloud:

1. **"wants to control Photos"** → Allow. Fix later in System Settings →
   Privacy & Security → Automation.
2. **Removable volume access**, if prompted → Allow. macOS gates background
   agents reading `/Volumes`.
3. **Turn OFF Photos auto-opening.** Open **Image Capture**, select the XZ-1,
   and set *"Connecting this camera opens:"* to **No application**. Otherwise
   macOS pops a window every time you plug the camera in — which is exactly the
   thing this was built to avoid. It doesn't break the sync, it's just annoying.

## What happens on plug-in

Steps 3–7 are identical on both machines — it's the same code.

**Into the Linux box:**

1. udev sees a USB volume with a filesystem and starts
   `totem-camera-sync@sdb1.service`.
2. `sync.mjs` mounts the card **read-only** at a private temp path.
3. No `DCIM` folder → exits silently. This is what plugging in a memory stick
   does.
4. Every JPEG under `DCIM` is checked against the ledger's **cheap key**
   (`path|size|mtime`). Known ones are never read.
5. Each unknown file is copied and SHA-256'd in a single pass. If the hash is
   already in the ledger — the card was reformatted and numbering restarted —
   the copy is discarded and the file recorded as seen.
6. Otherwise it lands in
   `~/Pictures/camera-inbox/2011/2011-04-03/2011-04-03_182207_P1010001.JPG`,
   dated by EXIF `DateTimeOriginal`, falling back to mtime.
7. The card is unmounted. Safe to unplug the moment the unit exits.
8. Within 15 minutes Totem says *"42 photos off the camera"*.
9. Next time the MacBook is awake it rsyncs staging, imports into Photos in
   batches of 80, and acks back — which moves those files into `camera-archive`
   on the Linux box, clearing the backlog.

**Into the MacBook:**

1. macOS mounts the card under `/Volumes` and launchd fires
   `com.totem.camera-pull`.
2. `volumes.mjs` looks for a volume with a `DCIM` folder, skipping the boot
   volume, Time Machine, disk images and network shares. Nothing found → exits
   silently, which is what mounting anything else does.
3. …same steps 3–7, except there is nothing to mount or unmount: macOS already
   did it, and unmounting is the Finder's job.
4. It kickstarts the importer immediately rather than waiting for its 15-minute
   tick, so photos are in Photos within seconds.
5. On success the staged copies are moved to `~/Pictures/camera-archive`.

## Watching it

On the Linux box:

```sh
journalctl -f -u 'totem-camera-sync@*'          # the pull, live
ls -R ~/Pictures/camera-inbox                    # what is waiting for the Mac
sudo camera/sync.mjs --path /media/somewhere --dry-run
```

On the Mac (both agents log to the same file):

```sh
tail -f ~/Library/Logs/totem-photo-import.log
~/.local/lib/totem-camera/with-node.sh ~/.local/lib/totem-camera/volumes.mjs   # what it thinks is a camera
launchctl kickstart -k gui/$(id -u)/com.totem.photo-import   # import now
launchctl kickstart -k gui/$(id -u)/com.totem.camera-pull    # re-scan volumes now
launchctl print gui/$(id -u)/com.totem.camera-pull | head -20 # is it loaded?
```

## Configuration

### Linux: `/etc/default/totem-camera`

Read on every plug-in — nothing to restart.

| Key | Default | Does |
|---|---|---|
| `CAMERA_STAGING_DIR` | `~/Pictures/camera-inbox` | Where photos land |
| `CAMERA_ALLOW_VENDORS` | `any` | USB vendor ids that count as a camera |
| `CAMERA_EXTENSIONS` | `jpg,jpeg` | Add `orf` for Olympus RAW |
| `CAMERA_MIN_FREE_BYTES` | 5GB | Refuse a copy that would leave less |
| `NODE_BIN` | auto | Pin the interpreter |

### macOS: `~/.config/totem-photo-import.conf`

Read by both agents on every run.

| Key | Default | Does |
|---|---|---|
| `LOCAL_STAGING` | `~/Pictures/camera-inbox` | Cards plugged into this Mac |
| `LOCAL_ARCHIVE` | `~/Pictures/camera-archive` | Where they go after import |
| `REMOTE_ENABLED` | `true` | `false` to ignore the Linux box entirely |
| `REMOTE_HOST` | none; required unless `--local-only` | The Linux box's tailnet hostname, where to rsync from |
| `REMOTE_USER` | the Mac's own username | Account on the Linux box that owns the Totem checkout |
| `REMOTE_STAGING` | `/home/$REMOTE_USER/Pictures/camera-inbox` | Linux staging dir; must match `/etc/default/totem-camera` |
| `REMOTE_REPO` | `/home/$REMOTE_USER/projects/totem` | The Totem checkout on the Linux box (for `ack.mjs`) |
| `REMOTE_INBOX` | `~/Pictures/TotemCameraInbox` | Where its photos land |
| `BATCH` | `80` | Files per `osascript` import call |
| `LIB_DIR` | `~/.local/lib/totem-camera` | The installed engine |

### Totem: `.env`

| Key | Default | Does |
|---|---|---|
| `CAMERA_SYNC_ENABLED` | `false` | Seed default for the reporting job |
| `CAMERA_SYNC_INTERVAL_MINUTES` | `15` | How often it checks (min 5) |
| `CAMERA_BACKLOG_STALE_HOURS` | `48` | How long before photos count as stuck |
| `CAMERA_BACKLOG_NAG_HOURS` | `12` | How often it may say so again |

### Narrowing to just the XZ-1

The rule deliberately matches **any** USB volume, and `sync.mjs` decides using
the presence of `DCIM`. Guessing the camera's storage-mode USB id wrong would
mean the whole thing silently never fires, which is the worst possible failure
for something whose promise is that you don't think about it. The broad match
also picks up an SD card in a reader for free.

Every run logs the id it saw. Once you know the XZ-1's:

```sh
journalctl -u 'totem-camera-sync@*' | grep 'vendor='
# → device /dev/sdb1 vendor=07b4 model=0109 (Olympus Optical Co., Ltd)
sudo sed -i 's/^CAMERA_ALLOW_VENDORS=.*/CAMERA_ALLOW_VENDORS=07b4/' /etc/default/totem-camera
```

## Gotchas

**The camera must be in Storage mode.** Said twice because it's the first thing
to check when nothing happens. `lsusb` with the camera plugged in and switched
on will show it either way; `lsblk` will only show it in Storage mode.

**node is installed by nvm, so root can't see it.** A systemd unit gets none of
the shell profile that puts node on `PATH`, and the version in the path changes
on every `nvm install`. Two wrappers solve this in two different ways:
`run-sync.sh` has the nvm root baked in at install time because it runs as root
with no `HOME`; `with-node.sh` reads `$HOME` at runtime because it runs as the owner
over ssh, where a non-interactive shell also never sources `.zshrc`. If node is
upgraded and the pull starts failing with exit 127, re-run `camera/install.sh`.

**Filenames repeat.** The XZ-1 restarts at `P1010001.JPG` after a card format, so
a filename means nothing. Dedupe is `path|size|mtime` first (cheap, no read) and
SHA-256 second (exact, but only on bytes already being copied). Hashing every
file on every plug-in would mean reading a full 16GB card at USB 2.0 speed —
about nine minutes — every single time.

**A dead clock battery** makes the camera write `0000:00:00` dates. Those are
treated as "no date" and the file's mtime is used instead, rather than creating a
`0000-00-00` folder.

**The MacBook doesn't have to be awake for the pull**, only for the import. Its
being shut is the normal state, not a failure — which is why the Mac agent exits
0 when the box is unreachable rather than letting launchd throttle it.

**Photos must be granted Automation access** or every import batch fails
identically. The agent stops after the first failing batch rather than grinding
through the rest, and writes the reason to
`~/.local/state/totem-photo-import/last-error.txt`.

**JPEG only, by choice.** RAW would multiply iCloud storage for photos that
mostly aren't edited. `CAMERA_EXTENSIONS=jpg,jpeg,orf` changes it; Apple Photos
does support XZ-1 ORF files.

**`StartOnMount` fires on everything.** Disk images, Time Machine, SMB shares,
USB sticks — every mount starts `totem-camera-pull.sh`. It has to be a
sub-second silent no-op in all those cases, which is why `volumes.mjs` has both a
skip list and a 4-second per-volume probe timeout: a hung network mount must not
hang the scan, and the scan may well have been triggered *by* that mount.

**On the Mac, archiving is driven by reconciliation, not by what just imported.**
Writing the "Photos has this" ledger and moving the file to the archive are two
steps that can fail independently. If archiving were driven by "what I imported
on this run", anything that failed in between would be marked imported, skipped
by every future run, and sit in staging forever. Instead each tick recomputes
*files on disk that the ledger says are done* and archives those, so a failure
self-heals on the next tick. The remote tree additionally subtracts
`acked-remote.txt`, because rsync leaves our copy in place after the far side
archives its own — without that, every tick would re-send every photo ever
imported over ssh.

**Two extra copies on the Mac.** After import a photo exists in the Photos
library *and* in `~/Pictures/camera-archive`. On a laptop SSD that adds up. The
card is still the original, and Photos plus iCloud is the real copy, so if disk
pressure matters more than belt-and-braces, point `LOCAL_ARCHIVE` at an external
drive or replace the archive step with a delete. It's kept by default because
silently deleting someone's photos is not a good default.

## If you'd rather it didn't need the Mac

The remaining options, none of them good:

- **Unofficial iCloud upload libraries** (`pyicloud` and friends). They log in as
  a browser would, break on Apple's schedule, and put a real Apple ID at risk of
  being locked. Not worth it for a photo sync.
- **A Windows box with iCloud for Windows**, which has a genuine upload folder.
  It only helps if such a machine is reliably on; otherwise it trades one asleep
  machine for another.
- **Immich or similar, self-hosted**, and give up on Apple Photos. Fully
  automatic and entirely under your control, but it isn't the thing that was
  asked for.

The MacBook path was chosen because it's the only one that uses a supported,
first-party import route and can't get an Apple ID locked.

# GitHub App for the todo connector

The GitHub task connector authenticates as a GitHub App rather than by shelling out
to the `gh` CLI.

## Why

`gh` reads the owner's personal OAuth token out of `~/.config/gh/hosts.yml`. That token
carries every scope his account has (`repo`, `workflow`, `gist`, `read:org`) when the
connector needs two; it belongs to a login session on one machine, so a headless
service depends on a human having logged in there and stayed logged in; and shelling
out to a binary makes the connector depend on whatever `PATH` systemd handed the
unit.

An App installation inverts all three. Its reach is exactly the repositories it is
installed on. Its credential is a PEM file this process reads directly. Its tokens
last an hour and are re-minted in-process, so nothing expires that anyone has to
re-authorise.

## What it cannot do

An installation token is not a person, so `assignee:@me` has no meaning. The login is
configuration instead — `GITHUB_ASSIGNEE_LOGIN`, or the account the App is installed
on, read from the API on first use. Likewise "every repo I can reach" becomes "every
repo the App is installed on": `/installation/repositories` rather than `/user/repos`.
A repo the App is not installed on cannot be searched, however much access the human
has to it. That is the point of the trade, but it means the auto-track repo list is
only as wide as the install.

## Configuration

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_FILE=/path/to/totem/secrets/github-app.pem
GITHUB_APP_INSTALLATION_ID=         # optional; discovered if the App is installed once
GITHUB_ASSIGNEE_LOGIN=your-login    # optional; defaults to the installation account
```

Permissions the App needs, and no others: **Issues: Read and write**, **Metadata:
Read-only**. No webhook — Totem polls on the 15-minute `github-todos-sync` job.

`scripts/connect-todo-sources.sh` walks through creating the App, installing the key,
and verifying it (it also covers the Action Items sheet). To check credentials on
their own:

```bash
node todos/cli.mjs github-check
```

That mints a real installation token and prints the login the connector will act as
plus how many repositories it can see.

## Fallback

With `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY_FILE` unset — or the key file
missing — the bridge falls back to the `gh` CLI client and says so in its startup
log:

```
todos: GitHub connector using the gh CLI — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE to use a GitHub App
```

With both set it logs the App and installation it is using instead. The fallback
exists so the connector keeps working between deciding to switch and finishing the
setup; it is not meant to be the steady state.

## Not covered by this

`/api/github/repos` — the repo picker behind the Code tab — still uses `gh`. It
answers "every repo the owner can touch", which is deliberately wider than the App's
installation and would shrink if it were moved.

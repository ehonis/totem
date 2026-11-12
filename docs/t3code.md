# T3 Code through the gateway

Totem's agents can drive [T3 Code](https://github.com/pingdotgg/t3code) (start threads, read them,
wait on them) through T3 Code's own MCP server. It is an ordinary remote connection in
`data/mcp-manifest.json`, so its tools show up in the gateway as `t3code__*`.

## Which machine a thread says it came from

T3 Code puts a "started from" label on a thread (`linkOrigin`) only when the MCP session that
started it signed in as a **linked environment**, which is a registration with
`software_id: "t3code-peer-link"`. The label is that registration's `client_name`. An ordinary
outside app (what T3 Code's "Use T3 Code in another app" dialog sets up) gets no label. A call
that one T3 Code forwards to another machine (`environmentId`) reaches that machine as the
forwarding machine's link, so before this change every thread Totem started on a second machine
said "T3 Code · <first machine>".

Two manifest fields fix both:

- **`oauth`** on a remote server sets how Totem registers itself when it signs in:
  `clientName` (default "Totem Gateway") and `softwareId`. Changing either registers a new client
  at the next sign-in instead of reusing the stored one.
- **`route`** makes a server stand in for another one when a call names a target. Its own tools
  are not listed; a call to `<for>__<tool>` whose arguments carry every value in `match` goes to
  it, with those arguments removed. If the route is not connected, the call goes to the server
  it stands in for, which still forwards it (with the old label).

One connection per machine, each through its T3 Connect address (shown in T3 Code under
"Use T3 Code in another app", `https://prod-<id>.t3coderelay.com/mcp`):

```json
{
  "servers": {
    "t3code": {
      "transport": "http",
      "url": "https://prod-<first machine>.t3coderelay.com/mcp",
      "oauth": { "clientName": "Totem", "softwareId": "t3code-peer-link" },
      "name": "T3 Code"
    },
    "t3code-laptop": {
      "transport": "http",
      "url": "https://prod-<second machine>.t3coderelay.com/mcp",
      "oauth": { "clientName": "Totem", "softwareId": "t3code-peer-link" },
      "route": { "for": "t3code", "match": { "environmentId": "<second machine's environment id>" } },
      "name": "T3 Code · laptop"
    }
  }
}
```

A machine's environment id is in `t3code__t3_environment_links` (or `t3_environment_read` on
that machine).

## Signing in

Each connection signs in once, from Settings → Connections (or
`POST /api/mcp/gateway/oauth/start {"id":"<server id>"}`). A linked-environment sign-in is
approved on the machine's own approval page with a plain pairing code
(`t3 auth pairing create --ttl 5m --json` on that machine), at **full access**: a lower level
fences the session to threads it started. T3 Code issues no refresh token, so the grant lapses
after 30 days and needs signing in again.

`software_id: "t3code-peer-link"` is T3 Code's internal marker for its own machine-to-machine
links, not a documented setting for outside apps. If a T3 Code release stops honouring it,
threads lose the label but every call keeps working.

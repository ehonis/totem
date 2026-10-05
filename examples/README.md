# Examples

This directory holds optional, personalised starting points. Nothing here is
installed automatically: a fresh install only receives the generic skills in
`skills/seeds/`, and those are copied into `data/skills/` once, on first boot.

The examples show how a skill can be tailored to one person's setup, for instance
a meeting ingest that only looks at certain venture tags and syncs accepted items
to a shared sheet. Read them, adapt the names and rules to your own setup, and
import only the ones you want.

## Importing a skill

Copy the skill's directory into your data directory under the id you want it to
have:

```sh
cp -r examples/skills/<id> data/skills/<id>
```

It then appears in Studio -> Skills, where you can edit it further. If the
example uses the same chat command as a skill you already have (for example
`$plaud-meetings`), change the `command:` line in one of them so each command is
unique.

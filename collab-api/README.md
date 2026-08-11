# OminiNote collaboration relay

A ~300-line Cloudflare Worker that stores **only** the collaboration handshake:
who joined a share, their role, the Drive file id of their published channel,
and when they were last seen.

**Notes never pass through here.** Note content stays in each participant's own
Google Drive as "anyone with the link" files. This service exists for exactly
one reason: under the `drive.file` OAuth scope, a guest's app cannot see a file
the owner shared with them, and cannot write anything into the owner's Drive —
so Drive itself has no way to carry "I joined, here is my channel id".

## Deploy

```bash
cd collab-api
npx wrangler kv namespace create COLLAB     # prints an id
# paste that id into wrangler.toml
npx wrangler deploy
```

The deploy prints a URL like `https://omininote-collab.<you>.workers.dev`.
Build the app with it:

```bash
flutter build apk --dart-define-from-file=.dart_defines.json \
  --dart-define=COLLAB_RELAY_URL=https://omininote-collab.<you>.workers.dev
```

or add `"COLLAB_RELAY_URL": "https://…"` to `.dart_defines.json`.

Free tier covers this comfortably — a share writes a few KB and is read once
per sync poll per participant.

## API

All bodies are JSON. Secrets are compared as SHA-256 hashes.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/v1/health` | anyone | liveness |
| `POST` | `/v1/share` | owner | create share / refresh published channel id |
| `POST` | `/v1/invite` | owner | record "this email is invited as reader\|writer" |
| `POST` | `/v1/join` | guest | join with the link's `joinKey`; returns `memberSecret` + assigned role |
| `GET` | `/v1/roster?shareId=&secret=&memberId=` | member/owner | list members + their channel ids |
| `POST` | `/v1/heartbeat` | member | refresh `lastSeenAt`, publish channel id |
| `POST` | `/v1/member` | owner | change a member's role, or remove them |
| `POST` | `/v1/close` | owner | delete the share record |

### Capability secrets

- **`joinKey`** — travels in the invite link. Lets the holder join and, after
  joining, read the roster. Same bar as knowing the share link itself.
- **`ownerSecret`** — generated on the owner's device, never shared. Required
  for every mutation (invite, role change, remove, close).
- **`memberSecret`** — issued at join, stored on that member's device.

A guest can never choose their own role: `join` takes the role from the owner's
recorded invite for that email, else the share default.

## What a stolen KV dump would reveal

Emails, display names, roles, and Drive file ids of published channels — not
note content, and not enough to join (secrets are stored hashed). Drive file
ids are only useful to someone who also has the link, which is the documented
"anyone with the link" security model of the share itself.

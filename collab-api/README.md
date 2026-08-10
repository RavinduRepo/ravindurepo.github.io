# OminiNote collab join registry

Tiny Cloudflare Worker that lets **owners see who joined** and **auto-link
editor write channels** without a second manual deep link.

## Why

Google OAuth `drive.file` does not allow a guest app to update the owner’s
invite file (API 404). Note content still lives only on Google Drive; this
API stores join metadata only (email, role, public peer file ids).

## Security

- Capability secret in the invite JSON (`joinSecret`) — same model as
  “anyone with the invite link”.
- No notebook bodies, strokes, or assets.
- Room TTL 90 days; max 200 members.

## Deploy (free Cloudflare)

```bash
cd collab-api
npm i -g wrangler
wrangler login
wrangler kv namespace create COLLAB_ROOMS
# paste id into wrangler.toml
wrangler deploy
```

Point DNS `collab-api.omininote.com` → Worker, **or** set the app define:

```text
--dart-define=COLLAB_REGISTRY_URL=https://omininote-collab-api.<you>.workers.dev
```

Default in the app is `https://collab-api.omininote.com`.

## Until this is deployed

App falls back to the one-time owner `collab-peer` link for editors.
View-only “who joined” needs the registry.

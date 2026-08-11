# OminiNote collaboration relay (Vercel)

`collab/[...path].js` is a serverless function served at
`https://omininote.com/api/collab/*`. It stores **only** the collaboration
handshake: who joined a share, their role, the Drive file id of their published
channel, and when they were last seen.

**Notes never pass through here.** Note content stays in each participant's own
Google Drive as "anyone with the link" files and moves Drive-to-Drive. This
exists for one reason: under the `drive.file` OAuth scope, a guest's app cannot
see a file the owner shared with them and cannot write anything into the owner's
Drive — so Drive has no way to carry "I joined, here is my channel id".

It has **no npm dependencies**: storage is Upstash Redis over its REST API,
called with plain `fetch`. The repo stays a static site with no build step.

## Setup

1. Import this repo into Vercel (Add New → Project → pick the repo → Deploy).
2. Create a **free** Redis at [upstash.com](https://upstash.com) — sign up with
   GitHub, **no credit card**, 500K commands/month and 256 MB. Copy its two
   **REST** values (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).

   Signing up at Upstash directly is deliberate: Vercel's Marketplace flow can
   ask for a payment method before it will provision anything, even on a free
   plan. Going direct avoids that and uses the same free tier.
3. In Vercel: **Settings → Environment Variables** → add those two names and
   values (all environments).
4. **Redeploy once** — a function only sees variables that existed when it was
   built.
5. Point `omininote.com` at the project (Settings → Domains).
6. Build the app with `COLLAB_RELAY_URL=https://omininote.com/api/collab`.

Check it with:

```bash
curl https://omininote.com/api/collab/v1/health
```

`{"ok":true,...}` means it is live. A 500 mentioning Redis credentials means
step 2 or 3 was missed.

## API

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/v1/health` | anyone | liveness |
| `POST` | `/v1/share` | owner | create share / refresh published channel id |
| `POST` | `/v1/invite` | owner | record "this email is invited as reader\|writer" |
| `POST` | `/v1/join` | guest | join with the link's `joinKey`; returns `memberSecret` + assigned role |
| `GET` | `/v1/roster?shareId=&secret=&memberId=` | member/owner | list members + their channel ids |
| `POST` | `/v1/heartbeat` | member | refresh `lastSeenAt`, publish channel id |
| `POST` | `/v1/member` | owner | change a member's role, or remove them |
| `POST` | `/v1/leave` | member | remove yourself |
| `POST` | `/v1/close` | owner | delete the share record |

### Capability secrets

- **`joinKey`** — travels in the invite link. Lets the holder join and, after
  joining, read the roster. Same bar as knowing the share link itself.
- **`ownerSecret`** — generated on the owner's device, never shared. Required
  for every mutation (invite, role change, remove, close).
- **`memberSecret`** — issued at join, stored on that member's device.

A guest can never choose their own role: `join` takes it from the owner's
recorded invite for that email, else the share default.

## Traffic

Joining is a write. Everything routine is a **read** — the client asks who is in
a share at most once a minute for the notebook it has open, and once every five
minutes for the rest, however fast it syncs notes. A member writes a heartbeat
only when its published channel id changes or every 30 minutes.

So one person actively using the app all day is on the order of a few thousand
Redis commands, against a free allowance of 500,000 per month. The free tier is
not a stopgap here — it is comfortably more than this service needs.

## What a stolen database dump would reveal

Emails, display names, roles, and Drive file ids of published channels — not
note content, and not enough to join (secrets are stored hashed). Those file ids
are only useful to someone who also has the invite link, which is the documented
"anyone with the link" security model of the share itself.

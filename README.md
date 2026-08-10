# omininote.com

Static site for [OminiNote](https://omininote.com), hosted via GitHub Pages
(`ravindurepo.github.io`) with CNAME → `omininote.com`.

**The site does not store notes or run sync.** It is a thin public front door:
marketing pages, legal text, and deep-link handoff pages that open the installed
app. All notebook data stays on devices + each user’s Google Drive.

## Pages

| Path | Purpose |
|------|---------|
| `/` | Landing |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |
| `/import?id=…` | Snapshot share handoff → open app |
| `/collab?id=…` | Collab invite handoff → open app |
| `/collab-peer?…` | Rare peer-register fallback → open app |
| `/link/…` | Internal item link handoff (`404.html` fallback) |
| `/.well-known/assetlinks.json` | Android App Links (needs real SHA-256) |

Deep-link pages try `omninote://…` so an installed app opens; otherwise they
show Download + **Open in OminiNote**.

## Collab data flow (site role)

1. Owner invites → app puts a **public invite JSON** on the owner’s Drive and
   shares a **tappable** link `https://omininote.com/collab?id=<inviteFileId>`.
2. Guest taps link → **this site** hands off to the app → app downloads invite
   JSON from Drive (HTTPS, no backend) and pulls notebook files.
3. Guest edits → app writes peer-write files on the **guest’s** Drive and
   announces the peer index on the living invite card (Drive only).
4. Owner poll → reads invite + peer files from Drive and merges.

The website never sees notebook content — only opens the app with the file id
in the URL query string.

## Android App Links (verified)

1. Get the **release** signing cert SHA-256:

   ```bash
   keytool -list -v -keystore path/to/release.jks -alias <alias>
   ```

2. Replace `REPLACE_WITH_RELEASE_SHA256_FINGERPRINT` in
   `.well-known/assetlinks.json` (colon-separated hex, uppercase as keytool shows).

3. Optionally add the **debug** cert fingerprint for `flutter run` testing.

4. Confirm:

   ```text
   https://omininote.com/.well-known/assetlinks.json
   ```

Until that fingerprint is set, https links still work via the browser →
custom-scheme handoff.

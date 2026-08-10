# omininote.com

Static site for [OminiNote](https://omininote.com), hosted via GitHub Pages
(`ravindurepo.github.io`) with CNAME → `omininote.com`.

## Pages

| Path | Purpose |
|------|---------|
| `/` | Landing |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |
| `/import?id=…` | Share-link handoff → open app |
| `/collab?id=…` | Collab invite handoff → open app |
| `/collab-peer?…` | Peer-register handoff → open app |
| `/link/…` | Internal item link handoff (via `404.html` SPA fallback) |
| `/.well-known/assetlinks.json` | Android App Links (needs real SHA-256) |

Deep-link pages try `omninote://…` so an installed app opens; otherwise they
show Download + **Open in OminiNote**.

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

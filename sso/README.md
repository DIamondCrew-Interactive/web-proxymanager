# Proxy Manager SSO — local opt-in overlay

This directory is NOT part of the approved reskin release. The root Dockerfile,
smoke runner, version lock, engine and upstream database schema are unchanged.
Candidate source is prepared for branch `integration/central-sso-20260911` only.
No SSO release or deployment was performed. Baseline source backup:
`.cache/sso-backup/pre-sso-source.zip`.

## Backend audit and integration

Pinned NPM 2.15.1 uses Express 5, Objection user records, native TokenModel,
`internal/token.js.getTokenFromUser`, native `2fa-challenge` tokens and
`internal/token.js.verify2FA`. Overlay patches only backend app.js routing (exact
upstream SHA-256 guard), adds dci-sso modules and adds a real React login control.
It does not patch password authentication, proxy routing, existing authorization
middleware or certificates. SSO always uses native scope `user`; permissions come
from the linked NPM account, never from assertion roles. No account/admin creation.

Flow:
1. Same-origin POST `/api/sso/start` creates random state, PKCE verifier and an
   HttpOnly/Secure/SameSite=Lax `__Host-dci-sso` browser cookie (5 minute lifetime).
2. Browser goes to `https://staff.diamondcrew.net/sso/proxymanager?state=...&code_challenge=...`.
3. Staff returns `/auth/sso/callback?ticket=...&state=...`. Ticket is base64url43.
   React clears the query immediately and POSTs it to `/api/sso/callback`.
4. Server consumes the state once and POSTs `{ticket,audience:'proxymanager',state,code_verifier}`
   with `Authorization: Bearer <redeem_secret>` to the fixed Staff redemption URL.
   HTTPS verification is normal; redirects forbidden; network timeout 10 seconds.
5. Ed25519 signature, local kid allowlist, exact issuer/audience, string DiscordID,
   state, iat/exp (maximum 45 seconds), jti are verified. JTI is consumed with atomic
   exclusive file creation, persisting across restarts. State/PKCE live only in
   the NPM process and invalidate on restart. One backend process is required.
6. `/data/dci-sso/links.json` resolves DiscordID to an existing active NPM user.
   With 2FA enabled, the client receives only an opaque reference to the native
   challenge. `/api/sso/2fa` invokes the native verifier, rechecks the mapping and
   account, then returns the normal NPM token. One attempt per SSO 2FA challenge;
   restart SSO after a wrong code. TOTP and native backup codes are preserved.
7. Frontend uses the existing AuthStore and reloads into normal NPM. Password
   fallback is always available. Unlink blocks new SSO sessions; existing native
   tokens retain upstream expiration/revocation semantics.

Exact issuer: `https://staff.diamondcrew.net` (no trailing slash). Audience:
`proxymanager`. Origin is fixed to `https://proxy.diamondcrew.net`. Redeem sub is
JSON STRING, never a JS number. JWT headers cannot supply a remote key URL.

## Runtime configuration (never commit or bake into image)

Read-only bind-mounted `/run/secrets/dci-sso.json`:

```text
{
  "enabled": true,
  "issuer": "https://staff.diamondcrew.net",
  "audience": "proxymanager",
  "verification_keys": { "<current-kid>": "<Ed25519 SPKI public PEM>" },
  "redeem_secret": "<service-specific runtime secret>"
}
```

`verification_keys` is canonical; multiple current/previous kids support overlap
rotation (max 16). Legacy `kid` + `public_key_pem` is also accepted. Public keys
are provided locally, not fetched. No config or invalid config disables SSO and
leaves password login available. Keep file host permissions 0600 and mount read-only.
No secrets, real Discord links, DB or private keys are present in source.

The only added persistent files are links.json and hashed JTI replay markers under
`/data/dci-sso`. Replay markers are intentionally retained; do not prune while
assertions could still be valid. Config is outside the data volume. Back up the
existing volume and runtime config using the operator's protected backup process.
A process-memory cap bounds pending flows to 1024; expiry removes entries after
five minutes. This is not a distributed rate limiter; ingress rate limiting remains
an operator concern. Outer proxy access logs must redact callback query parameters;
frontend no-referrer and query scrubbing cannot erase an already recorded ingress
log. NPM's internal admin access log is disabled in the stock image.

## Build and CLI (manual, not executed here)

From repository root, use Docker supporting Dockerfile-specific ignore files:

```bash
docker build -f sso/Dockerfile -t diamondcrew-interactive/proxy-manager:2.15.1-sso-local .
docker exec TEST_CONTAINER dci-proxymanager sso link NPM_USER_ID DISCORD_ID
docker exec TEST_CONTAINER dci-proxymanager sso show DISCORD_ID
docker exec TEST_CONTAINER dci-proxymanager sso list
docker exec TEST_CONTAINER dci-proxymanager sso unlink DISCORD_ID
```

CLI uses numeric existing NPM user ID first, DiscordID second. It refuses disabled,
deleted/missing users, malformed IDs and silent replacement of an existing link.
Unlink explicitly before reassignment. Mutation uses a lock directory and atomic
rename; after an interrupted CLI operation, review a remaining `.lock` manually.
CLI uses the actual NPM model/DB configuration and never writes NPM user records.

Do NOT add this to v1.0.0 production publishing. This image adds backend files,
so the reskin-only image-invariants test intentionally does not accept it.

## Local validation and isolated native Docker test

Completed: 11 Node tests using real Ed25519 and live loopback Express requests
with injected broker/NPM doubles; frontend `tsc && vite build`; Chromium login/
callback/2FA/password fallback check with mocked API; syntax checks. No Docker,
real Staff broker or production login was tested locally.

```bash
npm ci --prefix sso --ignore-scripts
npm test --prefix sso
sudo python3 sso/docker-test.py \
  --image diamondcrew-interactive/proxy-manager:2.15.1-sso-local \
  --workdir /var/tmp/dci-npm-sso-test-01
```

Workdir must be new, outside repo and production. Docker test requires local Linux
Docker, no endpoint overrides. It uses fresh data/letsencrypt bind mounts,
`--network none`, NO published ports and a unique owned container. It checks the
actual mounted backend route, creates ONLY synthetic test users, issues real NPM
tokens through the SSO adapter, tests viewer authorization and native 2FA via NPM
API, verifies replay/disabled/unlinked rejection, then removes only its container.
The broker is a local injected signed-assertion adapter; no Staff/Internet calls.
Private logs/data remain outside repo. `report.json` distinguishes native SSO
result, existing-container isolation and the untested real Staff broker.
Root coordinator must run this and a real broker/browser end-to-end test before
accepting SSO for deployment. Never publish its private work directory.

For local browser regression after preparing `.build/sso-frontend`:
`node sso/browser-check.mjs` (root Playwright dependency required).
This integration branch includes `sso/` in the source packaging allowlist.
Installed node_modules and Python caches are excluded; DB/keys/secrets remain forbidden.
Run `python3 scripts/secret-scan.py --gitleaks /usr/local/bin/gitleaks --package`
from the clean candidate checkout to create a scanned source-only ZIP. This does
not authorize publishing that ZIP as a production release.

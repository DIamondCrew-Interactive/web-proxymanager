# DiamondCrew Interactive Proxy Manager 1.1.0 — release preparation

Prepared on integration/central-sso-20260911. Root coordinator owns publication,
main/tag updates, rollout and production acceptance. This task performed none of
those actions. Approved v1.0.0 stays untouched.

## Evidence

The coordinator reported REAL DIA-01 `PROXY_NATIVE_PASS` for:

- Runtime build source: 46fe5ec03c6bc3001443c97d4270f5a6c2f3813d.
- Test runner source: 74a0534825e32be3f339d280da9acfa798047a3b.
- Built image ID: sha256:0665a8fd0d4b0e403699a8f509723e9eec22b2d44c2c98d11598db59a63a6a67.
- Server log: /var/tmp/dci-integration-tests-20260911/proxymanager-retry3.log.
- Fresh private test directory: /var/tmp/dci-npm-sso-test-03.

PASS covers real NPM user-token issuance, identity and permission equivalence
against password login for the same non-admin user, scope/issuer verification,
matching denied admin creation and no inserted admin, native NPM 2FA, replay,
disabled/unlinked rejection. The test uses an isolated container without host
ports or external networking and a local synthetic Staff signing adapter.

**Production Discord/browser end-to-end remains PENDING.** This gate is not
proof of production Staff broker redemption, browser cookies/redirects, real key
provisioning, host-nginx/socket reachability or final ingress configuration.

Local validation: 15 Node tests; 27 Python tests; previous unchanged frontend
build and Chromium UI test; source and Git secret scan. Exact machine-readable
provenance is in release.json. The old passing image keeps its original ID;
version/OCI label changes produce a DIFFERENT final image ID, which must be
recorded by the coordinator. No final release digest is invented here.

## Release delta

The SSO authentication/runtime files are byte-identical to the native-gate-tested
candidate. Release preparation changes only Docker image labels, version/docs,
and the test runner's expected version label. Experimental labeling is removed:
`org.opencontainers.image.version=1.1.0`, `net.diamondcrew.sso=1.1.0`.
NPM remains pinned to 2.15.1 and its exact upstream digest. Root Dockerfile still
builds the separate 1.0.0 reskin; use sso/Dockerfile for 1.1.0.

## Exact candidate build/test (coordinator only)

From the integration checkout at the final handoff commit:

```bash
sudo docker build --target context-check -f sso/Dockerfile \
  -t diamondcrew-interactive/npm-sso-context-check:1.1.0 .
sudo docker build -f sso/Dockerfile \
  -t diamondcrew-interactive/proxy-manager:1.1.0-candidate .
sudo python3 sso/docker-test.py \
  --image diamondcrew-interactive/proxy-manager:1.1.0-candidate \
  --workdir /var/tmp/dci-npm-sso-release-1.1.0-test
```

Use a new workdir. The test now requires the 1.1.0 label; it deliberately rejects
an old experimental-labeled image when validating the final release build.
The root may retag the tested exact image ID for publishing; do not rebuild after
testing. Never overwrite the v1.0.0 tag. No active production workflow is added.

Generate source package (no runtime config/DB/keys/dependencies):

```bash
python3 scripts/secret-scan.py --gitleaks /usr/local/bin/gitleaks --package
```

The final handoff includes the SHA-256 of the locally generated source ZIP. The
ZIP is a source artifact, not proof of production Discord/browser acceptance.

## Runtime configuration and persistence

Mount `/run/secrets/dci-sso.json` read-only with enabled/issuer/audience,
verification_keys (kid -> Ed25519 SPKI PEM) and per-service redeem_secret. See
README.md. Never bake or publish it. Preserve current `/data` and
`/etc/letsencrypt` mounts; added links/replay state lives under `/data/dci-sso`.
No NPM schema migration or user creation is introduced by SSO. Bind an existing
user with `dci-proxymanager sso link NPM_USER_ID DISCORD_ID`.

## Rollback to approved v1.0.0

Before rollout, root must retain a private full backup of current image, actual
EFFECTIVE Compose (all active overrides), inspect, data and letsencrypt. Save the
currently running v1.0.0 IMAGE ID, not a mutable tag. Existing scripts/ops.py
backup intentionally requires the original STOCK image and must not be used as
if it accepts a currently running custom v1.0.0 image.

Prepare a protected rollback Compose from that captured effective configuration:
only replace the app image with the captured v1.0.0 image ID and set pull_policy
never. Keep the same project name, ports, environment, mounts and networks. Retain
any new read-only secret mount during immediate rollback if removing it would
otherwise change configuration; the old image ignores it. Do not restore an old
DB/certificate archive as part of an image rollback.

Concrete rollback commands once root has prepared these protected artifacts:

```bash
sudo docker image load -i /var/backups/diamondcrew-interactive/npm-sso/before-1.1.0/image-1.0.0.tar
sudo docker compose \
  -f /var/backups/diamondcrew-interactive/npm-sso/before-1.1.0/rollback.compose.yaml \
  up -d --no-deps --pull never app
sudo docker exec nginx-proxy-manager_app_1 nginx -t
```

Verify the running image ID matches the captured v1.0.0 ID, mounts are unchanged,
password login works and existing HTTP/HTTPS/WebSocket proxy hosts still work.
Keep SSO links/replay files in place; do not delete volumes, database, certificates
or run `down -v`/global prune. Runtime SSO can also be disabled with enabled=false
in the external config while preserving password fallback (image switch provides
full reskin rollback).

Ingress routing changes are separate from the image. If root applies the prepared
host1/2/6 location plans, roll them back with their per-host guarded API plan
before stopping the broker/socket service. The local ops proposal and protected
host exports are not part of this release/source ZIP. Existing callback access-log
suppression may be retained as a separate reviewed privacy change. Do not use an
image rollback to silently discard unrelated NPM changes made since backup.

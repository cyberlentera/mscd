# Development secrets for the demo and test profiles

Public development values (rule R-11), read by `apps/server/profiles/demo.yaml` and `test.yaml`. Never use them in a real installation; release images and bundles never contain them (R-13).

| File | Value |
|---|---|
| `db-app.url`, `db-migrator.url`, `db-pack.url` | Role URLs of the developer stack (`deploy/compose/dev`, port 55432, database `mscd`) |
| `db-admin.url` | Superuser URL of the developer stack, for `mscd-server db bootstrap` |
| `platform.key`, `storage.key` | Key-encryption keys: 32 random bytes, base64 (F.11) |
| `gateway.token` | Bearer token between the api or worker and the storage gateway (D.5) |
| `s3.access`, `s3.secret` | SeaweedFS identity of the developer stack |
| `keycloak-client.secret` | Secret of the Keycloak client `mscd` in the development realm |

The audit anchor key (`audit-anchor.key`, Ed25519) is added by the work package that signs anchors, together with its key id in `packages/pack-tools/dev-keys/dev-key-ids.json`.

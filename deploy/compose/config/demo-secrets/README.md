# Development secrets of the Compose demo overlay

Public development values (rule R-11), mounted by `docker-compose.demo.yml` in place of the `secrets/` folder that `install.sh` creates for a real installation. Never use them in a real installation; the offline bundle copies `config/` without this folder, and `deploy/scripts/check-release-artefacts.sh` refuses any file whose content equals one of these (R-13).

| File | Value |
|---|---|
| `postgres-admin.password` | PostgreSQL superuser password of the demo database |
| `postgres-roles.env` | Passwords of `mscd_migrator`, `mscd_app` and `mscd_pack_installer`, read once by `config/postgres/10-mscd-bootstrap.sh` |
| `db-migrator.url`, `db-app.url`, `db-pack.url` | Role URLs on the Compose network (`postgres:5432`, database `mscd`), the same passwords as the developer stack |
| `platform.key`, `storage.key`, `gateway.token`, `audit-anchor.key` | The values of `apps/server/test/fixtures/secrets/`; the anchor key is the development key `0abdc91769bacddd` of `packages/pack-tools/dev-keys/` |
| `audit-anchor.pub` | Public half of the anchor key |
| `gateway.token.previous`, `smtp.password` | Empty: no token rotation in progress, Mailpit needs no password |
| `s3.access`, `s3.secret`, `s3.json` | SeaweedFS identity `mscd-dev` (the same as `deploy/compose/dev/seaweedfs/s3.json`) |
| `keycloak-client.secret` | Secret of the Keycloak client `mscd` of the development realm |
| `ca.crt`, `gateway.crt`, `gateway.key`, `api.crt`, `api.key`, `worker.crt`, `worker.key` | A development installation CA (its key was discarded) and the three service certificates (`CN=storage-gateway` with that DNS name, `CN=mscd-api`, `CN=mscd-worker`), valid until 2036. The demo profile runs the gateway with TLS off, so they are mounted only to keep the service secret lists of the on-premise file unchanged |
| `tls/tls.crt`, `tls/tls.key` | Self-signed certificate for `localhost` and `127.0.0.1`, served by the web container on the HTTPS port of the demo |

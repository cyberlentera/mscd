# MSCD developer stack

Third-party services for local development and manual testing: PostgreSQL, an S3-compatible object store (SeaweedFS), Valkey, Keycloak and Mailpit. No MSCD application container runs here. The api, worker and storage-gateway are run modes of `mscd-server` (BUILD-PLAN D-01) that you start on your machine, for example `node apps/server/dist/main.js api` after `npm run build -w @mscd/server`, and they connect to these services through the host ports below. `npm run dev:stack` at the repository root starts the core services of this stack, the same as the first command under [Start and stop](#start-and-stop).

Everything in this folder is for development only. The passwords, keys and the Keycloak realm are public, Keycloak runs in development mode and nothing uses TLS. Never reuse any of these values in a real installation.

## Services

| Service | Image | Host port | Started |
|---|---|---|---|
| `postgres` | `postgres:16.15-alpine` | 55432 | always |
| `objectstore` | `chrislusf/seaweedfs:4.48` | 58333 (S3 API) | always |
| `mailpit` | `axllent/mailpit:v1.31.3` | 51025 (SMTP), 58025 (web UI and API) | always |
| `valkey` | `valkey/valkey:8.1-alpine` | 56379 | profile `bullmq` |
| `keycloak` | `keycloak/keycloak:26.7.5` | 58080 | profile `sso` |

Ports are published on `127.0.0.1` only. The images are the ones pinned in BUILD-PLAN A.3; do not change the tags here without changing the plan.

Requirements: Docker Engine 25 or later and Docker Compose 2.24 or later (the health checks use `start_interval`), and about 2 GB of free memory with Keycloak running.

## Start and stop

Run from the repository root. The Compose project is called `mscd-dev`.

```bash
# Core services: PostgreSQL, object store, Mailpit
docker compose -f deploy/compose/dev/compose.yml up -d --wait

# Everything, including Valkey (BullMQ job driver) and Keycloak (OIDC and SAML)
docker compose -f deploy/compose/dev/compose.yml --profile bullmq --profile sso up -d --wait

# Status and logs
docker compose -f deploy/compose/dev/compose.yml ps
docker compose -f deploy/compose/dev/compose.yml logs -f keycloak

# Stop, keeping the data
docker compose -f deploy/compose/dev/compose.yml --profile bullmq --profile sso down
```

`--wait` returns once every started service reports healthy. Keycloak needs about 30 seconds on the first start.

Profiles have to be named on `down` as well, otherwise Compose leaves the Valkey and Keycloak containers running. To avoid typing them every time, set `COMPOSE_PROFILES=bullmq,sso` in `.env`.

## Settings

Every setting has a default in `compose.yml`. To change one (for example a port that is already taken on your machine), copy `.env.example` to `.env` in this folder and edit it. Compose reads `deploy/compose/dev/.env` also when you start it from the repository root. `.env` is ignored by git.

| Variable | Default | Meaning |
|---|---|---|
| `MSCD_DEV_BIND_ADDRESS` | `127.0.0.1` | Host address for every published port. `0.0.0.0` exposes the stack to your network |
| `MSCD_DEV_POSTGRES_PORT` | `55432` | PostgreSQL |
| `MSCD_DEV_S3_PORT` | `58333` | S3 API |
| `MSCD_DEV_VALKEY_PORT` | `56379` | Valkey |
| `MSCD_DEV_KEYCLOAK_PORT` | `58080` | Keycloak |
| `MSCD_DEV_SMTP_PORT` | `51025` | Mailpit SMTP |
| `MSCD_DEV_MAILPIT_PORT` | `58025` | Mailpit web UI and API |
| `MSCD_DEV_POSTGRES_PASSWORD` | `postgres-dev` | Password of the `postgres` superuser, set when the volume is first created |
| `MSCD_DEV_KEYCLOAK_ADMIN`, `MSCD_DEV_KEYCLOAK_ADMIN_PASSWORD` | `admin`, `admin-dev` | Keycloak administrator |
| `MSCD_DEV_KEYCLOAK_LOG_LEVEL` | `info` | Keycloak log level |

The examples in this README use the default ports.

## PostgreSQL

Database `mscd`. On the first start (empty volume) `postgres/init/00-roles.sql` runs the bootstrap of BUILD-PLAN C.2 with development passwords: the roles below, schema `ext` owned by `mscd_migrator`, extension `pg_trgm` in `ext`, `CREATE` on `public` revoked from everyone, and the per-role settings (`mscd_app` has an empty `search_path`, a 30 second statement timeout and a 60 second idle-in-transaction timeout). Schemas, tables and data come from `mscd-server migrate`, not from this stack.

| Role | Connection string | Server variable (BUILD-PLAN I.1) |
|---|---|---|
| `postgres` (superuser) | `postgres://postgres:postgres-dev@localhost:55432/mscd` | `MSCD_DATABASE_ADMIN_URL` (`db bootstrap` only) |
| `mscd_migrator` | `postgres://mscd_migrator:migrator-dev@localhost:55432/mscd` | `MSCD_DATABASE_MIGRATOR_URL` |
| `mscd_app` | `postgres://mscd_app:app-dev@localhost:55432/mscd` | `MSCD_DATABASE_URL` |
| `mscd_pack_installer` | `postgres://mscd_pack_installer:pack-dev@localhost:55432/mscd` | `MSCD_DATABASE_PACK_URL` |
| `mscd_report` | `postgres://mscd_report:report-dev@localhost:55432/mscd` | none (reporting tools) |

`mscd_report` is created `NOLOGIN`, as in production, where the customer enables it. Its password is already set, so enabling it for local work is one statement:

```bash
docker compose -f deploy/compose/dev/compose.yml exec -T postgres \
  psql -U postgres -d mscd -c 'ALTER ROLE mscd_report LOGIN'
```

A shell with superuser rights:

```bash
docker compose -f deploy/compose/dev/compose.yml exec postgres psql -U postgres -d mscd
```

The init script runs only when the data volume is empty. After changing it, reset the PostgreSQL volume (see [Reset](#reset)). Running it again on an existing database is harmless; `mscd-server db bootstrap` with the admin URL does the same work.

## Object store (S3)

SeaweedFS in single-process mode (`weed mini`). The bucket `mscd-vault` is created at start; data lives in the `s3data` volume.

| Setting | Value |
|---|---|
| Endpoint | `http://localhost:58333` |
| Region | `us-east-1` |
| Path-style addressing | required (`force_path_style: true`) |
| Access key | `mscd-dev` |
| Secret key | `mscd-dev-secret-0123456789` |
| Bucket | `mscd-vault` |
| Permissions of the key | `Admin`, `Read`, `Write`, `List`, `Tagging` (`seaweedfs/s3.json`) |

These map to the `gateway.vault` keys of the deployment profile: `endpoint`, `region`, `bucket`, `force_path_style`, and the files named by `access_key_file` and `secret_key_file`. Requests without a valid signature get 403.

A quick check with curl (7.75 or later):

```bash
curl --aws-sigv4 aws:amz:us-east-1:s3 --user mscd-dev:mscd-dev-secret-0123456789 \
  'http://localhost:58333/mscd-vault?list-type=2'
```

## Valkey

Profile `bullmq`. URL `redis://localhost:56379` (no password), for `jobs.bullmq.url` when `jobs.driver` is `bullmq`. Append-only persistence is on, so queued jobs survive a restart. The default job driver (pg-boss) needs only PostgreSQL.

## Keycloak

Profile `sso`. Stands in for Microsoft Entra ID (OIDC) and AD FS (SAML) during development.

| Item | Value |
|---|---|
| Admin console | `http://localhost:58080/admin/`, user `admin`, password `admin-dev` |
| Realm | `mscd` (`keycloak/realm-mscd.json`) |
| OIDC issuer | `http://localhost:58080/realms/mscd` |
| OIDC discovery | `http://localhost:58080/realms/mscd/.well-known/openid-configuration` |
| OIDC client | `mscd`, confidential, secret `mscd-dev-oidc-secret` |
| SAML IdP metadata | `http://localhost:58080/realms/mscd/protocol/saml/descriptor` |
| SAML IdP entity id | `http://localhost:58080/realms/mscd` |
| SAML SP entity id | `mscd-dev-sp` (the Keycloak client id) |

Users, all with password `Mscd-Demo-2026!` and a verified email. Each has a fixed Keycloak user id, so the OIDC `sub` claim and the SAML persistent NameID are the same on every import:

| Username | Email | User id (OIDC `sub`, SAML NameID) | MSCD account in the demo seed |
|---|---|---|---|
| `rina` | `rina.kusuma@nusantaradigital.co.id` | `00000000-0000-4000-8000-0000000000c1` | yes |
| `bagus` | `bagus.prasetyo@nusantaradigital.co.id` | `00000000-0000-4000-8000-0000000000c2` | yes |
| `maya` | `maya.putri@nusantaradigital.co.id` | `00000000-0000-4000-8000-0000000000c3` | yes |
| `hendra` | `hendra.wijaya@nusantaradigital.co.id` | `00000000-0000-4000-8000-0000000000c4` | yes |
| `sso.only` | `sso.only@mscd.test` | `00000000-0000-4000-8000-0000000000d1` | no (tests the unknown-account error) |

The ids of `rina`, `bagus`, `maya` and `hendra` are the ones G.3 of the build plan names; the demo seed registers them as the subjects of the `keycloak` provider.

OIDC client `mscd`:

- Authorisation code flow with PKCE `S256` required: a request without `code_challenge` is refused.
- Valid redirect URIs and post-logout redirect URIs are `*`, because tests run the server on random ports. This is acceptable only in this development realm.
- Direct access grants (the password grant) are on, for tests and scripts:

  ```bash
  curl -fsS http://localhost:58080/realms/mscd/protocol/openid-connect/token \
    -d grant_type=password -d client_id=mscd -d client_secret=mscd-dev-oidc-secret \
    -d username=rina -d 'password=Mscd-Demo-2026!' -d scope=openid
  ```

- ID tokens, access tokens and userinfo carry `email`, `email_verified` and `amr`. The realm's browser and password-grant flows tag the password step with `pwd` and the one-time-code step with `otp`, so a password sign-in gives `"amr": ["pwd"]` and a user with an OTP credential gets `["pwd", "otp"]`. This matches what Entra ID sends and lets the `require_mfa_claim` and `accepted_amr` settings of an identity provider be tested with real values: `["pwd"]` alone is not MFA proof, `["pwd", "otp"]` is (two values in `accepted_amr`). The seeded users have no OTP credential, so their sign-ins carry no MFA proof.

SAML client `mscd-dev-sp`:

- Valid redirect URIs `*`: Keycloak posts the response to the `AssertionConsumerServiceURL` named in the AuthnRequest.
- The response and the assertion are both signed (RSA-SHA256, exclusive canonicalisation). Assertions are not encrypted.
- AuthnRequests do not have to be signed. The response always uses the HTTP-POST binding.
- NameID format is persistent (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`), forced whatever the AuthnRequest's `NameIDPolicy` asks for. The `email` attribute (basic name format) carries the address.
- The persistent NameID of each realm user is its user id (table above). The realm file sets it through the user attribute `saml.persistent.name.id.for.mscd-dev-sp`, which the admin console and admin API do not show (Keycloak's user profile hides unmanaged attributes). A user created later gets a random `G-<uuid>` NameID on its first SAML sign-in, kept from then on.

Things to know:

- The realm is imported whenever the Keycloak container is created, and the container keeps no volume, so `keycloak/realm-mscd.json` is the single source of truth. Changes made in the admin console survive `docker compose restart` but are lost when the container is recreated. After editing the realm file, run `docker compose -f deploy/compose/dev/compose.yml --profile sso up -d --force-recreate keycloak`.
- The realm sets `sslRequired: none`, so it works over plain HTTP from any address, and brute-force protection is off so tests can fail sign-ins repeatedly.
- When the request host is `localhost` or `127.0.0.1`, Keycloak 26 marks its sign-in cookies `Secure` and `SameSite=None`, even over plain HTTP. Browsers accept such cookies on those hosts. An HTTP client that drives the login form must send them to `http://localhost` too (with `tough-cookie`, keep `allowSecureOnLocal` on, its default), or Keycloak answers "Cookie not found". For any other host name over plain HTTP (for example `keycloak` in the demo overlay), Keycloak sets the cookies without `Secure` and with `SameSite=Lax`, so plain HTTP works there as well.
- Tokens name the issuer by the host the client used. Use `localhost` everywhere (server profile, browser, tests), not `127.0.0.1`, or the issuer check fails.

## Mailpit

Catches every email; nothing is delivered.

| Item | Value |
|---|---|
| SMTP | `localhost:51025`, no TLS; any user name and password, or none, is accepted |
| Web UI | `http://localhost:58025` |
| API | `http://localhost:58025/api/v1/` (for example `GET /api/v1/messages`, `DELETE /api/v1/messages` to empty the inbox) |

Profile settings for the server: `mail.smtp.host: localhost`, `mail.smtp.port: 51025`, `mail.smtp.secure: false`. Messages are kept in the `mailpit-data` volume (at most 5000; the oldest are dropped first).

## Reset

Named volumes, prefixed with the project name: `mscd-dev_pgdata`, `mscd-dev_s3data`, `mscd-dev_valkey-data`, `mscd-dev_mailpit-data`.

Remove the containers and all data, then start again from empty:

```bash
docker compose -f deploy/compose/dev/compose.yml --profile bullmq --profile sso down -v
docker compose -f deploy/compose/dev/compose.yml --profile bullmq --profile sso up -d --wait
```

Reset one service only, for example PostgreSQL after editing the init script:

```bash
docker compose -f deploy/compose/dev/compose.yml rm -sf postgres
docker volume rm mscd-dev_pgdata
docker compose -f deploy/compose/dev/compose.yml up -d --wait postgres
```

Keycloak has no volume; recreating the container resets it (see [Keycloak](#keycloak)).

## Troubleshooting

- "port is already allocated": another program uses the port. Pick a free one in `.env` and use it in your connection strings.
- A service stays unhealthy: `docker compose -f deploy/compose/dev/compose.yml ps` shows which, and `logs <service>` shows why. `docker inspect --format '{{json .State.Health}}' mscd-dev-<service>-1` prints the last health check results.
- The roles are missing: the PostgreSQL volume was created before the init script existed, or by another project. Reset the PostgreSQL volume.
- Containers of an earlier run are still there after a plain `down`: name the profiles on `down` too, or set `COMPOSE_PROFILES`.

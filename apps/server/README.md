# @mscd/server

The MSCD server (`mscd-server`): a NestJS modular monolith on Fastify with the run modes `api`, `worker`, `storage-gateway` and `migrate`, plus admin commands (build plan B.4, D-01, D.4). CommonJS, TypeScript.

## Commands

| Command | What it does |
|---|---|
| `npm run build -w @mscd/server` | Writes `src/generated/build-info.ts`, then `tsc -b tsconfig.build.json` (also builds `@mscd/shared` and `@mscd/pack-tools`) into `dist/` |
| `npm run typecheck -w @mscd/server` | Type-checks `src`, `test` and the Vitest configurations |
| `npm test -w @mscd/server` | Unit tests (`test/unit`, no database) |
| `npm run test:int -w @mscd/server [-- <path>]` | Integration tests (`test/int`) against PostgreSQL in a container; needs Docker |
| `npm run start -w @mscd/server` | `node dist/main.js api` |
| `npm run seed:demo -w @mscd/server` | Bootstrap, migrate and seed demo data (`scripts/seed-demo.mjs`) |
| `node apps/server/dist/main.js --help` | Every command |

## Layout

| Path | Content |
|---|---|
| `src/main.ts`, `src/program.ts` | Command line; each `src/cli/*.ts` exports `register(program)` |
| `src/app/` | Root modules per run mode: `api.module.ts`, `worker.module.ts`, `gateway.module.ts` |
| `src/config/` | Deployment profile schema (strict zod), YAML loader, `MSCD__A__B` overrides, secrets, `MscdConfig` |
| `src/db/` | Kysely factory, `DatabaseModule`, SQL file migration provider, migrator, bootstrap |
| `src/modules/<name>/` | One Nest module per area with a short README naming its owner |
| `src/gateway/`, `src/worker/`, `src/seed/` | Storage gateway, worker runtime, demo seed |
| `src/generated/` | `build-info.ts` (git-ignored, written by `scripts/gen-build-info.mjs`) |
| `migrations/` | `bootstrap/` (roles), `platform/`, `ref/`, `tenant/` (`NNNN_name.sql`, forward only) |
| `profiles/` | `onprem.yaml`, `saas.yaml` (release), `demo.yaml`, `test.yaml` (development flavour only) |
| `test/setup/` | Global database setup, per-file test databases (`useTestDatabase`), Keycloak setup |
| `test/fixtures/secrets/` | Public development secrets used by the demo and test profiles |

## Configuration

`MSCD_PROFILE_FILE` names the profile. `MSCD__<SECTION>__<KEY>=<YAML value>` overrides a key (for example `MSCD__HTTP__PORT=3001`, `MSCD__OBSERVABILITY__METRICS_PORT=null`). `MSCD_DATABASE_URL`, `MSCD_DATABASE_MIGRATOR_URL`, `MSCD_DATABASE_PACK_URL` and `MSCD_DATABASE_ADMIN_URL`, or their `_FILE` forms, win over the profile's `database.*_file` entries. Relative paths in a profile resolve against the folder of the profile file. An invalid profile stops the process with a list of every problem.

## Build flavours

`MSCD_BUILD_FLAVOR=dev` (default) or `release`, read at build, typecheck and test time by `scripts/gen-build-info.mjs`. Release builds take the trusted Ed25519 keys from `MSCD_TRUSTED_KEYS_DIR` (`licence-*.pub`, `pack-*.pub`, `anchor-*.pub`) and refuse development keys, demo mode, `test.*` keys, insecure OIDC and gateway TLS `off`.

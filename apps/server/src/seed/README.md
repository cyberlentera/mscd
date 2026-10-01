# demo seed

`mscd-server seed demo [--reset] [--keys auto|gateway|local]` (build plan D-01, section G). Development flavour with
`demo.enabled` only. Owner: WP-14.

The seed writes the four demo organisations (`ndt`, `bsd`, `rmn`, `tst`), their users, licences, packs and every
sample record of the web prototype, so the platform shows the same numbers as the sample. It runs as `mscd_migrator`
with platform scope; packs are installed as `mscd_pack_installer`.

| File | Content |
|---|---|
| `seed-demo.ts` | `seedDemo(config, options)`: demo mode check, "already seeded" marker (`platform.system_setting` key `demo.seed`), `--reset` (`resetDemo`), refusal over an interrupted run, packs from `packs.dir`, pack install dates and catalogue entries, development licences (`verifyDemoLicence`), users with password and TOTP, organisations through `TenantProvisioner`, repositories with sealed credentials, the Keycloak provider with its subjects when `demo.keycloak` is set, then `writeOrganisation` per organisation |
| `org-writer.ts` | `writeOrganisation(trx, input)`: everything inside one organisation in one transaction (G.6): memberships, licence, repositories, routing, management systems and their display values, cycles, documents, chain records, applicability, evidence, activities, audits, findings, drift, trace chains, the external auditor grant |
| `plan.ts` | `planChainRecords(input)`: chain records per stage (G.7): open records of `X`, ready records named elsewhere in the sample, then numbered fillers with the stage prefix; stops on unknown codes, too many records and duplicate codes |
| `people.ts` | Organisations with fixed ids, the user list (G.3) with memberships and roles, the demo password, the TOTP secret rule, Keycloak subjects |
| `ref-data.ts` | Pack per system (`SYSTEM_PACKS`), the six demo packs, `loadVersionContent` (catalogue, requirements, chain stages, drift rules, activity templates, cycle definitions, document types of a framework version) |
| `snapshot.ts` | Types of `demo/sample-snapshot.json` and `loadSampleSnapshot()` (the copy next to the built module first, then the source tree) |
| `key-service.ts` | `SeedKeyService`: data keys and credential sealing through the storage gateway (`GatewayKeyService`) or in process from `gateway.kms.file` (`LocalKeyService`); `chooseKeyService` for `--keys` |
| `demo-key.ts` | The private key of the demo Microsoft 365 app certificate, derived from a fixed label (no key file in the repository); checked against the certificate |
| `demo/sample-snapshot.json` | Written by `apps/web/scripts/export-sample-snapshot.mjs` from the web sample data (G.2); `--check` fails when it is out of date |

Related files owned by WP-14: `apps/server/src/cli/seed.ts`, `apps/web/scripts/export-sample-snapshot.mjs`,
`tools/mock-providers/fixtures/demo.json` (provider state of G.8, written by the export script),
`tools/scripts/ensure-built.mjs`, the demo template in `apps/server/test/setup/global-db.ts` and the tests in
`apps/server/test/int/seed`.

Change the sample in `apps/web/src/data`, then run `node apps/web/scripts/export-sample-snapshot.mjs` and commit both
generated files. The demo template of the integration tests (`useTestDatabase('demo')`) is this seed run against the
test profile.

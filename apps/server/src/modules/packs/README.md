# packs module

Framework pack installation with compiled trust anchors, the pack lifecycle and the pack routes (E.8, D-16, D-17, TS 6.3).

- `pack-verification.ts`: E.8 steps 1 to 3 (archive rules, signature, checksums, datasets through `@mscd/pack-tools`, engine version, chain entity types), and the api's import check, which refuses more than 16 MiB decompressed after decompressing off the event loop.
- `pack-installer.ts`: `PackInstaller` (steps 4 and 5) on a connection of role `mscd_pack_installer`; used by `migrate` (C.3 step 5), `mscd-server packs install` and the `pack.install` job. A lower version than the installed one is refused, except in `migrate`, which skips it.
- `pack-installer.service.ts`: the lazily opened installer pool and the installer for Nest.
- `pack-bundle-store.ts`: where an imported bundle waits for the job (Managed Vault through the gateway, else a local temporary file, which only a job of the in-memory queue in the same process can read; with a separate worker such an import answers 503).
- `packs.service.ts`, `packs.controller.ts`: `GET /admin/packs`, `POST /admin/packs/import`, `POST /admin/packs/check-updates`.
- `pack-lifecycle.service.ts` and the jobs `pack.install`, `packs.lifecycle`, `edition.withdrawn-alerts`.
- `install-from-dir.ts`: installs every pack file of a folder (`migrate`) or one file (the command line).

Owner: WP-12.

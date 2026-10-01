# Development keys

These Ed25519 key pairs are for development, tests and the demo only. They are public: anyone can read the private keys in this folder, so nothing signed with them proves anything. Never use them for a customer installation, a release image or the offline bundle.

| Files | Key id | Signs | Used by |
|---|---|---|---|
| `pack-signing.key`, `pack-signing.pub`, `pack-dev.pub` | `f4c7f82942491de1` | Framework packs (`manifest.json` of each `.pack`) | `mscd-pack build-all` for `packs/dist`, the demo image, tests |
| `licence-signing.key`, `licence-signing.pub`, `licence-dev.pub` | `f83c3c5b683ceb05` | Licences (`../dev-licences/*.json`) | Demo seed, tests |
| `anchor-signing.key`, `anchor-signing.pub`, `anchor-dev.pub` | `0abdc91769bacddd` | Audit chain anchors | Worker in development and tests |

- `*.key` is the private key (PKCS#8 PEM), `*.pub` the public key (SPKI PEM). The key id is the first 16 hexadecimal characters of the SHA-256 of the public key in DER form (build plan E.8).
- The `<kind>-dev.pub` files are copies of the `<kind>-signing.pub` files. `apps/server/scripts/gen-build-info.mjs` compiles every `licence-*.pub`, `pack-*.pub` and `anchor-*.pub` of this folder into a development build as trusted keys (D-16); a key under two names is listed once.
- `dev-key-ids.json` lists the three key ids. `DEV_KEY_IDS` of `@mscd/pack-tools` reads it. A release build refuses these ids: `gen-build-info.mjs` fails when the trusted keys folder holds one of them, `mscd-pack build-all --reject-dev-keys` (the release pack signing step) refuses to sign with them, and the server rejects packs and licences signed with them (build plan D-16, R-13).
- Release keys are generated outside the repository with `mscd-pack keygen --out <dir> --name pack-<name>` (and `licence-<name>`, `anchor-<name>`) and given to the release build as the `trusted-keys` folder and the `pack_signing_key` secret.

To replace the development keys, run `mscd-pack keygen --force` for each pair, copy the new `*-signing.pub` files to the `*-dev.pub` names, write the new ids into `dev-key-ids.json`, sign the development licences again (see `../README.md`) and rebuild `packs/dist`.

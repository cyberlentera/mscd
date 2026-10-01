# @mscd/pack-tools

Framework pack and licence tooling with the CLI `mscd-pack` (build plan E.8, D-15, D-16). WP-09 implements the pack builder, the archive rules, signing and verification, the development keys in `dev-keys/` and the development licences. This skeleton holds the package setup, the key id rule and `DEV_KEY_IDS`.

| Command | What it does |
|---|---|
| `npm run build -w @mscd/pack-tools` | Compiles `src` to `dist` (also builds `@mscd/shared`, a project reference) |
| `npm run typecheck -w @mscd/pack-tools` | Type-checks `src` and `test` |
| `npm test -w @mscd/pack-tools` | Unit tests in `test/` (`@mscd/shared` is read from source) |
| `node packages/pack-tools/dist/cli.js --help` | CLI help |

`keyId(publicKey)` returns the first 16 hexadecimal characters of the SHA-256 of the public key in DER (SPKI) form. `DEV_KEY_IDS` is read from `dev-keys/dev-key-ids.json` (empty until WP-09 creates it).

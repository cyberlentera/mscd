# Repository scripts

Plain Node scripts (no dependencies) used by the root scripts, CI and tests.

| Script | Use |
|---|---|
| `check-text.mjs <folder or file>...` | Fails when a file contains an em dash (U+2014) or a centre dot (U+00B7), printing file, line and column (`npm run check:text` checks `docs`) |
| `demo-totp.mjs <handle>` | Prints the current TOTP code of a demo or test user (build plan G.3). `--secret` prints the base32 secret, `--time <unix seconds>` computes the code for another time, `--self-test` checks the RFC 6238 vectors |

`ensure-built.mjs` (WP-14) builds `@mscd/shared`, `@mscd/pack-tools` and the development packs when they are missing or stale. The scripts are tested by `apps/server/test/unit/tools`.

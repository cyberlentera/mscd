# @mscd/shared

The shared contract of the MSCD platform: zod schemas, enums, the API route table, the authorisation matrix and the OpenAPI generator (build plan D.1, D.2, F.6). WP-05 writes the contract; this skeleton holds the package setup.

| Command | What it does |
|---|---|
| `npm run build -w @mscd/shared` | Compiles `src` to `dist` (ES module with type declarations) |
| `npm run typecheck -w @mscd/shared` | Type-checks `src` and `test` |
| `npm test -w @mscd/shared` | Unit tests in `test/` |
| `npm run openapi -w @mscd/shared` | Builds, then writes `dist/openapi.json` |

The package is an ES module. The server (CommonJS) loads it with `require()`, which Node 22.12 and later support. During development no build is needed: Vitest configurations alias `@mscd/shared` to `src/index.ts`, and the TypeScript configurations of the other workspaces resolve the export condition `@mscd/source` to the same file. Runtime code (`node apps/server/dist/main.js`) uses `dist`, which `npm run build -w @mscd/server` builds first through its project references.

# @mscd/mock-providers

Local stand-ins for the Microsoft identity platform, Microsoft Graph and Google Drive APIs that MSCD calls (build plan J.7 and D.5). Used by the adapter tests, the API E2E stack and the demo Compose overlay; never part of a release. WP-10 implements the endpoints, fixtures and fault switches; this skeleton answers `GET /_admin/health` and `POST /_admin/reset`.

| Command | What it does |
|---|---|
| `npm run build -w @mscd/mock-providers` | Compiles `src` to `dist` |
| `npm test -w @mscd/mock-providers` | Unit tests in `test/` |
| `node tools/mock-providers/dist/server.js --port 4310 --fixtures <file>` | Starts the server |

In-process use: `startMockProviders({port: 0, fixtures})` returns `{app, url, close}`.

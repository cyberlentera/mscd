# @mscd/mock-providers

Local stand-ins for the provider APIs MSCD calls (build plan J.7 and D.5): the Microsoft identity platform token endpoint, the Microsoft Graph drive item API, and the Google OAuth 2.0 and Drive v3 APIs. The storage adapter tests (WP-13, WP-15), the API E2E stack (WP-27) and the demo Compose overlay (WP-28) run against it. It is test and demo software: state lives in memory, the admin API has no authentication, and it is never part of a release or the offline bundle.

| Command | What it does |
|---|---|
| `npm run build -w @mscd/mock-providers` | Compiles `src` to `dist` |
| `npm test -w @mscd/mock-providers` | Unit tests in `test/` |
| `node tools/mock-providers/dist/server.js --port 4310 --fixtures <file>` | Starts the server (`--host`, default `0.0.0.0`; `--public-url`; `--verbose` prints one line per request) |
| `node tools/mock-providers/dist/server.js --fixtures demo` | Loads `fixtures/demo.json` (written by the seed export, WP-14); any name without `/` or `.json` is looked up in `fixtures/` |
| `node tools/mock-providers/dist/server.js --port 0 --self-test` | Starts on a free port, runs a token, list and upload round trip for Microsoft 365 and Google Drive, exits 0 or 1 |

In-process use:

```ts
import { startMockProviders } from '@mscd/mock-providers';

const mock = await startMockProviders({ port: 0, fixtures }); // { app, url, port, close }
// graph_base_url = `${mock.url}/v1.0`, login_base_url = mock.url,
// google api_base_url = mock.url, token_url = `${mock.url}/token`
await mock.close();
```

`buildMockProviders(options)` returns the Fastify application without listening (for `app.inject`). Options: `fixtures` (a parsed fixture document), `publicUrl` (origin written into generated links, default the request's Host), `settings`, `onRequestLog`. The package also exports `quickXorHash` and `QuickXorHash`, `hashContent`, `createSelfSignedCertificate`, `inspectCertificate`, `createM365ClientAssertion`, `createGoogleServiceAccountAssertion`, `parseFixtureDocument`, `runSelfTest`, `GRAPH_ID_PATTERN` and `DRIVE_ID_PATTERN`.

## Base URLs

One server answers all APIs on the real paths, matching the development profiles (`apps/server/profiles/{demo,test}.yaml`):

| API | Mock path | Real host |
|---|---|---|
| Microsoft identity token | `POST /{tenant}/oauth2/v2.0/token` | `login.microsoftonline.com` |
| Microsoft Graph | `/v1.0/...` | `graph.microsoft.com` |
| Google OAuth token, revoke | `POST /token`, `POST /revoke` | `oauth2.googleapis.com` |
| Google consent page | `GET /o/oauth2/v2/auth` | `accounts.google.com` |
| Google Drive | `/drive/v3/...`, `/upload/drive/v3/...` | `www.googleapis.com` |
| Generated URLs | `/_upload/graph/{id}` (upload session), `/_monitor/{id}` (copy), `/_download/{token}` (pre-authenticated download) | provider hosts |
| Admin | `/_admin/...` | none |

## Endpoints

Token endpoints:

- Microsoft: `grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`, a certificate client assertion (`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`). The JWT must be RS256 or PS256, name a certificate registered for the app in its header (`x5t#S256`, or the older `x5t`), carry `iss` = `sub` = client id, `aud` = the token URL it was sent to (or `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`), `exp` and `jti`, and be inside its validity window (five minutes of skew). The tenant in the URL may be the tenant id or a registered alias. Errors use the Entra form (`error`, `error_description` with the AADSTS code, `error_codes`, `timestamp`, `trace_id`, `correlation_id`).
- Google: `urn:ietf:params:oauth:grant-type:jwt-bearer` with a service account JWT (RS256, `iss` = client email, `aud` = the token URL or `https://oauth2.googleapis.com/token`, `scope`, at most one hour between `iat` and `exp`, `kid` checked when the key was registered with `privateKeyId`, optional `sub` for domain-wide delegation); `refresh_token` and `authorization_code` (with PKCE `S256` or `plain`) for registered OAuth clients, client credentials in the body or as HTTP Basic. `GET /o/oauth2/v2/auth` signs in `login_hint` (or the client's `defaultAccount`) without a page and redirects to the registered `redirect_uri` with `code`, `scope` and `state`.
- Tokens are opaque, last `tokenLifetimeSeconds` (3599), and work only on the API of the endpoint that issued them. Drive calls need a Drive scope.

Microsoft Graph (drive and item ids must match `^[A-Za-z0-9!_-]+$`, otherwise 400 `invalidRequest`):

| Call | Notes |
|---|---|
| `GET /v1.0/drives/{drive}` | `driveType`, `owner`, `quota` |
| `GET .../root`, `.../items/{id}`, `.../root:/{path}`, `.../items/{id}:/{relative path}` | `root` is an alias of the root id; names compare case-insensitively; `$select` supported |
| `GET .../children` | Paged by `$top` (default 200) with `@odata.nextLink` |
| `POST .../children` | Folder (`{"name", "folder": {}}`), `@microsoft.graph.conflictBehavior` `fail` (default), `rename`, `replace` |
| `PATCH .../items/{id}`, `DELETE .../items/{id}` | Rename, move (`parentReference.id`), description |
| `GET .../versions`, `.../versions/{id}`, `.../versions/{id}/content` | Newest first; version ids `1.0`, `2.0`, ...; `current` alias |
| `GET .../content` | 302 to a pre-authenticated download URL (also `@microsoft.graph.downloadUrl` on files) |
| `PUT .../items/{parent}:/{name}:/content`, `PUT .../items/{id}/content` | Simple upload up to 4 MiB (413 above); missing parent folders on the path are created; conflict default `replace` (new version) |
| `POST .../items/{parent}:/{name}:/createUploadSession`, `POST .../items/{id}/createUploadSession` | `uploadUrl` takes `PUT` fragments with `Content-Range`; every fragment but the last a multiple of 320 KiB, at most 60 MiB, in order (416 otherwise), no `Authorization` header (401); `GET` status, `DELETE` cancels; conflict default `fail` |
| `POST .../items/{id}/copy` | 202 with `Location` of a monitor; the monitor answers `inProgress` for `copyPendingPolls` polls (1), then performs the copy and answers `completed` with `resourceId`, or `failed` (`nameAlreadyExists`) |

Items carry `id`, `name`, `size`, `eTag`, `cTag`, `createdDateTime`, `createdBy.user {displayName, email, id}` (an app upload shows `createdBy.application`), `lastModifiedDateTime`, `lastModifiedBy`, `parentReference {driveType, driveId, id, path}` (`path` is percent-encoded, `/drives/{drive}/root:/A/B`), `file {mimeType, hashes {quickXorHash}}` or `folder {childCount}`, `webUrl`, `fileSystemInfo`, `description`. quickXorHash is computed from the content (Microsoft's algorithm, `src/quickxor.ts`).

Google Drive v3 (file, drive and revision ids must match `^[A-Za-z0-9_-]+$`, otherwise 400 `invalid`):

| Call | Notes |
|---|---|
| `GET /drive/v3/files/{id}` | `alt=media` downloads binary files (403 `fileNotDownloadable` for Docs, Sheets, Slides) |
| `GET /drive/v3/files` | `q` subset: `'<id>' in parents`, `name =`, `name !=`, `name contains`, `mimeType =`, `mimeType !=`, `trashed = true or false`, joined by `and`, with parentheses (`or` and `not` answer 400); `corpora=drive&driveId=` needs `includeItemsFromAllDrives` and `supportsAllDrives`; `pageSize` (default 100) and `nextPageToken` |
| `POST /drive/v3/files` | Metadata only (folders) |
| `PATCH /drive/v3/files/{id}`, `DELETE /drive/v3/files/{id}` | `name`, `description`, `trashed`; moves with `addParents` and `removeParents` |
| `POST /drive/v3/files/{id}/copy` | Synchronous |
| `GET /drive/v3/files/{id}/revisions`, `GET` and `PATCH .../revisions/{revision}` | `keepForever` for binary files; `alt=media` on a revision |
| `GET /drive/v3/drives/{drive}`, `GET /drive/v3/about?fields=...` | `fields` is required on `about` |
| `POST /upload/drive/v3/files?uploadType=media,multipart,resumable` and `PATCH /upload/drive/v3/files/{id}?uploadType=...` | Resumable: the `Location` session URL takes `PUT` chunks with `Content-Range` (multiples of 256 KiB except the last), answers 308 with `Range` until complete, `bytes */N` asks for the status, `DELETE` cancels (499) |

Behaviour kept from the real API because adapters depend on it: responses hold only the default fields (`kind,id,name,mimeType` for files) unless `fields` asks for more; shared drive items answer 404 without `supportsAllDrives=true`; `size` and `version` are strings; `md5Checksum`, `sha256Checksum` and `headRevisionId` exist only for binary files; `owners` only outside shared drives, naming the account that created or uploaded the file (a fixture item without a `createdBy` email shows the drive owner); shared drive files name their creator through `lastModifyingUser` of the first revision; a My Drive answers only its owner and the accounts in its `allowedPrincipals` (`files.get`, `alt=media` and every other call by id give 404 `notFound` to anyone else, and `files.list` leaves it out); a file without `parents` goes to the caller's My Drive, which exists only when a `my_drive` fixture is owned by the caller. Every Drive id in a request (path, `addParents`, `removeParents`, `driveId`, ids in `q`, and the file id of a resumable session URL) is checked against `^[A-Za-z0-9_-]+$` before anything else and answered 400 when it fails.

Errors use each API's documented envelope: Graph `{error: {code, message, innerError}}`, Google `{error: {code, message, errors: [{message, domain, reason, location?, locationType?}]}}`, OAuth `{error, error_description}`. `test/shapes.test.ts` compares every response type with documented example payloads (`test/fixtures`, see its README).

## Admin API and fault switches

| Request | Effect |
|---|---|
| `GET /_admin/health` | `{status: "ok"}` |
| `POST /_admin/reset` | Clears everything (state, tokens, faults, settings, request log) and loads the base fixtures; with a fixture document as body, that document becomes the base |
| `POST /_admin/fixtures` | Merges a fixture document into the running state, all or nothing: ids are checked first, then the drives, folders and files are tried on a copy of the state, so any conflict (an id in use, a Graph name clash, a file where a folder path goes) changes nothing and answers 400 with the list of problems |
| `GET /_admin/state`, `GET` and `POST /_admin/settings` | Summary; settings `tokenLifetimeSeconds`, `graphSimpleUploadMaxBytes`, `copyPendingPolls`, `graphPageSize`, `drivePageSize` |
| `POST /_admin/credentials`, `GET /_admin/credentials` | Registers one credential, a list, or `{credentials: [...]}` (same shapes as in fixtures); the listing shows no secrets |
| `POST /_admin/oauth/codes` | `{clientId, redirectUri, account: {email, displayName?}, scope?, codeChallenge?, codeChallengeMethod?, offline?}` gives `{code}` for the code exchange without the consent page |
| `POST /_admin/items`, `GET /_admin/items/{id}` | Creates a file as a fixture item (`driveId` plus the fields of a fixture file, for example a zero-transit upload with `createdBy` and a correlation code in the name; in a My Drive, `createdBy` becomes `owners`), all or nothing like a fixture merge; shows an item with all versions and hashes |
| `POST /_admin/items/{id}/move` | `{parentId}` or `{path}` (created when missing), optional `name`; without a body the item moves to a subfolder `Moved` of its folder |
| `POST /_admin/items/{id}/new-version` | New current version (`content` or `contentBase64`, `versionId`, `modifiedAt`, `modifiedBy`); older versions stay listed |
| `POST /_admin/items/{id}/delete` | Removes the item (404 afterwards); `{"mode": "trash"}` trashes a Drive file instead |
| `POST /_admin/items/{id}/purge-version` | `{versionId}` removes one older version; without a body every version but the current one |
| `POST /_admin/items/{id}/corrupt-hash` | Changes the content and hashes of the current version without a new version id |
| `POST /_admin/drives/{id}/forbid` | Every request touching the drive answers 403 (`{forbidden: false}` restores) |
| `POST /_admin/tokens/revoke` | Revokes issued access tokens and disables the credentials, so token requests fail too (`invalid_client` or `invalid_grant`); narrow with `clientId`, `clientEmail` or `refreshToken`; `{accessTokensOnly: true}` keeps the credentials |
| `POST /_admin/throttle` | `{count, retryAfterSeconds?, status?: 429 or 503, apis?}`: the next `count` provider requests answer with `Retry-After` (`apis` from `graph`, `drive`, `identity`; default `graph` and `drive`); `count: 0` switches it off |
| `POST /_admin/latency` | `{ms, apis?}` delays provider responses; `ms: 0` switches it off |
| `GET /_admin/requests`, `DELETE /_admin/requests` | Provider request log (`?api=`, `?since=<seq>`): method, URL, status, duration, principal, whether an `Authorization` header was sent |

## Fixture format

A fixture document is JSON (`fixtures/example.json` shows every situation of G.8). Unknown keys are errors, ids must match the D.5 patterns, and every problem is reported with its path.

```jsonc
{
  "version": 1,
  "description": "optional",
  "settings": { "copyPendingPolls": 0 },
  "credentials": [
    { "kind": "m365_certificate", "tenantId": "<guid>", "clientId": "<app id>", "certificatePem": "-----BEGIN CERTIFICATE-----...", "displayName": "MSCD", "tenantAliases": ["contoso.onmicrosoft.com"] },
    { "kind": "google_service_account", "clientEmail": "sa@project.iam.gserviceaccount.com", "publicKeyPem": "...", "privateKeyId": "optional kid" },
    { "kind": "google_oauth_client", "clientId": "...", "clientSecret": "...", "redirectUris": ["https://..."], "defaultAccount": { "email": "...", "displayName": "..." } },
    { "kind": "google_refresh_token", "clientId": "...", "refreshToken": "...", "account": { "email": "..." }, "scope": "https://www.googleapis.com/auth/drive.file", "revoked": true }
  ],
  "m365": { "drives": [ {
    "id": "drive-sp-compliance", "name": "Compliance", "driveType": "documentLibrary | business | personal",
    "tenantId": "<guid>", "rootId": "optional", "webUrl": "https://.../Shared%20Documents",
    "owner": { "displayName": "...", "email": "..." }, "forbidden": false, "allowedPrincipals": ["<client id>"],
    "folders": [ { "id": "01...", "path": "Compliance/ISMS" } ],
    "items": [ {
      "id": "01...", "path": "Compliance/ISMS/Evidence/2026/Q3", "name": "Backup-Job-Log-Sep-2026.xlsx",
      "mimeType": "optional, from the extension", "description": "...", "createdAt": "2026-09-28T01:00:00Z",
      "createdBy": { "displayName": "Bagus Prasetyo", "email": "..." },
      "versions": [ { "id": "1.0", "content": "text", "modifiedAt": "...", "modifiedBy": { "displayName": "..." } },
                    { "id": "2.0", "contentBase64": "...", "quickXorHash": "declared value" } ]
    } ]
  } ] },
  "google": { "drives": [ { "id": "drive-gd-bcms", "kind": "shared_drive | my_drive", "rootId": "my_drive only", "...": "as above" } ] }
}
```

- `path` is the folder path from the drive root; missing folders are created with ids derived from the drive and path, so they stay the same across resets. `folders` gives a folder an explicit id. `parentId` may replace `path`.
- Without `versions`, the fields `versionId`, `content` or `contentBase64`, `size`, `quickXorHash`, `sha256`, `md5`, `modifiedAt` and `modifiedBy` describe a single version. The last version is the current one.
- A version without content gets `size` (default 1024) deterministic bytes. Declared hash values are reported as given, even when they do not match the content, so a fixture can mirror stored hashes exactly; `quickXorHash()` computes the value for a given content.
- `allowedPrincipals` limits a drive to client ids (Graph) or account emails (Drive); on a `my_drive` it names the accounts besides the owner that may use it (absent: the owner only). `tenantId` refuses tokens of other tenants; `forbidden: true` makes every request answer 403.
- Google Workspace files (`application/vnd.google-apps.*`) have numeric revision ids and no checksums.

No private key is stored in this package (rule R-11): tests and the self-test create certificates and keys at run time with `createSelfSignedCertificate`, and fixtures carry only certificates and public keys.

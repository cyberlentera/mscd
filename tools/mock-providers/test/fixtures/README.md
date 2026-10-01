# Recorded API examples

The unit tests in `test/shapes.test.ts` compare the mock's responses with these documented payloads (build plan J.7): every field the mock sends must exist in the documented example or in the documented resource, with the same JSON type, and every field of the example must be present unless the test names it as not modelled. Retrieved on 1 Oct 2026.

## Microsoft (copied from the documentation sources)

The Microsoft Graph and Microsoft identity platform pages are published from public GitHub repositories. The JSON blocks below were copied unchanged from the example responses on those pages.

| File | Source page |
|---|---|
| `graph/driveitem-get-root.json` | Graph v1.0 "Get a driveItem" (`api-reference/v1.0/api/driveitem-get.md` in microsoftgraph/microsoft-graph-docs-contrib) |
| `graph/driveitem-post-children.json` | "Create a new folder" (`driveitem-post-children.md`) |
| `graph/driveitem-list-children.json` | "List the contents of a folder" (`driveitem-list-children.md`), a truncated example |
| `graph/driveitem-list-versions.json` | "List versions of a driveItem" (`driveitem-list-versions.md`) |
| `graph/driveitemversion-get.json` | "Get a driveItemVersion resource" (`driveitemversion-get.md`) |
| `graph/drive-get.json` | "Get Drive" (`drive-get.md`) |
| `graph/uploadsession-create.json`, `graph/uploadsession-progress.json`, `graph/uploadsession-complete.json` | "driveItem: createUploadSession" (`driveitem-createuploadsession.md`) |
| `graph/copy-monitor-completed.json`, `graph/copy-monitor-failed.json` | "driveItem: copy" (`driveitem-copy.md`) |
| `graph/error.json` | "Microsoft Graph error responses and resource types" (`concepts/errors.md`) |
| `graph/error-throttling.json` | "Microsoft Graph throttling guidance" (`concepts/throttling.md`) |
| `graph/resource-properties.json` | Property names from the "JSON representation" sections of the resource pages `driveitem`, `file`, `folder`, `filesysteminfo`, `identityset`, `identity`, `itemreference`, `hashes`, `driveitemversion`, `drive`, `quota` and `uploadsession` |
| `identity/entra-token-response.json`, `identity/entra-token-error.json` | Microsoft identity platform "OAuth 2.0 client credentials flow" (`docs/identity-platform/v2-oauth2-client-creds-grant-flow.md` in MicrosoftDocs/entra-docs) |

## Google

| File | Source |
|---|---|
| `google/drive-v3-schemas.json` | The `File`, `FileList`, `Revision`, `RevisionList`, `Drive`, `About` and `User` schemas of the official Drive API v3 discovery document (`https://www.googleapis.com/discovery/v1/apis/drive/v3/rest`, revision 20260927), reduced to property names, types and formats |
| `google/error-not-found.json`, `google/error-rate-limit.json`, `google/error-auth.json` | Examples of "Resolve errors" in the Drive API guides |
| `google/token-service-account.json` | "Using OAuth 2.0 for Server to Server Applications", access token response |
| `google/token-refresh.json`, `google/token-authorization-code.json`, `google/token-error.json` | "Using OAuth 2.0 for Web Server Applications", refresh and code exchange responses and the revoked token error |

The Google guide pages (developers.google.com) cannot be reached from the build sandbox, so the Google example payloads were written out from the published examples instead of being downloaded; the discovery document was downloaded. A reviewer with access can compare them with the pages named above.

## quickXorHash vectors

`quickxorhash-rclone-vectors.json` holds the 70 test vectors (0 to 333 bytes) of rclone's `backend/onedrive/quickxorhash/quickxorhash_test.go` (MIT licence), which rclone checks against Microsoft's reference implementation. The two 1 KiB vectors in `test/quickxor.test.ts` were computed with rclone's Go implementation (`quickxorhash.go`, master branch on 1 Oct 2026).

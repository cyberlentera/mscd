# files module

Owner: WP-21 (build plan D.3 "Commands from the UI: files", D.5, F.13, BR-23, BR-29, BR-30, BR-35, BR-36).

- `uploads.service.ts`: `GET /storage/repositories/{slug}/browse` (picker listing below the system root),
  `POST /storage/upload-intents` (routing, stored name, size limit, correlation code), `PUT .../content` (streamed to
  the gateway with `Content-Length`, `gateway-upload.ts`) and `POST .../complete` (zero-transit registration).
- `file-commands.service.ts`: `POST /ms/{ms}/evidence/{id}/files` and `POST /ms/{ms}/documents/{id}/versions`.
- `object-access.service.ts`: `open`, `redirect` (HMAC token, `redirect-token.ts`) and `content` of storage objects.
- `files-support.ts`: rule messages, BR-29 checks, gateway error mapping, scope roots, names and labels.

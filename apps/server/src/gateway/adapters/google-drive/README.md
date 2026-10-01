# google-drive adapter
Storage adapter for Google Shared Drives (and a My Drive, reported as personal ownership) through the Drive v3 API (build plan D.5, TS 5.2, F.8): service account JWT or delegated refresh token, `sha256Checksum`, multipart and resumable uploads, `keepForever` for `pin-version`, and the code exchange of the repository consent flow. Root enforcement walks parent folders by id. Registered by `googleDriveAdapterFactory`; uses the HTTP layer in `../m365/provider`.

Owner: WP-15.

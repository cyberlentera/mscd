# m365 adapter
Storage adapter for SharePoint Online and OneDrive for Business through Microsoft Graph v1.0 (build plan D.5, TS 5.2): certificate client assertion (`x5t#S256`), quickXorHash, upload sessions for files above 4 MiB, asynchronous copies through the monitor URL. Registered by `m365AdapterFactory`.

`provider/` holds the HTTP layer both provider adapters use: egress policy (I.1), retries with backoff and `Retry-After`, error mapping to gateway problems, token cache, path and name checks, upload metering. It sits here because WP-15 owns only the two adapter folders; `../google-drive` imports it.

Owner: WP-15.

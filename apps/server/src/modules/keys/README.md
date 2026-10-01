# keys module
`FileKeyProvider` (the `file` driver of F.11 with previous keys for rotation) loaded from `kms.file` at start, and `SecretBox` for secrets sealed with `platform.key` (`mfa:`, `idp:`, `pkce:` bindings) and per-purpose token MACs.
Owner: WP-08.

# integrity module

Weekly re-hashing of Managed Vault objects (`integrity.rehash`, build plan E.2, A-08). Owner: WP-23.

Objects of `managed_vault` repositories with a computed hash, not re-hashed for 7 days, 200 per run, oldest first. The gateway decrypts and hashes the stored content (`POST /v1/rehash`); a mismatch (or content that no longer decrypts) sets `hash_mismatch` through the link health `LinkStatusWriter`. Every re-hash is a `link_health_result` row with `detail.check = 'rehash'`; gateway refusals keep the status and are retried the next week.

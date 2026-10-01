# auditor-access module

External auditor grants and their time-boxed access (build plan F.14, D-27, D-34). Owner: WP-26.

- `POST /ms/{ms}/auditor-access` (`auditor_access.grant`, feature `auditor_guest_access`): a guest account per grant,
  an active membership, an `external_auditor` role with `valid_until` = the grant expiry, and a single-use access
  link emailed to the auditor (never returned). Guests do not count towards `max_users`.
- `GET /ms/{ms}/auditor-access`: the grants of the system without tokens.
- `POST /ms/{ms}/auditor-access/{id}/revoke`: ends the guest's sessions, open code transactions, membership and role
  at once; audited `auditor_access.revoked`. Expired grants are ended the same way when grants are read or created.

The guest sign-in routes live in `modules/identity/guest` (imported by this module).

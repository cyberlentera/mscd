# implementation module

Applicability, activity and phase commands of D.3 (A.4, C.13). Owner: WP-20; skeleton by WP-03 (build plan B.4).

- `applicability.service.ts`: `POST /ms/{ms}/applicability/{id}/transitions` (C.13 rows with own checks, BR-01 through `entryEvidenceState`, BR-02 before `implemented`, VERIFY-SELF, BR-03 warning), `PATCH /ms/{ms}/applicability/{id}` (justifications, gate flag, note, frequency, owner, risks, documents; BR-02 when applicability or risks change, `NOT-A-MEMBER`, BR-03 warning) and `POST /ms/{ms}/applicability` (catalogue item or requirement of the active edition; BR-02 holds the gate of a new applicable entry).
- `activity.service.ts`: `POST /ms/{ms}/activities/{id}/transitions` (BR-12, BR-39, BR-40, VERIFY-SELF, BR-47 warning; two audit entries from `not_started` to `complete`), `POST /ms/{ms}/phases/{n}/verify` (BR-12) and the BR-46 flag (`gateConsistencyIn`).
- `rules/`: the `@BusinessRule` implementations the commands run through the `RuleEngine` of the `rules` module.
- Every command resolves records through `RecordResolver`, honours `If-Match`, writes its audit entry in the same transaction and returns `changed`; a change of state that freshness reads queues `freshness.recompute` in the same transaction.

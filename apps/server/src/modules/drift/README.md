# drift module

Drift rule evaluation (`drift.evaluate`, build plan E.2, TS 9.6, BR-48, BR-49). Owner: WP-23.

Every `ref.drift_rule_def` of a computed kind (`stale_risk`, `dd_expired`, `metric`, `exercise`, `unverif`, `nohash`) of the system's edition is evaluated with the predicates of `read-model/derive/drift.ts`. New matches get an open `drift_result` row (holder the record owner, due in 30 days) and a `drift_detected` digest notification; open rows that no longer match are resolved. Rows of `manual` rules are never touched. `driftEvaluateKey(org, ms)` gives the E.2 singleton key for producers.

# authz module
The global `AuthzGuard` (F.7: auth level, input validation, rate limits, permission in the system of the request, read-only mode) and the default providers of `PERMISSION_EVALUATOR` (deny all), `SCOPE_POLICY` (pass-through, refuses owner-scoped and external auditor reads), `RECORD_RESOLVER` and `MEMBERSHIP_SERVICE` (D.1 and F.7 checks without roles) and `ME_ASSEMBLER` (minimal Me).
Owner: WP-39; guard and default providers WP-08.

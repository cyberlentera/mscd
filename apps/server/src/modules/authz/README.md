# authz module

The global `AuthzGuard` (F.7: auth level, input validation, rate limits, permission in the system of the request, external auditor rules, read-only mode), role resolution (`RoleResolver`), the role-based `PERMISSION_EVALUATOR` over the F.6 matrix, `SCOPE_POLICY` (`ScopePolicyService`: owner scoping, classification, the external auditor projection, file access), `RECORD_RESOLVER`, `MEMBERSHIP_SERVICE`, `MembershipDirectory`, `ME_ASSEMBLER`, the `auditor.read` interceptor, and the routes `GET /me`, `PUT /me/org`, `POST /me/memberships/{org}/accept` and `POST /auth/demo/persona`.

Owner: WP-39 (the guard pipeline was built by WP-08).

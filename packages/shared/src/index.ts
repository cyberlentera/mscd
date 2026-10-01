// Entry point of the shared contract (`@mscd/shared`, build plan D.1, D.2, C.13, E.8, F.6): enumerations, the UI
// wire schemas, the API route table with its request and response schemas, the authorisation matrix, the state
// machines, the pack and licence schemas and the OpenAPI generator. Consumers: the server (CommonJS, through
// `require()` of this ES module), the web app (Vite alias to `src`) and `@mscd/pack-tools`.
//
// Every area file exports its own `routes`; the explicit export below names the concatenated table, which takes
// precedence over the area exports of the same name.
export * from './enums.js';
export * from './machines.js';
export * from './authz/matrix.js';
export * from './api/common.js';
export * from './ui/records.js';
export * from './ui/snapshot.js';
export * from './ui/codes.js';
export * from './pack/canonical-json.js';
export * from './pack/manifest.js';
export * from './pack/datasets.js';
export * from './pack/licence.js';
export * from './api/system.js';
export * from './api/auth.js';
export * from './api/me.js';
export * from './api/admin-users.js';
export * from './api/admin-idp.js';
export * from './api/admin-ms.js';
export * from './api/ui.js';
export * from './api/readmodel.js';
export * from './api/implementation.js';
export * from './api/records.js';
export * from './api/documents.js';
export * from './api/reminders.js';
export * from './api/audit-events.js';
export * from './api/risk-registers.js';
export * from './api/audit-registers.js';
export * from './api/files.js';
export * from './api/storage.js';
export * from './api/gateway.js';
export * from './api/packs.js';
export * from './api/license.js';
export * from './api/link-health.js';
export * from './api/exports.js';
export * from './api/notifications.js';
export * from './api/evidence-packs.js';
export * from './api/auditor-access.js';
export * from './api/ops.js';
export * from './api/audit-trail.js';
export * from './api/test-support.js';
export * from './api/routes.js';
export { routes } from './api/routes.js';
export * from './openapi.js';

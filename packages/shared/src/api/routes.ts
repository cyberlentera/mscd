// The route table (D.1 "Contract source"): every area's routes, in area order. Later work packages edit only the
// area files they own; this file only concatenates them.
import type { RouteDef } from './common.js';
import { routes as adminIdp } from './admin-idp.js';
import { routes as adminMs } from './admin-ms.js';
import { routes as adminUsers } from './admin-users.js';
import { routes as auditEvents } from './audit-events.js';
import { routes as auditRegisters } from './audit-registers.js';
import { routes as auditTrail } from './audit-trail.js';
import { routes as auditorAccess } from './auditor-access.js';
import { routes as auth } from './auth.js';
import { routes as documents } from './documents.js';
import { routes as evidencePacks } from './evidence-packs.js';
import { routes as exportsArea } from './exports.js';
import { routes as files } from './files.js';
import { routes as gateway } from './gateway.js';
import { routes as implementation } from './implementation.js';
import { routes as license } from './license.js';
import { routes as linkHealth } from './link-health.js';
import { routes as me } from './me.js';
import { routes as notifications } from './notifications.js';
import { routes as ops } from './ops.js';
import { routes as packs } from './packs.js';
import { routes as readmodel } from './readmodel.js';
import { routes as records } from './records.js';
import { routes as reminders } from './reminders.js';
import { routes as riskRegisters } from './risk-registers.js';
import { routes as storage } from './storage.js';
import { routes as system } from './system.js';
import { routes as testSupport } from './test-support.js';
import { routes as ui } from './ui.js';

/** Routes per area file (`packages/shared/src/api/<area>.ts`). */
export const ROUTE_AREAS: Readonly<Record<string, readonly RouteDef[]>> = {
  'system': system,
  'auth': auth,
  'me': me,
  'admin-users': adminUsers,
  'admin-idp': adminIdp,
  'admin-ms': adminMs,
  'ui': ui,
  'readmodel': readmodel,
  'implementation': implementation,
  'records': records,
  'documents': documents,
  'reminders': reminders,
  'audit-events': auditEvents,
  'risk-registers': riskRegisters,
  'audit-registers': auditRegisters,
  'files': files,
  'storage': storage,
  'gateway': gateway,
  'packs': packs,
  'license': license,
  'link-health': linkHealth,
  'exports': exportsArea,
  'notifications': notifications,
  'evidence-packs': evidencePacks,
  'auditor-access': auditorAccess,
  'ops': ops,
  'audit-trail': auditTrail,
  'test-support': testSupport,
};

/** Every route of the contract: the `/api/v1` routes of run mode api and the `/v1` routes of the storage gateway. */
export const routes: readonly RouteDef[] = Object.values(ROUTE_AREAS).flat();

/** Routes served by run mode `api` (`/api/v1/...`). */
export const API_ROUTES: readonly RouteDef[] = routes.filter((r) => r.path.startsWith('/api/v1/'));

/** Routes served by run mode `storage-gateway` (`/v1/...`, D.5). */
export const GATEWAY_ROUTES: readonly RouteDef[] = routes.filter((r) => r.path.startsWith('/v1/'));

const byId = new Map(routes.map((r) => [r.id, r] as const));

/** The route with this id; throws for an unknown id. */
export function routeById(id: string): RouteDef {
  const route = byId.get(id);
  if (!route) throw new Error(`Unknown route id ${id}`);
  return route;
}

/** The area file that defines a route. */
export function routeArea(route: RouteDef): string {
  for (const [area, list] of Object.entries(ROUTE_AREAS)) if (list.includes(route)) return area;
  throw new Error(`Route ${route.id} is not in the route table`);
}

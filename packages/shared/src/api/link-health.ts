// Area `link-health` (owner from wave 9: WP-23): on-demand link health run of a system (D.3 "Page actions", E.4,
// feature link_health_monitor).
import { CommandResult, MsParams, defineRoute } from './common.js';
import type { RouteDef } from './common.js';

export const linkHealthRunRoute = defineRoute({
  id: 'link-health.run',
  owner: 'WP-23',
  method: 'POST',
  path: '/api/v1/ms/:ms/link-health/run',
  summary: 'Check every file reference of the system now (feature link_health_monitor); count is the number of references, taskId the run',
  auth: 'session',
  permission: 'link_health.run',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  response: CommandResult,
  status: 202,
  errors: [404, 422, 429],
  rateLimits: [{ key: 'user', max: 10, windowSeconds: 3600 }],
});

export const routes: RouteDef[] = [linkHealthRunRoute];

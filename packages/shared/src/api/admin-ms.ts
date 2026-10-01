// Area `admin-ms` (owner from wave 5: WP-12): management systems and their status transitions (D.2
// `ManagementSystemCreate`, `MsTransitionRequest`; D.3 "Administration"; C.13 `management_system.status`; D-30).
import { z } from 'zod';
import { ApplicabilityTarget, MsStatus } from '../enums.js';
import { PackEdition, PackId } from '../pack/manifest.js';
import {
  Color, CommandResult, IdParams, Instant, MsId, MsParams, RepositorySlug, Uuid, defineRoute, named,
} from './common.js';
import type { RouteDef } from './common.js';

const EXAMPLE_MS_VIEW = {
  id: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c', slug: 'qms', code: 'QMS', name: 'Quality management system', frameworkCode: 'ISO9001',
  frameworkName: 'ISO 9001', edition: '2015', packId: 'ISO9001-2015', packVersion: '1.4.2', transitionTargetEdition: '2026',
  applicabilityTarget: 'requirement', status: 'transitioning', scopeStatement: 'Software product development and support',
  certificationBody: 'Lembaga Sertifikasi Garuda Mutu', color: '#3a6fd8', defaultRepository: 'vault', position: 1, createdAt: '2026-02-02T03:00:00Z',
} as const;

export const ManagementSystemView = named(
  'ManagementSystemView',
  z.object({
    id: Uuid,
    slug: MsId,
    code: z.string(),
    name: z.string(),
    frameworkCode: z.string(),
    frameworkName: z.string(),
    edition: z.string(),
    packId: z.string(),
    packVersion: z.string(),
    transitionTargetEdition: z.string().nullable(),
    applicabilityTarget: ApplicabilityTarget,
    status: MsStatus,
    scopeStatement: z.string(),
    certificationBody: z.string().nullable(),
    color: Color,
    defaultRepository: RepositorySlug,
    position: z.int(),
    createdAt: Instant,
  }),
  'Management system as the administration screens see it',
  { valid: [EXAMPLE_MS_VIEW, { ...EXAMPLE_MS_VIEW, transitionTargetEdition: null, certificationBody: null, status: 'implementing' }], invalid: [{ ...EXAMPLE_MS_VIEW, status: 'live' }, { ...EXAMPLE_MS_VIEW, slug: 'QMS' }] },
);
export type ManagementSystemView = z.infer<typeof ManagementSystemView>;

export const ManagementSystemCreate = named(
  'ManagementSystemCreate',
  z.strictObject({
    slug: MsId,
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(150),
    packId: PackId,
    edition: PackEdition,
    scopeStatement: z.string().trim().min(1).max(4000),
    defaultRepository: RepositorySlug,
    certificationBody: z.string().trim().max(150).optional(),
    color: Color,
  }),
  'POST /admin/management-systems body: activates an installed edition and copies its activity templates (D-30)',
  {
    valid: [{ slug: 'bcms', code: 'BCMS', name: 'Business continuity management system', packId: 'ISO22301-2019', edition: '2019', scopeStatement: 'Data centre operations: Jakarta', defaultRepository: 'gd', color: '#1f7a48' }],
    invalid: [{ slug: 'BCMS', code: 'BCMS', name: 'x', packId: 'ISO22301-2019', edition: '2019', scopeStatement: 'x', defaultRepository: 'gd', color: '#1f7a48' }, { slug: 'bcms', code: 'BCMS', name: 'x', packId: 'ISO22301-2019', edition: '2019', scopeStatement: '', defaultRepository: 'gd', color: '#1f7a48' }],
  },
);
export type ManagementSystemCreate = z.infer<typeof ManagementSystemCreate>;

export const ManagementSystemPatch = named(
  'ManagementSystemPatch',
  z.strictObject({
    scopeStatement: z.string().trim().min(1).max(4000).optional(),
    certificationBody: z.string().trim().max(150).nullable().optional(),
    color: Color.optional(),
    defaultRepository: RepositorySlug.optional(),
    status: z.enum(['implementing', 'archived']).optional(),
  }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Give at least one field' }),
  'PATCH /admin/management-systems/{id} body: scope, certification body, colour, default repository, and the ms.admin transitions of C.13 (setup to implementing, archive)',
  { valid: [{ color: '#e8731a' }, { status: 'implementing' }, { certificationBody: null }], invalid: [{}, { status: 'certified' }, { slug: 'x' }] },
);
export type ManagementSystemPatch = z.infer<typeof ManagementSystemPatch>;

export const MsTransitionRequest = named(
  'MsTransitionRequest',
  z.discriminatedUnion('to', [
    z.strictObject({ to: z.literal('transitioning'), targetEdition: PackEdition }),
    z.strictObject({ to: z.literal('certified') }),
  ]),
  'POST /ms/{ms}/transitions body: start an edition transition, or return to certified after the transition audit (C.13, feature edition_transition)',
  { valid: [{ to: 'transitioning', targetEdition: '2026' }, { to: 'certified' }], invalid: [{ to: 'transitioning' }, { to: 'archived' }, { to: 'certified', targetEdition: '2026' }] },
);
export type MsTransitionRequest = z.infer<typeof MsTransitionRequest>;

export const adminMsListRoute = defineRoute({
  id: 'admin.ms.list',
  owner: 'WP-12',
  method: 'GET',
  path: '/api/v1/admin/management-systems',
  summary: 'Management systems of the organisation',
  auth: 'session',
  permission: 'ms.admin',
  scope: 'org',
  response: z.array(ManagementSystemView),
  errors: [],
});

export const adminMsCreateRoute = defineRoute({
  id: 'admin.ms.create',
  owner: 'WP-12',
  method: 'POST',
  path: '/api/v1/admin/management-systems',
  summary: 'Create a management system on an installed edition (needs pack.activate too; BR-21, LIC-MS)',
  auth: 'session',
  permission: 'ms.admin',
  scope: 'org',
  body: ManagementSystemCreate,
  response: ManagementSystemView,
  status: 201,
  errors: [409, 422],
  idempotent: true,
});

export const adminMsUpdateRoute = defineRoute({
  id: 'admin.ms.update',
  owner: 'WP-12',
  method: 'PATCH',
  path: '/api/v1/admin/management-systems/:id',
  summary: 'Change scope, certification body, colour, default repository or the setup and archive status',
  auth: 'session',
  permission: 'ms.admin',
  scope: 'org',
  params: IdParams,
  body: ManagementSystemPatch,
  response: ManagementSystemView,
  errors: [404, 409],
});

export const msTransitionRoute = defineRoute({
  id: 'ms.transition',
  owner: 'WP-12',
  method: 'POST',
  path: '/api/v1/ms/:ms/transitions',
  summary: 'Start or finish an edition transition of the system (feature edition_transition)',
  auth: 'session',
  permission: 'ms.transition',
  machine: 'management_system.status',
  scope: 'ms',
  msSource: 'path',
  params: MsParams,
  body: MsTransitionRequest,
  response: CommandResult,
  errors: [404, 409, 422],
});

export const routes: RouteDef[] = [adminMsListRoute, adminMsCreateRoute, adminMsUpdateRoute, msTransitionRoute];

// The tables behind the record ids of the routes with `{ms}` and `{id}` (build plan D.1, F.7), shared by the
// cross-system and cross-organisation tests of WP-30.

/** Tables whose rows carry `management_system_id`; the others are shared through `entity_ms_link`. */
export const DIRECT = new Set([
  'applicability_entry', 'implementation_activity_progress', 'audit_event', 'audit_prep_task', 'cycle_requirement_status', 'risk_treatment',
  'finding', 'corrective_action', 'self_assessment', 'audit_activity', 'evidence_pack', 'auditor_access_grant', 'entity_ms_link',
]);

/** The table of the `{id}` of each route with `{ms}` and a record id (the `{entityType}` routes are listed per type). */
export const ID_TABLES: Readonly<Record<string, string>> = {
  'readmodel.surveillance.event': 'audit_event',
  'applicability.transition': 'applicability_entry',
  'applicability.update': 'applicability_entry',
  'applicability.operating-criteria': 'applicability_entry',
  'activity.transition': 'implementation_activity_progress',
  'documents.transition': 'document',
  'documents.update': 'document',
  'documents.versions': 'document',
  'audit-events.update': 'audit_event',
  'prep-tasks.create': 'audit_event',
  'prep-tasks.update': 'audit_prep_task',
  'cycle-items.update': 'cycle_requirement_status',
  'registers.update': 'risk',
  'metrics.values.create': 'metric',
  'treatments.create': 'risk',
  'treatments.update': 'risk_treatment',
  'treatments.transition': 'risk_treatment',
  'risks.residual-acceptance': 'risk',
  'evidence.update': 'evidence',
  'evidence.targets.create': 'evidence',
  'evidence.targets.remove': 'evidence',
  'evidence.files': 'evidence',
  'entity-links.make-primary': 'entity_ms_link',
  'entity-links.remove': 'entity_ms_link',
  'findings.update': 'finding',
  'findings.transition': 'finding',
  'corrective-actions.update': 'corrective_action',
  'corrective-actions.transition': 'corrective_action',
  'self-assessments.raise-finding': 'self_assessment',
  'audit-activities.list': 'audit_event',
  'audit-activities.generate': 'audit_event',
  'audit-activities.update': 'audit_activity',
  'management-reviews.input': 'management_review',
  'management-reviews.transition': 'management_review',
  'evidence-packs.get': 'evidence_pack',
  'evidence-packs.download': 'evidence_pack',
  'auditor-access.revoke': 'auditor_access_grant',
};

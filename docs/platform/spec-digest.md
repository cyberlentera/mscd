# MSCD Specification Digest

| | |
|---|---|
| Sources | TS-MSCD-01 v2.4 Technical Specification (TS), PRD-MSCD-01 v2.4 Product Requirements (PRD), both in Indonesian under `project/uploads/` |
| Companion | `docs/ARCHITECTURE.md` (target stack and the decisions taken on top of the spec) |
| Notation | "TS 4.5" is section 4.5 of the TS; "PRD 11.2" is section 11.2 of the PRD. Identifiers, table names and enum values are kept exactly as written in the sources. Indonesian prose is rendered in English |
| Flags | **[A-nn]** points to an entry in section 23, Ambiguities and gaps |

## Contents

1. [Product scope](#1-product-scope)
2. [General conventions](#2-general-conventions)
3. [Entities and data dictionary](#3-entities-and-data-dictionary)
4. [Traceability chains and integrated mode](#4-traceability-chains-and-integrated-mode)
5. [State machines](#5-state-machines)
6. [Business rules](#6-business-rules)
7. [RBAC](#7-rbac)
8. [Audit trail](#8-audit-trail)
9. [Soft delete](#9-soft-delete)
10. [Freshness engine](#10-freshness-engine)
11. [Storage abstraction](#11-storage-abstraction)
12. [File integrity states](#12-file-integrity-states)
13. [Notifications, tasks and reminders](#13-notifications-tasks-and-reminders)
14. [Evidence pack](#14-evidence-pack)
15. [Framework packs](#15-framework-packs)
16. [Licence and entitlements](#16-licence-and-entitlements)
17. [Deployment](#17-deployment)
18. [Read model and API conventions](#18-read-model-and-api-conventions)
19. [Module features and drill-down behaviour](#19-module-features-and-drill-down-behaviour)
20. [Non-functional requirements](#20-non-functional-requirements)
21. [Build order and releases](#21-build-order-and-releases)
22. [Open questions listed in the sources](#22-open-questions-listed-in-the-sources)
23. [Ambiguities and gaps](#23-ambiguities-and-gaps)

---

## 1. Product scope

MSCD is a compliance dashboard for ISO/IEC 27001, ISO 9001, ISO 22301 and ISO 37001 (PRD 1). Three requirements of v2.0 each map to one architecture component that must exist from the MVP (TS 1, PRD 0, PRD 14):

| Requirement | Component |
|---|---|
| Multi-framework, selected through a framework menu | Framework Engine and signed, versioned Framework Packs |
| Two implementation modes, SaaS and on-premise, one code base and one release path | Deployment Profile (configuration, never code branches on the mode name) |
| Files may stay in the customer's own repository (OneDrive, SharePoint, Google Drive, file share, S3) | Storage Abstraction Layer with adapters |

Modules (PRD 1):

| Module | Focus | Main users |
|---|---|---|
| Module 1, Implementation Dashboard | Building the management system: activity progress, documents, applicability, risk register, clause readiness | MS Manager, Domain Owner |
| Module 2, Audit Process Dashboard | Running audits: audit activities, self-assessment against the finding condition library, finding tracking to closure, joint audits | MS Manager, Internal Auditor |
| Module 3, Surveillance / Recertification | Keeping the certificate: three-year cycle per framework, evidence freshness, document review schedule, regression detection, edition transition | MS Manager, Top Management |

A Management System (MS) is one framework instance (framework + edition + scope). An organisation can run many MS (PRD 0, PRD 6).

Non-goals (PRD 3.3): replacing auditors; being a general DMS or replacing OneDrive, SharePoint or Google Drive; being a backup of customer repositories; running technical controls directly; shipping official ISO text (packs hold numbering, short titles and provider guidance only); guaranteeing certification.

## 2. General conventions

TS 1.1:

| Convention | Rule |
|---|---|
| Primary key | UUID v4 in column `id`. Business ids (`requirement_code`, `doc_id`, `risk_code`) are unique within their scope but are not primary keys |
| Timestamps | `created_at` and `updated_at` mandatory, `timestamptz`, UTC |
| Soft delete | `deleted_at` nullable. Physical deletion is forbidden except a verified purge at SaaS tenant offboarding |
| Actor | `created_by` and `updated_by` reference `user.id`; system actions use a dedicated user whose value is `system` |
| Tenancy | `organization_id` on every non-reference entity. On SaaS each organisation has its own database schema; `organization_id` stays for second-layer RLS and for portability to on-premise |
| Management system | `management_system_id` on entities bound to one MS. Shareable entities use the link table `entity_ms_link`. Replaces v1.0 `scope_id` |
| Framework content | Reference entities (framework, requirement, catalogue_item and the rest) are global and read-only for tenants; installed from Framework Packs |
| Framework neutrality | Table and column names must not contain standard-specific terms (annex, soa, isms). Such terms appear only in the label dictionary |
| Enums | Short `snake_case` strings. Framework-specific enums live in lookup tables installed by the pack, not in database enums |
| File references | No `file_uri` column on business entities. Every file is referenced through `storage_object_id` |
| Deployment profile | Behaviour that differs between modes is read from configuration (TS 2.4), never from code branching on the mode name |
| Money | `numeric(18,2)` with a separate currency column (TS 4.7, first monetary field is `gift_hospitality_record.value_amount`) |

Standard fields (`id`, `created_at`, `updated_at`, `deleted_at`, `created_by`, `updated_by`, `organization_id`) are not repeated in the tables below (TS 4).

## 3. Entities and data dictionary

### 3.1 Layers (PRD 6)

| Layer | Content | Nature |
|---|---|---|
| Framework content (global) | Framework, FrameworkVersion, Requirement, CatalogueItem, RequirementMapping, libraries and templates | Installed from a Framework Pack; read-only for tenants except libraries flagged editable |
| Organisation and management system | Organization, ManagementSystem, Scope, CertificationCycle | One organisation has many MS; one MS = one framework + edition + scope |
| Operational data | All v1.0 entities (risk, document, evidence, finding and the rest) plus framework-specific and storage entities | Bound to one MS, or shared across MS through a link table |

### 3.2 Global reference entities (TS 4.1, TS 4.9)

**framework and framework_version**

| Field | Type | Null | Constraint / enum | Note |
|---|---|---|---|---|
| framework.code | varchar(20) | NO | UNIQUE | ISO27001, ISO9001, ISO22301, ISO37001 |
| framework.name | varchar(150) | NO | | Display name |
| version.framework_id | uuid | NO | FK framework.id | |
| version.edition | varchar(20) | NO | UNIQUE with framework_id | e.g. 2022, 2026, 2019, 2025 |
| version.pack_version | varchar(20) | NO | semver | Pack content version |
| version.status | varchar(15) | NO | current, transition, withdrawn | See 5.3 |
| version.transition_ends_at | date | YES | | End of the old edition |
| version.pack_checksum | varchar(64) | NO | SHA-256 | Integrity of the installed pack |

**requirement** (replaces v1.0 `clause_requirement`)

| Field | Type | Null | Constraint / enum | Note |
|---|---|---|---|---|
| framework_version_id | uuid | NO | FK | |
| requirement_code | varchar(20) | NO | UNIQUE per version | e.g. 6.1.2, 8.2.2 |
| parent_id | uuid | YES | FK requirement.id | Clause tree |
| title_short | varchar(255) | NO | | Short title, not the standard's text |
| clause_group | varchar(3) | NO | 4..10 | Harmonized Structure clause |
| is_hs_common | boolean | NO | default false | Core Harmonized Structure requirement; candidate for automatic mapping |
| documented_info_mandatory | boolean | NO | default false | Used by Gate Enforcement |
| applicability_assessable | boolean | NO | default false | true when it may be declared not applicable (e.g. ISO 9001 clause 8) |
| sort_order | integer | NO | | |

**catalogue_item** (replaces v1.0 `annex_a_control`)

| Field | Type | Null | Constraint / enum | Note |
|---|---|---|---|---|
| framework_version_id | uuid | NO | FK | |
| item_code | varchar(20) | NO | UNIQUE per version | A.5.1 (27001); ABC-DD-01 (37001) |
| theme_code | varchar(20) | NO | pack lookup | A5..A8 (27001); financial, non_financial, due_diligence (37001) |
| title_short | varchar(255) | NO | | |
| requirement_id | uuid | YES | FK requirement | Parent clause when one exists |
| flags | jsonb | NO | default `{}` | e.g. `{"is_new_in_2022": true}` |
| sort_order | integer | NO | | |

**requirement_mapping**

| Field | Type | Null | Constraint / enum | Note |
|---|---|---|---|---|
| source_requirement_id | uuid | NO | FK requirement | |
| target_requirement_id | uuid | NO | FK requirement | Other framework or other edition |
| mapping_type | varchar(15) | NO | equivalent, partial, related, split, merged, changed, new, removed | First three are cross-framework; the rest are edition transition [A-36] |
| evidence_reusable | boolean | NO | default false | true only when evidence on one side is valid for the other (BR-23) |
| note | text | YES | | |

**Other pack reference tables.** Each follows the v1.0 dataset structure plus `framework_version_id` (TS 4.1): `traceability_chain_def`, `activity_template`, `audit_activity_template`, `finding_condition`, `document_template`, `evidence_frequency_rule`, `review_input_def`, `label`. Added in v2.4 (TS 4.9): `cycle_requirement_def`, `drift_rule_def`, `prep_task_template` [A-12].

**cycle_requirement_def** (pack, TS 4.9)

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| framework_version_id | uuid | NO | FK | |
| code | varchar(30) | NO | UNIQUE per version | e.g. RISK_ASSESSMENT, MGMT_REVIEW, EXERCISE_PROGRAMME |
| requirement_code | varchar(20) | YES | | Reference clause; null for non-clause items such as transition tasks |
| title | varchar(255) | NO | | |
| derivation | jsonb | YES | | Automatic derivation rule when one exists (e.g. MR complete = `inputs_complete`) |

**drift_rule_def** (pack, TS 4.9)

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| code | varchar(30) | NO | UNIQUE per version | e.g. DR_RISK_STALE, DR_EVIDENCE_UNVERIFIABLE, DR_METRIC_STALE |
| severity | varchar(10) | NO | crit, risk, warn | |
| source_stage | varchar(20) | NO | | Chain stage key or entity |
| predicate | jsonb | NO | | Condition over records; evaluated by the worker |
| message | text | NO | | Plain-language title and explanation |

### 3.3 Organisation and management system entities (TS 4.2)

**management_system**

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| framework_version_id | uuid | NO | FK | Active edition |
| code | varchar(20) | NO | UNIQUE per organisation | e.g. ISMS-JKT, QMS-GROUP |
| name | varchar(150) | NO | | |
| scope_statement | text | NO | | Certification scope |
| status | varchar(20) | NO | See 5.2 | |
| default_storage_repository_id | uuid | NO | FK storage_repository | Default location of new files [A-41] |
| transition_target_version_id | uuid | YES | FK framework_version | Set during edition transition |
| certification_body | varchar(150) | YES | | |

**entity_ms_link** (sharing artefacts across MS)

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| entity_type | varchar(30) | NO | context_issue, interested_party, asset, document, evidence, risk, audit_event, management_review, metric | Only these entities may be shared |
| entity_id | uuid | NO | | |
| management_system_id | uuid | NO | FK | |
| is_primary | boolean | NO | default false | Exactly one `true` per entity: the owning MS [A-29] |
| relevance_note | text | YES | | Why it is relevant to this MS |

`UNIQUE (entity_type, entity_id, management_system_id)`. Non-shareable entities (`applicability_entry`, BIA, `due_diligence`, `certification_cycle`) carry `management_system_id` directly.

### 3.4 v1.0 entities changed in v2.0 (TS 4.3)

| v1.0 entity | Change |
|---|---|
| context_issue, interested_party, asset | Gain `entity_ms_link`. Column `cia_affected` moves to risk dimension attributes per profile |
| risk | Add `risk_profile_code` (from pack) and `impact_dimensions jsonb` (CIA for 27001; other dimensions per profile). Likelihood and consequence scales read from the profile, not a fixed `CHECK 1..5` |
| risk_treatment | Target becomes restricted polymorphic: `catalogue_item_id` or `requirement_id` (one is mandatory) |
| soa_entry | Becomes `applicability_entry` (3.5) |
| document | `storage_uri` removed; files reach `storage_object` through `document_version` |
| document_version | `file_uri` and `file_checksum` removed; replaced by `storage_object_id` NOT NULL |
| evidence | `file_uri` and `file_checksum` removed; replaced by `storage_object_id` (NULL when the evidence is a "system link") [A-32]. `control_id` and `clause_id` replaced by table `evidence_target` (many-to-many to requirement or catalogue_item, across MS) |
| operating_criteria | `control_id` becomes a restricted polymorphic target; `management_system_id` replaces `scope_id` |
| finding | Add `management_system_id` and `framework_version_id`; the `audit_event` may be joint |
| self_assessment | `condition_id` references the pack `finding_condition`; add `management_system_id` |
| management_review | The seven v1.0 input columns are removed and replaced by `management_review_input` rows (3.7). Add `entity_ms_link` for joint reviews |
| certification_cycle | Add `management_system_id` NOT NULL |

PRD 6.1 adds attribute-level notes: Risk carries `risk_profile` (information_security, quality, disruption, bribery); Document and Evidence gain a storage object; Evidence gains `integrity_status`; Finding, CorrectiveAction and SelfAssessment gain a framework per finding; ManagementReview inputs come from the pack definition; CertificationCycle and AuditEvent gain the management system, one cycle per MS, audit events may be joint.

### 3.5 applicability_entry (replaces soa_entry, TS 4.4)

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| management_system_id | uuid | NO | FK | |
| target_type | varchar(15) | NO | catalogue_item, requirement | From the pack applicability model |
| catalogue_item_id | uuid | YES | FK; required when target_type = catalogue_item | |
| requirement_id | uuid | YES | FK; required when target_type = requirement | |
| is_applicable | boolean | YES | null = not yet assessed | |
| inclusion_justification | text | YES | Required per applicability model | On 27001 it must reference a `risk_code` |
| exclusion_justification | text | YES | Required when is_applicable = false | |
| implementation_status | varchar(25) | YES | See 5.1 | |
| last_evidence_at | date | YES | DERIVED | |
| freshness_status | varchar(15) | YES | DERIVED: fresh, aging, expired, critical | |
| integrity_status | varchar(15) | YES | DERIVED: ok, degraded, broken | From the storage_object of the latest evidence [A-05] |

`UNIQUE (management_system_id, target_type, catalogue_item_id, requirement_id)` [A-28]. Relation tables: `applicability_entry_risk`, `applicability_entry_document`.

### 3.6 Storage entities (TS 4.5)

**storage_repository**

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| name | varchar(150) | NO | | e.g. "SharePoint, Compliance Library" |
| adapter | varchar(20) | NO | managed_vault, m365, google_drive, smb, s3, webdav | Must be listed in `storage.adapters.enabled` |
| mode | varchar(15) | NO | stored, pass_through, link, zero_transit | `stored` only for managed_vault |
| config | jsonb | NO | Schema per adapter | e.g. site_id, drive_id, root_folder_id; holds no secrets |
| credential_ref | varchar(200) | YES | Reference into secrets/KMS | Secrets are never stored in tables |
| ownership_type | varchar(15) | NO | organizational, personal | `personal` triggers BR-30 |
| retention_confirmed | boolean | NO | default false | Customer confirms a retention policy is applied |
| connection_status | varchar(15) | NO | ok, degraded, failed, revoked | Result of the last connection test |
| last_checked_at | timestamptz | YES | | |
| metadata_minimization | boolean | NO | default false | true: original file name is not stored |

**storage_routing_rule**

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| management_system_id | uuid | YES | FK; null = whole organisation | |
| classification | varchar(20) | YES | public, internal, confidential, restricted | |
| object_kind | varchar(15) | YES | document, evidence | |
| storage_repository_id | uuid | NO | FK | Destination |
| priority | smallint | NO | | The most specific rule wins [A-37] |

**storage_object**

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| storage_repository_id | uuid | NO | FK | |
| external_item_id | varchar(300) | NO | | driveItem id, file id, relative path or object key |
| external_version_id | varchar(200) | YES | Required when the adapter supports versions | The pinned version |
| display_name | varchar(255) | YES | null when metadata_minimization | |
| mime_type | varchar(100) | YES | | |
| size_bytes | bigint | YES | | |
| hash_algorithm | varchar(20) | YES | sha256, sha1, md5, quickxor, none | Per adapter availability |
| hash_value | varchar(128) | YES | | |
| hash_source | varchar(15) | NO | computed, provider, none | computed = calculated by the application |
| provider_created_at | timestamptz | YES | | From the repository; compared with `produced_at` (BR-36) |
| provider_modified_at | timestamptz | YES | | |
| link_status | varchar(20) | NO | See 5.4 | |
| last_verified_at | timestamptz | YES | | |
| web_url | text | YES | | Open-in-repository link; not shared with auditors without permission |

The hash algorithm is stored next to the value because repositories differ: SharePoint Online and OneDrive for Business expose quickXorHash; Google Drive exposes MD5, SHA-1 and SHA-256 for binary files but none for native Google Docs and Sheets. A single SHA-256 column would force downloads, which Link and Zero-transit customers want to avoid (TS 4.5).

### 3.7 management_review_input (TS 4.6)

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| management_review_id | uuid | NO | FK | |
| review_input_def_id | uuid | NO | FK review_input_def (pack) | Mandatory input per framework |
| management_system_id | uuid | NO | FK | MS this input represents |
| content | text | YES | | Empty = not yet filled |
| source_refs | jsonb | YES | | References to metric, finding, risk |

`inputs_complete` on `management_review` is computed per MS: every mandatory `review_input_def` of that MS's framework has non-empty `content`. Rows (rather than columns) keep the Regression Detector able to see an input that stops being filled.

### 3.8 Framework-specific entities (TS 4.7, PRD 6.2)

Enabled through the pack's `modules.json`. The TS lists key fields only; full fields are set when the pack is authored.

| Entity | Framework | Key fields | Key rule |
|---|---|---|---|
| prioritized_activity | ISO22301 | product_service_id, name, owner_user_id, mtpd_hours, rto_hours, rpo_hours, mbco_note | `rto_hours <= mtpd_hours` (BR-24) |
| business_impact_analysis | ISO22301 | activity_id, impact_over_time jsonb, dependencies jsonb, resources_required jsonb, analysed_at, next_review_at | Required for every prioritised activity |
| bc_strategy / bc_plan | ISO22301 | activity_ids, strategy_text, plan document_id, activation_criteria, owner | Plan must link to a controlled document |
| exercise | ISO22301 | bc_plan_id, exercise_type (tabletop, walkthrough, simulation, full), performed_at, objectives_met, lessons, finding_ids | Plan without an exercise in the programme period becomes untested (BR-25) |
| process | ISO9001 | name, owner_user_id, inputs, outputs, kpi_metric_ids, interacts_with[] | Must have an owner and at least one KPI |
| quality_objective | ISO9001 | statement, metric_id, target, due_at, owner_user_id | Must be measurable (metric_id) |
| customer_feedback | ISO9001 | type (complaint, survey, compliment), received_at, summary, finding_id | A complaint can become a finding |
| nonconforming_output | ISO9001 | detected_at, description, disposition (correct, segregate, return, concession), authorised_by | A concession needs authorisation by someone other than the reporter |
| business_associate | ISO37001 | name, category, jurisdiction, bribery_risk_level, relationship_owner | Risk above low requires a valid due diligence (BR-26) |
| due_diligence | ISO37001 | subject_type (associate, position, transaction, project), subject_id, performed_at, valid_until, outcome, conditions | Past valid_until becomes expired |
| gift_hospitality_record | ISO37001 | direction (given, received), counterparty, value_amount numeric(18,2), currency, occurred_at, approved_by | Above threshold requires approval (BR-27) [A-46] |
| concern | ISO37001 | channel, received_at, is_anonymous, reporter_contact_encrypted, summary_encrypted, status | Restricted access (BR-28); field-level encryption |
| investigation | ISO37001 | concern_id, investigator_user_id, opened_at, closed_at, outcome, finding_id | Investigator must not be the reported party |

PRD 6.2 also names ISO 9001 `ExternalProviderEvaluation`, ISO 22301 `ProductService` and ISO 37001 `ComplianceFunctionReport`, which TS 4.7 does not define [A-13].

### 3.9 Drill-down support entities (TS 4.9)

Most drill-down numbers derive from existing entities; new entities exist only where data cannot be derived.

**implementation_activity_progress** (extended)

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| management_system_id | uuid | NO | FK | Replaces the v1.0 single organisation |
| activity_template_id | uuid | NO | FK activity_template (pack) | Number, phase, clause, activity, action, output, outcome |
| owner_user_id | uuid | NO | FK user | A named person, not a role [A-24] |
| status | varchar(15) | NO | See 5.6 | `locked` is not stored; it is derived |
| output_document_id | uuid | YES | FK document | Required when the template output is a controlled document (BR-40) |
| blocker_gate_item_ref | varchar(60) | YES | Required when status = blocked | The gate item that causes the block (BR-39) [A-27] |
| blocker_reason | text | YES | Required when status = blocked | |
| due_at | date | YES | | |
| completed_at | date | YES | Required when complete or verified | |
| verified_by_user_id | uuid | YES | CHECK `<> owner_user_id` | Verification by the MS Manager |

**audit_event** (extended) and **audit_prep_task**

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| event.management_system_id | uuid | NO | FK | [A-30] |
| event.event_type | varchar(20) | NO | stage1, stage2, surveillance, recertification, transition, special | `transition` is new in v2.4 |
| event.scheduled_at | date | NO | | Basis for After audit (BR-41) |
| event.audit_days | smallint | YES | | |
| event.lead_auditor_name | varchar(150) | YES | | From the certification body |
| event.expected_focus | text | YES | | Areas likely to be sampled |
| event.prep_window_days | smallint | NO | default 60 | When the preparation checklist is generated |
| event.outcome | varchar(25) | YES | v1.0 enum [A-03] | |
| event.outcome_summary | text | YES | | Result summary for past events |
| task.audit_event_id | uuid | NO | FK audit_event | |
| task.template_code | varchar(30) | YES | FK prep_task_template (pack) | null for manually added tasks |
| task.title | varchar(255) | NO | | |
| task.owner_user_id | uuid | NO | FK user | |
| task.due_at | date | NO | CHECK `< event.scheduled_at` | BR-43 [A-26] |
| task.status | varchar(15) | NO | See 5.7 | |
| task.note | text | YES | Required when blocked | |

**cycle_requirement_status**

| Field | Type | Null | Constraint | Note |
|---|---|---|---|---|
| management_system_id | uuid | NO | FK | |
| certification_cycle_id | uuid | NO | FK | One row per definition per cycle |
| owner_user_id | uuid | NO | FK user | |
| status | varchar(15) | NO | See 5.8 | |
| due_at | date | NO | | |
| condition_note | text | YES | | e.g. "61 of 90 applicable controls covered" |

**drift_result**

| Field | Type | Null | Note |
|---|---|---|---|
| management_system_id | uuid | NO | FK |
| rule_id | uuid | NO | FK drift_rule_def |
| entity_type / entity_id | varchar / uuid | NO | Affected record |
| detected_at | timestamptz | NO | |
| resolved_at | timestamptz | YES | History is kept for trends |

**user** (extended)

| Field | Type | Null | Note |
|---|---|---|---|
| display_name | varchar(150) | NO | Shown with the role label on every pending item (named accountability) |
| job_title | varchar(150) | YES | Optional; the MS role label still comes from `user_ms_role` |

### 3.10 Indexes and performance (TS 4.8)

| Table | Index | Reason |
|---|---|---|
| evidence_target | (target_type, target_id), (evidence_id) | Freshness engine and cross-MS Golden Thread |
| evidence | (organization_id, produced_at DESC) | Scan of latest evidence |
| applicability_entry | (management_system_id, implementation_status) | Readiness dashboard per MS |
| entity_ms_link | (management_system_id, entity_type), (entity_type, entity_id) | Switcher and shared artefact views |
| storage_object | (link_status, last_verified_at) | Link health scheduling |
| storage_object | (storage_repository_id, external_item_id) | Detect a file linked twice |
| requirement_mapping | (source_requirement_id), (target_requirement_id) | Evidence reuse and edition transition |
| finding | (management_system_id, status, classification) | Open findings per MS |
| audit_trail | (entity_type, entity_id, created_at DESC) | History of one entity |

The Golden Thread Viewer must render in under 3 seconds. The chain definition is dynamic per pack, so the chain query is generated from `traceability_chain_def` as one recursive CTE. File integrity is read from the stored `link_status`; the Golden Thread never calls an external repository synchronously.

### 3.11 Entities referenced but not defined in v2.4

These appear in the TS or PRD without a field list. Most are v1.0 entities whose dictionary is not in the provided sources [A-01]:

`organization`, `user` (base fields), `user_ms_role`, `scope` (PRD 6 layer table only), `certification_cycle`, `management_system_version` (two rows during a transition, TS 3.4), `transition_task` (TS 3.4), `context_issue`, `interested_party`, `asset`, `risk`, `risk_treatment` (PRD calls it RiskTreatment / Action), `residual_acceptance` (TS 10.1 stage 5), `operating_criteria`, `metric`, `document`, `document_version`, `evidence`, `evidence_target`, `finding`, `corrective_action`, `self_assessment`, `management_review`, `applicability_entry_risk`, `applicability_entry_document`, `audit_trail`, `license`, `prep_task_template`, `product_service`, gate items [A-27].

## 4. Traceability chains and integrated mode

### 4.1 Chains per framework (PRD 5.6)

The Golden Thread Viewer renders the chain defined by the pack. A mandatory node without a relation is marked as a broken chain.

| Framework | Chain |
|---|---|
| ISO/IEC 27001 | ContextIssue → Risk → RiskTreatment → Control → ApplicabilityEntry (SoA) → Document → Evidence → Metric → Finding → CorrectiveAction |
| ISO 9001 | ContextIssue / InterestedParty → Risk or Opportunity → Action → Process → QualityObjective → Document → Evidence → Metric → Nonconformity → CorrectiveAction |
| ISO 22301 | ContextIssue → Product/Service and Activity → BIA (MTPD, RTO, RPO) → DisruptionRisk → BC Strategy and Solution → BC Plan → Exercise → Evidence → Finding → CorrectiveAction |
| ISO 37001 | ContextIssue → BriberyRisk → Control (financial, non-financial, due diligence) → Position / Business Associate → Document → Evidence → Concern / Investigation → Finding → CorrectiveAction |

The ISO 27001 seed defines the chain as 10 steps of which 6 are mandatory (PRD 5.2); which six is carried in `traceability_chain.csv`.

### 4.2 Shareable artefacts in Integrated mode (PRD 5.5)

| Artefact | Shareable | Note |
|---|---|---|
| Context issue and interested party | Yes | Relevance marked per MS |
| Documents (document control, internal audit, corrective action procedures) | Yes | One document, one approval cycle, linked to requirements across frameworks |
| Operational evidence | Yes | One evidence item can prove requirements in several MS through cross-mapping |
| Internal audit programme | Yes, joint audit | One audit event can cover several frameworks; findings are still classified per framework |
| Management review | Yes, joint review | Mandatory inputs merged from every covered framework; completeness judged per framework |
| Risk register | Partly | One physical register is allowed, but every risk must carry its framework's risk profile; information risk and bribery risk are not scored on the same scale |
| Statement of Applicability, BIA, due diligence | No | Framework-specific artefacts |
| Certification cycle | No | Each framework has its own certification body, certificate and schedule, even when audits are combined |

### 4.3 Switcher rules (PRD 5.4)

- Last choice remembered per user; deep links carry the MS identity.
- Every screen shows the active framework explicitly.
- Shared artefacts show a Shared marker in every linked MS. Editing affects all of them, and the system lists the affected MS before saving (BR-22).
- Users with access to one MS do not see the switcher.
- My Tasks ignores the switcher and always lists tasks from all of the user's MS.
- Framework activation (Framework Library) is an administrative action by the Tenant Administrator: enable per licence, choose edition, set scope, certification body and file location.
- Portfolio Overview is the home page for users with more than one MS. Readiness is never averaged across frameworks (PRD 7.2).

## 5. State machines

Every transition not listed is rejected (TS 6). The v1.0 machines for `document`, `risk_treatment`, `finding`, `corrective_action` and `implementation_activity_progress` stay with unchanged logic, with "ISMS Manager" read as "MS Manager of the related MS" [A-01, A-02].

### 5.1 applicability_entry.implementation_status (TS 6.1)

| From | To | Condition | Performed by |
|---|---|---|---|
| (null) | not_started | `is_applicable` assessed as true | MS Manager |
| not_started | planned | At least one linked treatment or action with a `target_date` | MS Manager |
| planned | partially_implemented | At least one linked document with status approved | MS Manager, Domain Owner |
| partially_implemented | implemented | At least one evidence within the `operating_criteria` period AND that evidence's `link_status` is intact or moved | MS Manager |
| implemented | partially_implemented | AUTOMATIC when `freshness_status` is expired OR `integrity_status` is broken | System |
| any | not_applicable | `is_applicable` false with an exclusion justification | MS Manager |

Promotion back to `implemented` after an automatic downgrade is the normal manual transition. The UI and PRD 7.3 also show a `blocked` control status, which this machine does not define [A-04].

### 5.2 management_system.status (TS 6.2)

| From | To | Condition | Performed by |
|---|---|---|---|
| (new) | setup | `framework_version`, `scope_statement` and default repository set; licence allows it (BR-21) | Tenant Admin |
| setup | implementing | At least one MS Manager assigned | Tenant Admin |
| implementing | certified | `certification_cycle` has status certified | System |
| certified | transitioning | `transition_target_version_id` set | MS Manager |
| transitioning | certified | Transition audit recommended; `framework_version_id` updated | MS Manager |
| any | archived | No active cycle; reason recorded; data stays stored | Tenant Admin |

See [A-11] for missing paths.

### 5.3 framework_version.status (TS 6.3)

| From | To | Condition | Performed by |
|---|---|---|---|
| (installed) | current | Pack valid and edition not superseded | System |
| current | transition | A new edition pack whose manifest `supersedes` this edition is installed | System |
| transition | withdrawn | `transition_ends_at` has passed | System; any MS still on this edition is marked critical (BR-33) |

### 5.4 storage_object.link_status (TS 6.4, TS 5.5)

| Status | Meaning | Counts as valid evidence? |
|---|---|---|
| intact | Pinned version exists and matches | Yes |
| moved | Item moved to another folder, version unchanged | Yes |
| version_changed | A newer version exists; the pinned version can still be fetched | Yes for evidence; for documents it triggers an offer to register the new version |
| verification_pending | Cannot be verified because the repository is unreachable | Yes, for at most 7 days |
| hash_mismatch | Content of the pinned version differs from when it was linked | No |
| pinned_version_lost | Pinned version is no longer available | No |
| missing | Item not found | No |
| access_denied | Application lost permission | No, after a 72-hour grace period |

Transitions are set by the link health check (11.9). There is no user-driven transition; re-linking creates a new pinned reference (BR-31 message).

### 5.5 Framework-specific machines (TS 6.5)

| Entity | States and transitions | Automatic transitions |
|---|---|---|
| due_diligence (37001) | draft → completed → expired; completed → superseded | completed → expired when `valid_until` passes |
| bc_plan (22301) | draft → approved → tested → approved (after revision); tested → untested | tested → untested when no exercise in the programme period (BR-25) |
| concern (37001) | received → triaged → under_investigation → closed | None; every transition is manual by the compliance function |
| nonconforming_output (9001) | detected → dispositioned → verified → closed | None |

Roles are not stated per transition; the compliance function owns concern transitions [A-14].

### 5.6 implementation_activity_progress.status (TS 6.6)

| From | To | Condition | Performed by |
|---|---|---|---|
| not_started | in_progress | Previous phase passed its gate (when this phase sits behind a gate) | Activity owner |
| in_progress | complete | Output linked; `completed_at` set (BR-40 for controlled-document outputs) | Activity owner |
| complete | verified | Output checked; `verified_by` differs from the owner | MS Manager |
| complete | in_progress | Verification rejected; reason recorded | MS Manager |
| any except verified | blocked | `blocker_reason` and `blocker_gate_item_ref` set (BR-39) | Activity owner, MS Manager |
| blocked | in_progress | The causing gate item is closed | Activity owner |

`locked` is a derived display status: the activity sits in a phase behind a gate that has not passed. It is not stored and users cannot transition it. Activities in a locked phase are view-only (PRD 7.4). A critical gate requires every activity in the gate phase to be Verified before the next phase opens; if the gate is the last phase, the system cannot be declared audit-ready (PRD 7.4).

### 5.7 audit_prep_task.status (TS 6.7)

| From | To | Condition | Performed by |
|---|---|---|---|
| (generated) | not_started | Preparation window opens (`scheduled_at - prep_window_days`) | System |
| not_started | in_progress | | Task owner |
| in_progress | done | Completion evidence or note filled | Task owner |
| any | blocked | `note` filled | Task owner, MS Manager |
| not_started, in_progress | overdue | AUTOMATIC when `due_at` passes | System |

Exits from `blocked` and `overdue` are not listed [A-23].

### 5.8 cycle_requirement_status.status (TS 6.8)

Values: `not_started`, `in_progress`, `done`, `blocked`, `overdue`.

- Items with a pack `derivation` are computed automatically. Example: `MGMT_REVIEW` becomes `done` only when the current cycle's `management_review` is `closed` and `inputs_complete` is true for the MS.
- Items without a derivation are updated manually by the owner.
- `overdue` is set automatically when `due_at` passes and the status is not `done`.

No transition table is given [A-23].

### 5.9 Chain record display status (TS 6.9)

Every chain record has one display status derived from its source entity by one server function shared by Modules 1, 2 and 3 (TS 9.6). Values: `ready`, `pending`, `overdue`, `missing`.

| Stage (27001) | ready | pending | overdue | missing |
|---|---|---|---|---|
| Context issue | Reviewed within 12 months | Annual review due within 60 days | Not reviewed for more than 12 months | n/a |
| Risk | Assessed and residual accepted by owner | Awaiting residual approval, or reassessment due | Assessment older than 12 months, or approval past due date | Risk without a context issue (when the pack requires it) |
| Treatment | implemented, residual_accepted, closed | proposed, approved, in_progress | delayed | Risk without a treatment |
| Control | implemented or not_applicable | partially_implemented, planned, not_started | blocked | n/a |
| SoA entry | Applicable with risk justification, or not applicable with justification | Applicable without a risk link | n/a | Control not yet assessed |
| Document | approved | in_review, draft | expired | Applicable control without an implementing document |
| Evidence | freshness fresh and link_status valid | freshness aging | freshness expired or critical, or link_status not valid | Operating control without operating evidence |
| Metric | Measured within the period | Measurement for the current period due | Not measured for more than two periods | High-risk control without a metric |

Other frameworks use a derivation table from the pack with the same structure, for example BIA overdue when RTO exceeds MTPD, or Associate overdue when due diligence has expired. "Missing" rows describe absent records [A-35].

### 5.10 v1.0 machines carried forward (states known from v2.4 text only)

| Entity | States visible in v2.4 | Known rules |
|---|---|---|
| document | draft, in_review, approved, expired (TS 6.9; PRD 7.3 filters) | Past review date becomes expired automatically (PRD 6.3, BR-10). No self-approval (BR-16, TS 7.1). New version in the repository triggers an offer to register a new document version (PRD 11.4). Actions by status: Start review (expired), Open review (in review), Continue draft (draft), Upload new version (approved) |
| risk_treatment | proposed, approved, in_progress, delayed, implemented, residual_accepted, closed (TS 6.9) | Cannot complete without ResidualAcceptance by the Risk Owner; the implementer cannot approve it (PRD 6.3, BR-04) |
| finding | Classification Major, Minor, OFI, Signal, Not a finding (PRD 8.1); statuses not given | Cannot close without RCA, systemic check and an effectiveness verification dated differently from implementation (PRD 6.3, BR-06 to BR-08) |
| corrective_action | Flow: correction → RCA → systemic check → corrective action → effectiveness verification by a different person (PRD 8.1) | Cannot be verified by its implementer (BR-09). RCA and systemic check mandatory for Major findings. One corrective action may close similar findings from a joint audit (PRD 8.2) |
| certification_cycle | certified is referenced by 5.2 | Three-year cycle per MS (PRD 9) |

### 5.11 Other status fields

| Field | Values | Set by |
|---|---|---|
| storage_repository.connection_status | ok, degraded, failed, revoked | Connection test and daily check (TS 5.1); revoked when credentials are revoked or expired (TS 5.7) |
| Licence state (implied) | valid, grace (for `grace_days` after `valid_until`), read-only | `license.check` (TS 2.5, BR-37) |
| management_system_version | Two rows during a transition; audit trail records the active edition on every change (TS 3.4) | Edition Transition Assistant |
| drift_result | open (`resolved_at` null), resolved | BR-48, BR-49 |

## 6. Business rules

### 6.1 Evaluation model (TS 3.5, TS 8)

- Each rule has an `applies_to` attribute (list of `framework_code`, or `ALL`) in the pack's `rules.json`. The pack also carries activation and parameters.
- The engine evaluates only rules active for the MS of the entity.
- For a shared entity, the rule is evaluated for every linked MS. A violation in any one MS is enough to reject the transition.

### 6.2 BR-01 to BR-20 (TS 8.1, with behaviour from PRD 6.3 and PRD 8.2)

TS 8.1 gives only a summary for each rule and says the v1.0 logic is unchanged. The one-to-one split of grouped rules follows the order of the summary text [A-01].

| ID | Trigger | Effect | Scope | v2.0 change |
|---|---|---|---|---|
| BR-01 | Setting an applicability entry to implemented without evidence from the current period | Status rejected; system offers partially implemented or planned (PRD 6.3) | ALL | Adds the condition that the evidence `link_status` is valid (intact or moved per TS 6.1) |
| BR-02 | Applicable entry without a link to a risk | Save blocked until the relation is filled (PRD 6.3) | ISO27001, ISO37001 | Restricted by framework |
| BR-03 | Exclusion justification that is not meaningful | Warning only | ALL | Per-language phrase dictionary in the pack [A-07] |
| BR-04 | Completing a risk treatment without residual acceptance | Blocked; separate approval flow; the implementer cannot self-approve (PRD 6.3) | ALL | Unchanged |
| BR-05 | Risk above appetite | Escalation [A-07] | ALL | Unchanged |
| BR-06 | Closing a finding without root cause analysis | Rejected; RCA mandatory for Major findings (PRD 8.2) | ALL | Unchanged |
| BR-07 | Closing a finding without a systemic check | Rejected; mandatory for Major findings (PRD 8.2) | ALL | Unchanged |
| BR-08 | Effectiveness verification dated the same day as implementation | Rejected (PRD 6.3, 8.2) | ALL | Unchanged |
| BR-09 | Corrective action verified by its implementer | Rejected; enforced at data level (PRD 6.3) | ALL | Unchanged |
| BR-10 | Document past its review date | Automatically expired; shown on the owner's dashboard; blocks readiness of related clauses in every MS that uses it (PRD 6.3) | ALL | Unchanged |
| BR-11 | Evidence expired | Downgrades the applicability entry and creates a task for the owner (PRD 9.2) | ALL | Unchanged |
| BR-12 | Starting the next phase before a critical gate passes | Rejected; the next phase stays locked (PRD 7.1 Gate Enforcement) | ALL | Critical gates read from the pack `activity_template` |
| BR-13 | Management review with incomplete mandatory inputs | Review not complete [A-07] | ALL | Inputs from pack `review_input_def`, evaluated per MS |
| BR-14 | Management review without recorded decisions | Review not complete [A-07] | ALL | Same as BR-13 |
| BR-15 | Finding overdue | Flag and notify [A-07] | ALL | Unchanged |
| BR-16 | Document approved by its own author | Rejected; approval is always separate from creation (TS 7.1) | ALL | Unchanged |
| BR-17 | Risk without an owner | Blocked [A-07] | ALL | Unchanged |
| BR-18 | Register unchanged across cycles | Regression signal (PRD 9.1 Regression Detector) [A-07] | ALL | Unchanged |
| BR-19 | Delete | Soft delete only; no role can physically delete (TS 1.1, 7.1) | ALL | Unchanged |
| BR-20 | External auditor access | Read-only, time-limited, logged (TS 7.1) | ALL | Adds restriction to the audited MS |

### 6.3 BR-21 to BR-38 (TS 8.2)

| ID | Trigger | System action | User message |
|---|---|---|---|
| BR-21 | Creating an MS on a framework that is not in the licence | Reject | This framework is not yet included in your organisation's licence. Contact your administrator. |
| BR-22 | Changing a shared entity linked to more than one MS | Show the list of affected MS; ask for confirmation | This change also applies to: [list of systems]. Continue? |
| BR-23 | Linking evidence to another framework's requirement through a mapping with `evidence_reusable = false` | Warning; allow with a note | This requirement is similar but not identical. Make sure this evidence really satisfies both. |
| BR-24 | `rto_hours > mtpd_hours` on a prioritised activity | Block | Recovery time must not exceed the maximum tolerable period of disruption. |
| BR-25 | BC plan without an exercise in the programme period | Change to untested; create a task | This plan has not been tested in the current period. Schedule an exercise. |
| BR-26 | Business associate with risk above low and no valid due diligence | Flag; create a task | This associate needs a due diligence check that is still valid. |
| BR-27 | Gift or hospitality above the threshold without approval | Block final save | This value exceeds the policy limit and requires approval. |
| BR-28 | User outside the compliance function accesses a concern | Reject; log | You do not have access to this report. |
| BR-29 | Submitting a file to a repository that cannot be reached | Reject; no silent fallback | Repository [name] cannot be reached. Try again later or contact your administrator. |
| BR-30 | A repository with `ownership_type = personal` is used for evidence | Dashboard warning; allow | Files in personal storage can be lost when their owner leaves. Consider a shared library. |
| BR-31 | Evidence with a non-valid `link_status` | Downgrade the applicability entry; create a task | The evidence file can no longer be verified in [repository]. Re-link it or upload the correct version. |
| BR-32 | New version detected on an evidence file | Flag as anomaly; do not downgrade status | This evidence file was changed after it was submitted. The recorded evidence remains the earlier version. |
| BR-33 | MS uses an edition with status withdrawn | Mark critical on the dashboard and Executive View | The edition of the standard in use is past its transition period. |
| BR-34 | Evidence pack contains non-valid evidence | List it in the exceptions section of the manifest | (none) |
| BR-35 | Zero-transit mode and the user asks for an in-app preview | Redirect to the repository | This file opens directly in [repository] in line with your organisation's policy. |
| BR-36 | `produced_at` later than `provider_created_at` by more than 1 day | Warning for the reviewer | The evidence date is later than the file creation date. Check the date again. |
| BR-37 | Licence expired beyond the grace period | Read-only mode; nothing deleted | The licence has expired. Data can still be read and exported. |
| BR-38 | Routing change that would put new restricted files in the SaaS Managed Vault | Require confirmation by a second Tenant Admin | Restricted files will be stored in the provider's cloud. This change needs a second approval. |

Why BR-29 has no automatic fallback (TS 8.3 box): for customers who chose a customer repository because files may not leave it, a silent fallback would be the product itself breaching customer policy. A visible failure is better than an unnoticed compliance breach.

### 6.4 BR-39 to BR-50, drill-down (TS 8.3)

| ID | Trigger | System action | User message |
|---|---|---|---|
| BR-39 | Activity set to blocked without a gate item reference or a reason | Reject | State what is holding this activity and which gate item causes it. |
| BR-40 | Activity whose output is a controlled document set to complete without `output_document_id` | Reject | Link the output document from the register before marking this complete. |
| BR-41 | A not-ready item has a due date after `scheduled_at` of the next audit event | Mark After audit in every list | This due date falls after the audit on [date]. Bring the due date forward or prepare an explanation. |
| BR-42 | Audit event date changes | Recompute After audit flags; notify affected holders | The audit date has changed. [n] of your items are now due after the audit. |
| BR-43 | Preparation task with `due_at` on or after the audit date | Reject save | Preparation tasks must be finished before the audit starts. |
| BR-44 | Finding-closure preparation task generated for the first audit of an MS | Skip that task | (none) |
| BR-45 | Pending item without `owner_user_id` | Show as Unassigned; count as a readiness risk | This item has no holder yet. Assign it to one person. |
| BR-46 | Gate phase holds more or fewer blocked activities than open gate items | Flag the inconsistency for the MS Manager | The number of blocked activities does not match the open gate items. Check the blocking references. |
| BR-47 | Output document status contradicts activity status (e.g. document approved while the activity is blocked because of it) | Warning | Document status and activity status do not match. Check one of them. |
| BR-48 | A `drift_rule` matches a record | Create a `drift_result`; show it in the Regression Detector | The `message` of the `drift_rule_def` |
| BR-49 | A drifted record returns to normal | Set `resolved_at`; remove from active counts | (none) |
| BR-50 | Send reminder to the same person for the same item more than once within 72 hours | Hold the send; show the time of the last reminder | The last reminder was sent at [time]. Try again after [time]. |

### 6.5 Integrity rules restated in PRD 6.3

| Rule | Applies to | Enforcement | BR |
|---|---|---|---|
| ApplicabilityEntry cannot be implemented without at least one Evidence in the current cycle | All | Status rejected; system offers partial or planned | BR-01 |
| Applicable entry must have a justification referencing at least one Risk | 27001, 37001 | Save blocked | BR-02 |
| A requirement declared not applicable needs a justification and must not affect the ability to meet customer requirements | 9001 | Save blocked without justification; warning when the requirement is outside clause 8 | BR-03 variant [A-07] |
| RiskTreatment cannot finish without ResidualAcceptance by the Risk Owner | All | Separate approval flow | BR-04 |
| Finding cannot close without RCA, systemic check and effectiveness verification dated differently from implementation | All | Same-day verification rejected | BR-06 to BR-08 |
| CorrectiveAction cannot be verified by its implementer | All | Enforced at data level | BR-09 |
| Document past review date becomes Expired | All | Owner dashboard; blocks clause readiness in every MS using it | BR-10 |
| Prioritised activity needs a BIA with RTO and MTPD; RTO must not exceed MTPD | 22301 | Save blocked | BR-24 |
| BC Plan without an Exercise in the programme period is untested | 22301 | Plan status lowered; task for the plan owner | BR-25 |
| Business Associate above low risk needs a valid DueDiligence | 37001 | Associate flagged; task for the control owner | BR-26 |
| Evidence whose file cannot be verified in the customer repository does not count | All, customer repository | Integrity lowered; treated like expired evidence | BR-31 |

## 7. RBAC

### 7.1 Principles (TS 7.1)

- Business roles are granted per management system (`user_ms_role`). One user can be MS Manager in the QMS and Domain Owner in the ISMS.
- Administrative roles are organisation-wide (Tenant Admin) or platform-wide (Platform Operator) and do not grant read access to business data by default.
- Domain Owners see only entities they own (row-level security on `owner_user_id`), across all MS.
- External Auditors are read-only, time-limited, limited to the audited MS, and every access is logged.
- No role can physically delete.
- Approval is always separate from creation.

### 7.2 Personas and labels (PRD 4, PRD 4.1)

| Generic role | ISO/IEC 27001 | ISO 9001 | ISO 22301 | ISO 37001 | Main modules |
|---|---|---|---|---|---|
| MS Manager | ISMS Manager | QMS Manager / Quality Management Representative | BCMS Manager / BCM Coordinator | Anti-Bribery Compliance Function | All |
| Programme Owner | CISO | Head of Quality | Head of BCM / Resilience | Chief Compliance Officer | 1 and 3 |
| Top Management | Top Management | Top Management | Top Management | Top Management and Governing Body | 3 |
| Domain Owner | Domain Owner | Process Owner | Activity / Plan Owner | Control Owner | 1 |

Other personas: Risk Owner (approves residual risk, monitors treatments, Module 1), Internal Auditor (Module 2), External Auditor (guest, read-only, Module 2), Tenant Administrator (administration), Platform Operator (operations console). Domain Owners need plain-language tasks without knowing which standard asks for them; My Tasks is cross-framework by default (PRD 4).

### 7.3 Administrative and new roles (TS 7.2)

| Role | Scope | Main permissions | Must not |
|---|---|---|---|
| Tenant Administrator | Organisation | Activate MS, manage users and SSO, connect repositories, routing rules, licence | Read concern and investigation content; approve documents or risks |
| Storage Administrator | Organisation | Manage `storage_repository` and routing; view Link Health Monitor | Change business data |
| Platform Operator | SaaS: platform. On-premise: the installation | Operations, updates, diagnostics, jobs | Read tenant business data (SaaS); break-glass access is logged |
| Compliance Investigator | ISO 37001 MS | Create, read, update assigned concerns and investigations | Handle a concern in which they are the reported party |

### 7.4 Permission matrix for new entities (TS 7.3)

C = create, R = read, U = update, D = soft delete, A = approve or verify, `-` = no access. The v1.0 matrix for older entities still applies per MS [A-01].

| Entity | Tenant Admin | Storage Admin | MS Manager | Domain Owner | Internal Auditor | Top Mgmt | External Auditor |
|---|---|---|---|---|---|---|---|
| management_system | CRUD | R | RU | R | R | R | R (audited MS) |
| framework / pack | R, install pack | R | R | - | R | - | - |
| entity_ms_link | R | - | CRUD | R | R | R | R |
| storage_repository | CRUD | CRUD | R | - | - | - | - |
| storage_routing_rule | CRUD | CRUD | R | - | - | - | - |
| storage_object | R (metadata) | R | CRU | CRU (own) | R | - | R (in pack) |
| applicability_entry | - | - | CRUD | RU (own) | R | R | R |
| BIA, bc_plan, exercise | - | - | CRUD | CRU (own) | R | R | R |
| business_associate, due_diligence | - | - | CRUD | CRU (own) | R | R | R |
| gift_hospitality_record | - | - | CRUA | CR (own) | R | R | R |
| concern, investigation | - | - | CRU (compliance function) | - | R aggregate | R aggregate | - |
| license | CRU | - | - | - | - | R | - |

Programme Owner, Risk Owner and Compliance Investigator have no column [A-16].

### 7.5 Separation of duties (TS 7.4, PRD 6.3, PRD 8.2)

| Rule | Implementation |
|---|---|
| All v1.0 rules (no self-approval of documents, independent verifier of corrective actions, residual acceptance by the Risk Owner) | Kept, evaluated per MS |
| Concession approver for nonconforming output differs from the reporter | `CHECK nonconforming_output.authorised_by <> created_by` |
| Gift or hospitality approver differs from the giver or receiver | Application validation on `gift_hospitality_record` |
| Investigator is not the reported party | Application validation; recorded as a conflict of interest if forced |
| A Tenant Admin who is also MS Manager cannot change the storage routing of their own MS without approval from another Tenant Admin | Four-eyes flow on `storage_routing_rule` when there are 2 or more admins [A-50] |
| Activity verifier differs from the owner | `CHECK verified_by_user_id <> owner_user_id` (TS 4.9) |

### 7.6 Drill-down and pending-per-person visibility (TS 7.5)

| View | MS Manager | Programme Owner | Domain Owner | Top Mgmt | Internal Auditor | External Auditor |
|---|---|---|---|---|---|---|
| Summary, phase and chain stage drill-downs | Full | Full | Own records only | Full (read) | Full (read) | Only within the evidence pack |
| Pending per person, everyone | Yes | Yes | No | Aggregate per unit | No | No |
| Pending per person, self | Yes | Yes | Yes (same as My Tasks) | Yes | Yes | No |
| Audit preparation checklist | Full | Full | Own tasks | Read | Read | No |
| Drift and cycle completeness | Full | Full | No | Read | Read | No |

The pending-per-person view may be read as individual performance assessment. This matrix is a proposal and must be confirmed with HR before release (TS 7.5, PRD 15.4).

### 7.7 ISO 37001 confidentiality (PRD 6.2, BR-28)

Concern and Investigation hold whistleblower and reported-party data. Access is limited to the Anti-Bribery Compliance Function and the assigned investigator. All other roles, including MS Managers of other frameworks and Top Management, see aggregate statistics only. Anonymous reporting must be supported. The audit trail of access to these entities is reviewed separately. Fields `reporter_contact_encrypted` and `summary_encrypted` use field-level encryption.

## 8. Audit trail

| Requirement | Source |
|---|---|
| Undeletable trail of every status change, approval, upload, file link and storage configuration change | PRD 12 (Audit Trail, P0) |
| All status changes are undeletable; deletion is logical with a record of who and when | PRD 13 Traceability |
| Access logs, change logs and access-control evidence available to the tenant and its external auditors, on both modes | PRD 10.2, PRD 13 Auditability |
| Every change records the active edition (two `management_system_version` rows during a transition) | TS 3.4 |
| The audit trail module must be able to read soft-deleted records | TS 1.1 |
| Every External Auditor access is logged | TS 7.1, BR-20 |
| Rejected access to a concern is logged | BR-28 |
| Access to concern and investigation is reviewed separately | PRD 6.2 |
| Platform Operator break-glass access to tenant business data is logged | TS 7.2 |
| Deletion of pass-through temp files is recorded in the technical log | TS 5.3 |
| Index `(entity_type, entity_id, created_at DESC)` for one entity's history | TS 4.8 |
| Audit trail is stored in PostgreSQL with the structured data | TS 2.1 |

The TS does not define the `audit_trail` columns. `docs/ARCHITECTURE.md` 10.5 adds actor, action, entity reference, before and after values, active edition, request id, source IP, time and a hash chain [A-01].

## 9. Soft delete

- `deleted_at` nullable on every entity. Physical deletion is forbidden except a verified purge when a SaaS tenant is offboarded after the contractual retention period (TS 1.1, PRD 10.2).
- Every application query filters `deleted_at IS NULL` by default. The audit trail and evidence pack modules must be able to read deleted records. The data access layer needs both modes from the start (TS 1.1) [A-09].
- No role can physically delete; D in the matrix means soft delete (TS 7.1, 7.3, BR-19).
- Edition transition archives relations whose requirement was removed; it never deletes them (TS 3.4).
- An archived MS keeps its data (TS 6.2).
- An expired licence never deletes or locks customer data; it switches to read-only (TS 2.5, BR-37).
- A disabled storage adapter makes the repository read-only for the application; existing links are still verified (TS 5.7).
- Drift history is kept after resolution (TS 4.9).

## 10. Freshness engine

### 10.1 Rules (PRD 9.2, PRD 9.7, TS 4.4, TS 6.1)

1. Every requirement or control has an OperatingCriteria with an operating frequency: daily, monthly, quarterly, annual or per event (PRD 9.2 list). The pack carries 7 `evidence_frequency_rules` for ISO 27001 (PRD 5.2).
2. Age is computed from the date the evidence was produced (`produced_at`), never the upload or link date.
3. Freshness bands: Fresh, Aging, Expired, Critical (`fresh`, `aging`, `expired`, `critical`). Thresholds are configurable per tenant and per framework [A-42].
4. Integrity runs in parallel. Fresh evidence whose file is gone from the customer repository is treated like expired evidence.
5. Expired or unverifiable evidence lowers the ApplicabilityEntry and creates a task for the owner (BR-11, BR-31). PRD 9.7: Expired, Critical or unverified evidence lowers the related control or requirement to Partial until new evidence is submitted.
6. The automatic transition is `implemented` → `partially_implemented` when `freshness_status` is expired or `integrity_status` is broken (TS 6.1). Re-promotion is a manual MS Manager transition requiring valid evidence in period.
7. A new version detected on an evidence file is an anomaly that does not lower status (BR-32).
8. Revoked or expired credentials do not lower evidence status until 72 hours have passed (TS 5.7). `verification_pending` counts as valid for up to 7 days; `access_denied` counts during the 72-hour grace period (TS 6.4).
9. Stored columns on `applicability_entry`: `last_evidence_at`, `freshness_status`, `integrity_status` (all DERIVED). Every module reads these columns; drill-downs never call external repositories (TS 9.5).

### 10.2 Thresholds

The TS and PRD give no numeric thresholds. The current prototype (`freshOf` in `app/src/data/mscd-data.js`) uses, with `p` the period in days and `age` the days since `produced_at`:

| Band | Condition |
|---|---|
| fresh | `p = 0` (per event), or `age <= p + 1` |
| aging | `age <= 1.25 * p + 1` |
| expired | `age <= 2 * p` |
| critical | otherwise |

Prototype periods: daily 1, weekly 7, monthly 30, quarterly 91, semi-annual 182, annual 365, per event 0 (no expiry). `docs/ARCHITECTURE.md` 6.2 adopts these as configurable defaults.

### 10.3 Related display items

- Evidence freshness explorer cards: Evidence fresh, Aging, Expired, Critical, File cannot be verified, Documents due in 30 days (PRD 9.7).
- Next due date of evidence = `produced_at` + period (PRD 9.7 column "next evidence due").
- Chain stage Evidence: ready when fresh and link valid; pending when aging; overdue when expired, critical or link not valid (TS 6.9).

## 11. Storage abstraction

### 11.1 Configurations (PRD 11.1)

Customer Repository covers file content only (documents and evidence attachments). Structured data (registers, applicability, findings, statuses, chain relations) always stays in the application database.

| Configuration | Structured data | File content | Fits |
|---|---|---|---|
| A. SaaS + Managed Vault | Provider cloud | Provider cloud | Ease first |
| B. SaaS + Customer Repository | Provider cloud (metadata and references) | Customer repository (Microsoft 365, Google Workspace) | SaaS accepted but confidential documents may not be copied out |
| C. On-premise + Managed Vault | Customer data centre | Object storage in the customer data centre | Regulated bodies that require all data inside |
| D. On-premise + Customer Repository | Customer data centre | Customer repository: cloud (Microsoft 365, Google Workspace) or internal (file share, S3-compatible) | Organisations with an existing managed document repository |

### 11.2 Modes and content exposure (PRD 11.2, TS 4.5)

| Mode (`storage_repository.mode`) | Behaviour | Does content pass the application server? |
|---|---|---|
| Managed Vault (`stored`) | Uploaded and stored by the application with versions and SHA-256 | Yes, and stored |
| Pass-through (`pass_through`) | User uploads through the app; the app forwards straight to the customer folder and computes the checksum in transit, without storing | Yes, briefly, not stored |
| Link (`link`) | User picks an existing file through the repository file picker; the app records reference and version | No |
| Zero-transit (`zero_transit`) | Browser uploads directly to the repository with the user's credentials; the app receives metadata only; fingerprint comes from the repository hash | Never |

Mode can be set per MS and narrowed by classification rules. Example: Restricted files must use Zero-transit; other files may use the Managed Vault (PRD 11.2) [A-36].

### 11.3 Supported repositories (PRD 11.3)

| Repository | Modes | Recommendation | Priority |
|---|---|---|---|
| Microsoft 365, SharePoint Online document library | SaaS, on-premise | Recommended: dedicated compliance library with managed permissions and retention | P0 |
| Microsoft 365, OneDrive for Business | SaaS, on-premise | Allowed with a warning: files belong to a personal account (BR-30) | P0 |
| Google Workspace, Shared Drive | SaaS, on-premise | Recommended: files owned by the organisation | P1 |
| Google Workspace, My Drive | SaaS, on-premise | Allowed with the same warning as personal OneDrive | P1 |
| Internal file share (SMB/CIFS, NFS) | On-premise | Internal or air-gapped networks | P1 |
| Customer S3-compatible object storage | SaaS (secured public endpoint), on-premise | High-volume evidence archive | P2 |
| SharePoint Server, WebDAV, Nextcloud | On-premise | On customer request | P2 |

Adapter enum (TS 4.5): `managed_vault`, `m365`, `google_drive`, `smb`, `s3`, `webdav` [A-38].

### 11.4 Routing

- `storage_routing_rule` maps (MS or whole organisation, classification, object kind) to a repository; the most specific rule wins, with `priority` as the ordering field (TS 4.5).
- `management_system.default_storage_repository_id` is the default for new files (TS 4.2).
- A Tenant Admin who is also MS Manager needs a second admin to change their MS routing (TS 7.4). Routing that sends new restricted files to the SaaS Managed Vault needs a second Tenant Admin (BR-38).

### 11.5 Storage provider interface (TS 5.1)

Business modules know only `storage_object`; they never know which adapter is behind it.

| Operation | Input | Output | Notes |
|---|---|---|---|
| test_connection | repository | status, effective permissions | Used at configuration and in the daily check |
| put | repository, folder_hint, stream, metadata | external_item_id, version_id, hash | managed_vault and pass_through; the stream is never written to local disk |
| link | repository, external_item_id | version_id, hash, metadata | Link mode, called after the file picker |
| register_client_upload | repository, external_item_id reported by the browser | version_id, hash, metadata | Zero-transit; the app verifies the item exists and reads metadata from the repository, not the browser |
| stat | storage_object | current metadata, current version_id | Used by the link health check |
| pin_version | storage_object | ok / unsupported | Stops repository version retention from purging the version, where supported |
| open_url | storage_object, viewer | Time-limited URL or repository link | Never a permanent URL |
| stream | storage_object | stream | managed_vault and pass_through only; rejected for zero_transit |
| copy_within | storage_objects, target_folder | List of new items | Repository-side copy for evidence packs |
| ensure_folder | repository, path | folder_id | Creates the conventional folder structure |

### 11.6 Adapter matrix (TS 5.2)

| Adapter | Authentication and minimum permission | Versions | Hash | Repository-side copy |
|---|---|---|---|---|
| managed_vault | Internal | Object storage versioning | SHA-256 (computed) | Yes |
| m365 (SharePoint, OneDrive for Business) | App registered in Microsoft Entra ID. Recommended application permission `Sites.Selected` granted only on the compliance site; zero_transit uses the user's delegated token. App authentication by certificate, not client secret | driveItem version id | quickXorHash (provider); SHA-256 when pass_through | Yes (asynchronous copy) |
| google_drive | Service account added as a member of a specific Shared Drive, or delegated OAuth with scope `drive.file` through Google Picker. Avoid domain-wide delegation | revision id; `keepForever` for binary files | `sha256Checksum` for binary files (provider); not available for native Google documents | Yes (`files.copy`) |
| smb | Domain service account limited to the compliance share | None; uses hash + size + mtime | SHA-256 (computed, inside the customer network) | Yes (file copy on the share) |
| s3 | Access key or role with a policy limited to the bucket or prefix | VersionId; bucket versioning must be on | Object SHA-256 checksum when supported, otherwise computed | Yes (CopyObject) |
| webdav | Service account | Server dependent | computed | Server dependent |

Provider API capabilities can change: verify each item against the official Microsoft Graph and Google Drive API documentation when building adapters, and include automated contract tests (TS 5.2).

### 11.7 File handoff flows (TS 5.3)

**Pass-through**

1. Browser uploads to `api`; `api` forwards the stream to `storage-gateway` without writing to disk (bounded memory buffer, or an encrypted temp file deleted at once for large files).
2. `storage-gateway` computes SHA-256 while writing to the customer repository through an upload session.
3. The repository returns item id and version id; `storage_object` is created with `hash_source = computed`.
4. The temp file is deleted and the deletion is recorded in the technical log.

**Link**

1. Browser opens the repository file picker (OneDrive/SharePoint picker or Google Picker) with the user's token.
2. Browser sends the chosen item id to `api`.
3. `storage-gateway` calls `link`: reads current version id, provider hash and metadata directly from the repository, then pins the version.

**Zero-transit**

1. `api` issues a time-limited upload intent: target folder, size limit, correlation code.
2. Browser uploads directly to the repository with the user's delegated token (for example a Microsoft Graph upload session or a Google Drive resumable upload).
3. Browser reports item id and correlation code to `api`.
4. `storage-gateway` verifies the item in the repository (exists, in the right folder, created after the intent was issued) and reads the provider hash. Browser metadata is not trusted.
5. When the repository has no hash for that file type, `storage_object` gets `hash_source = none` and integrity relies on the version id only. This is shown to users and auditors.

### 11.8 Folder convention (TS 5.4)

```text
{root}/{MS code}/{cycle}/{evidence|documents}/{requirement or item code}/{evidence_code}_{produced_at}.{ext}

/Compliance/ISMS-JKT/2026-2029/evidence/A.8.13/EV-0412_2026-09-20.pdf
/Compliance/_packs/ISMS-JKT/Stage2-2026/        evidence pack copy
```

With `metadata_minimization = true`, file names use the evidence code only, without a title.

### 11.9 Link health check (TS 5.5)

Scheduling: a worker job checks storage objects periodically by priority: (1) evidence that supports an `implemented` status, (2) evidence going into a scheduled evidence pack, (3) the rest. Default frequency daily for high priority and weekly for the rest, rate limited per repository.

```text
result = adapter.stat(obj)
IF result.not_found                          THEN status = "missing"
IF result.forbidden                          THEN status = "access_denied"
IF result.item_id moved to another folder    THEN status = "moved"   (still valid; update location)
IF result.version_id <> obj.external_version_id:
    IF the pinned version can still be fetched THEN status = "version_changed"
    ELSE                                          status = "pinned_version_lost"
IF obj.hash_source = "provider" AND the pinned version hash differs THEN status = "hash_mismatch"
IF the repository cannot be reached          THEN keep status, mark "verification_pending"
OTHERWISE                                         status = "intact"
```

See [A-06] and [A-08] for precedence and computed-hash checks. Results drive BR-31 (downgrade and task), BR-32 (anomaly for evidence) and the document new-version offer (PRD 11.4).

### 11.10 Failure modes (TS 5.7)

| Condition | System behaviour |
|---|---|
| Repository unreachable | Structured data keeps working. New files for that repository are rejected with a clear message; no silent fallback to the Managed Vault (BR-29). Integrity uses the last result, marked `verification_pending` |
| Credentials revoked or expired | `connection_status = revoked`; Tenant Administrator notified; related evidence is not downgraded until 72 hours have passed, so a temporary revocation does not cascade |
| Provider rate limit | Exponential backoff; health check rescheduled; users unaffected |
| Adapter disabled by the licence | Repository becomes read-only for the application; old links are still verified |

### 11.11 Feature impact (PRD 11.5)

| Feature | Managed Vault | Customer Repository |
|---|---|---|
| File preview | In the app | Through repository preview or direct link; Pass-through may proxy without storing (Zero-transit: BR-35) |
| Search | Metadata and file content | Metadata only; content is not indexed |
| Evidence pack | Downloadable archive | Manifest (index with links, versions and hashes) plus a pack copy made inside the customer repository |
| Checksum | SHA-256 computed by the app | SHA-256 (Pass-through) or repository hash (Link, Zero-transit) |
| File retention | Enforced by the app | Customer responsibility; the app verifies existence |
| Availability when the repository is down | Not affected | Structured data works; integrity uses the last check, marked pending |
| External auditor access | Guest access in the app | Guest access for structured data; files through the pack copy shared by the customer, or a proxy on Pass-through |

### 11.12 Responsibilities (PRD 11.7) and retention advice (PRD 11.4)

| Responsibility | Provider / application | Customer |
|---|---|---|
| Confidentiality and integrity of structured data | SaaS: provider. On-premise: the app provides controls, the customer operates | On-premise: infrastructure, server access, database backup |
| Confidentiality and availability of file content (customer repository) | Does not store; only verifies | Access permissions, retention, backup and recovery of the repository |
| Connector credentials | Stored encrypted; minimum permissions requested | Grant and revoke permissions; manage the registered app in Microsoft 365 or Google Workspace |
| Broken link detection | Scheduled checks and alerts | Act on alerts |

The system recommends a repository retention policy (for example Microsoft Purview retention labels or Google Vault rules) on compliance folders and records the customer's confirmation (`retention_confirmed`).

## 12. File integrity states

| Concept | Values | Where |
|---|---|---|
| `storage_object.link_status` | intact, moved, version_changed, verification_pending, hash_mismatch, pinned_version_lost, missing, access_denied | TS 6.4 (validity rules in 5.4 above) |
| `applicability_entry.integrity_status` | ok, degraded, broken | TS 4.4, derived from the latest evidence's storage object [A-05] |
| `storage_object.hash_source` | computed, provider, none | TS 4.5 |
| `storage_object.hash_algorithm` | sha256, sha1, md5, quickxor, none | TS 4.5 |
| `storage_repository.connection_status` | ok, degraded, failed, revoked | TS 4.5 |
| UI wording (PRD 8.2, 11.4) | intact, version changed, moved, missing, access revoked, cannot be verified | Golden Thread file nodes, Link Health Monitor |

Valid evidence = `intact`, `moved`, `version_changed`; plus `verification_pending` for up to 7 days and `access_denied` for 72 hours. Evidence with `hash_source = none` (native Google documents) is integrity-by-version only and is a drift pattern in PRD 9.6.

## 13. Notifications, tasks and reminders

| Item | Rule | Source |
|---|---|---|
| Notification Engine (P0) | Email and in-app: review date, aging evidence, overdue tasks, open gate, broken file links | PRD 12 |
| Transport | `mail.transport`: provider email service (SaaS) or customer SMTP relay (on-premise) | TS 2.4, PRD 10.1 |
| Proactive alerts | Link checks are scheduled and alerts are pushed, not left until a user opens the app | PRD 9.3 box |
| Document Review Calendar | Tiered alerts before and after the review date; overdue documents plus those due in the next four months, grouped by month with an Overdue group first | PRD 9.1, 9.8 |
| Credential revocation | Tenant Administrator notified | TS 5.7 |
| Audit date change | Affected holders notified with the count of their items now due after the audit | BR-42 |
| Automatic tasks | Created by BR-11 (expired evidence), BR-25 (untested BC plan, for the plan owner), BR-26 (associate due diligence, for the control owner), BR-31 (unverifiable evidence) | TS 8, PRD 6.3, PRD 9.2 |
| Transition tasks | Created for split, merged and changed mappings and for new requirements without relations | TS 3.4 |
| Audit preparation checklist | Generated from the pack template when the window opens (`scheduled_at - prep_window_days`, default 60); all due dates before the audit; finding-closure tasks skipped on an MS's first audit (BR-44); framework-specific tasks added (BC exercise for 22301, governing body approval of gift thresholds for 37001) | TS 4.9, 6.7, PRD 9.4 |
| Send reminder | `POST /reminders` with `entity_ref`, `recipient`; available as a drill-down action in Modules 2 and 3 | TS 9.2, PRD 8.6 |
| Reminder throttle | Same person, same item, more than once in 72 hours: held, last reminder time shown | BR-50 |
| Unassigned items | Shown as Unassigned and counted as a readiness risk | BR-45, PRD 12.3 |
| My Tasks | Cross-framework list of everything the user owes, in plain language, with accepted evidence examples and a one-step submit | PRD 4, 7.1 |
| Channels | Email and in-app stated; Teams or Slack and the reminder frequency are open questions | TS 10.2, PRD 15.4 |

## 14. Evidence pack

| Aspect | Rule | Source |
|---|---|---|
| Purpose | Cut audit preparation from 2 to 3 weeks to under 1 working day | PRD 3.1, 3.2 |
| Scope | Per clause, per control, per framework; worker selects evidence by pack scope (MS, clause, control, period) | PRD 8.1, TS 5.6 |
| Managed Vault | Downloadable archive file | PRD 11.5 |
| Customer repository | `storage-gateway` ensures the pack folder exists and calls `copy_within` per file. File content never passes through the app | TS 5.6, PRD 11.6 |
| Manifest | PDF and CSV listing `evidence_code`, requirement, `produced_at`, `external_version_id`, `hash_algorithm`, `hash_value`, `link_status` at build time, and the copy location | TS 5.6 |
| Manifest storage | Saved in the same pack folder and recorded as a `storage_object` | TS 5.6 |
| Exceptions | Evidence whose `link_status` is anything other than intact or moved is listed in the manifest's exceptions section, never silently skipped (BR-34) [A-10] | TS 5.6 |
| Pack folder | `/Compliance/_packs/{MS code}/{event}/` | TS 5.4 |
| Deleted records | The evidence pack module must be able to read soft-deleted records | TS 1.1 [A-09] |
| Auditor access | External auditor reads storage objects only inside the pack; the customer shares the repository pack folder per its sharing policy | TS 7.3, PRD 11.6 |
| Job priority | Evidence going into a scheduled pack is priority 2 in the link health check | TS 5.5 |

## 15. Framework packs

### 15.1 Pack contents (TS 3.1, PRD 5.2)

A Framework Pack is a signed archive. The v1 seed dataset (11 datasets, 762 rows) is repackaged as `ISO27001-2022` version 1.0.0 without content changes.

```text
ISO27001-2022-1.0.0.pack
├── manifest.json             identity, edition, pack version, dependencies, checksums
├── requirements.csv          clause tree (replaces clause_requirements)
├── catalogue.csv             catalogue items (replaces annex_a_controls)
├── applicability_model.json  applicability target, mandatory justification, labels
├── risk_profile.json         dimensions, scales, risk objects
├── traceability_chain.csv    chain nodes and mandatory flags
├── activities.csv            phases and activities, critical gates
├── audit_activities.csv
├── finding_conditions.csv
├── document_templates.csv
├── evidence_frequency_rules.csv
├── review_inputs.csv         mandatory management review inputs
├── labels.{id,en}.json       label dictionary
├── mappings/*.csv            mappings to other frameworks
├── rules.json                business rule activation and parameters
├── modules.json              specialised workbenches to enable
└── signature
```

| Content | Purpose | ISO 27001 example (seed v1) |
|---|---|---|
| Requirement tree | Clauses and subclauses, mandatory documented information flag | clause_requirements, 30 rows |
| Catalogue (optional) | Selectable controls or control steps | annex_a_controls, 93 rows |
| Applicability model | What is assessed, which justification is mandatory, artefact label | Statement of Applicability |
| Risk profile | Impact dimensions, scale, risk objects | CIA, likelihood x consequence 1 to 5 |
| Traceability chain | Chain node order and mandatory nodes | 10 steps, 6 mandatory |
| Activity template | Implementation phases and activities, critical gates | 69 activities, 9 phases |
| Audit template | Stage 1, Stage 2 and surveillance audit activities | 28 activities |
| Finding condition library | Conditions with classification and clause reference | 401 conditions |
| Document templates | Document catalogue and ID convention | 105 rows |
| Evidence frequency rules | Freshness thresholds per frequency | 7 rules |
| Review input definition | Mandatory management review inputs | Seven inputs of clause 9.3.2 |
| Label dictionary | UI terms per language (ID, EN) and per role | ISMS, ISMS Manager, SoA |
| Cross-mapping | Requirement mapping to other frameworks | New in v2.0 |
| Specialised modules | Workbenches to enable | None for 27001 |

Also pack-supplied from v2.4 but missing from the tree: `cycle_requirement_def`, `drift_rule_def`, `prep_task_template`, chain stage auditor questions (PRD 8.5), chain status derivation tables for other frameworks (TS 6.9) [A-12].

### 15.2 Manifest (TS 3.1)

```json
{
  "pack_id": "ISO9001-2026", "pack_version": "1.0.0", "framework_code": "ISO9001",
  "edition": "2026", "status": "current",
  "supersedes": {"edition": "2015", "transition_ends": "[set per IAF or certification body decision]"},
  "engine_min_version": "1.5.0", "modules": ["process_map", "customer_feedback", "nonconforming_output"],
  "applicability_target": "requirement", "catalogue": false,
  "datasets": {"requirements.csv": "sha256:...", "...": "..."}
}
```

The signing algorithm for packs is not stated in the TS (only the licence states Ed25519) [A-17].

### 15.3 Lifecycle (TS 3.2, PRD 5.2, PRD 10.1)

1. **Validate:** signature, dataset checksums, `engine_min_version` compatibility, referential integrity (for example every `finding_condition` references an existing requirement).
2. **Install:** datasets load into global reference tables keyed by (`framework_version_id`, code). Atomic: any partial failure rolls back fully.
3. **Activate:** the Tenant Administrator creates a ManagementSystem on that `framework_version`. Templates (activities, documents, editable libraries) are copied into the tenant space; reference content is not copied.
4. **Minor update:** content fixes within the same edition (for example a new finding condition). Applied automatically to reference content; tenant copies of templates are offered as updates, never overwritten.
5. **Edition transition:** the new edition pack is installed side by side (15.5).

Distribution: SaaS packs are distributed automatically and the tenant chooses when to activate a new edition; on-premise packs come through the online channel or an offline bundle (`packs.channel`).

### 15.4 Label resolution (TS 3.3)

The UI never shows table names. Every term comes from the label dictionary with a generic key. The Integrated view uses the engine's generic labels.

| Key | ISO27001 | ISO9001 | ISO22301 | ISO37001 |
|---|---|---|---|---|
| ms.name | ISMS | QMS | BCMS | ABMS |
| ms.manager_role | ISMS Manager | QMS Manager | BCMS Manager | Anti-Bribery Compliance Function |
| applicability.artefact_name | Statement of Applicability | Requirement Applicability | BCMS Scope Determination | Control Proportionality |
| catalogue.item_name | Control | (none) | (none) | Anti-bribery control |
| risk.object_name | Information security risk | Risk or opportunity | Disruption risk | Bribery risk |

### 15.5 Edition transition (TS 3.4, PRD 9.3)

Mappings between editions live in `mappings/` with relation types `equivalent`, `split`, `merged`, `changed`, `new`, `removed`. The Edition Transition Assistant runs:

```text
FOR EACH relation r IN the MS (document, evidence, applicability) THAT REFERENCES old requirement q:
  m = mapping[q]
  IF m.type = equivalent              THEN copy the relation to the new requirement, mark auto_mapped
  IF m.type IN (split, merged, changed) THEN create a transition_task for the MS Manager
  IF m.type = removed                 THEN archive the relation, do not delete
FOR EACH new requirement without an incoming relation: create a transition_task (gap)
```

- The MS keeps running on the old edition while the new pack is installed alongside.
- During transition the MS has two `management_system_version` rows; the audit trail records the active edition on every change.
- The MS moves to the new edition after the transition audit (MS status transitioning → certified), with old-edition history kept for audit.
- `framework_version` moves current → transition → withdrawn (5.3); an MS still on a withdrawn edition is critical (BR-33).

### 15.6 Supported frameworks (PRD 5.3)

| Aspect | ISO/IEC 27001 (ISMS) | ISO 9001 (QMS) | ISO 22301 (BCMS) | ISO 37001 (ABMS) |
|---|---|---|---|---|
| Reference edition | 2022 + Amd 1:2024 | 2026 (published 16 Sep 2026); 2015 + Amd 1:2024 during transition | 2019 + Amd 1:2024 | 2025 (published Feb 2025); 2016 during transition |
| Catalogue | Annex A, 93 controls | None; clause 8 operational requirements | None; BC strategies and solutions | Clause 8 control steps (due diligence, financial and non-financial controls, gifts and others) |
| Applicability artefact | Statement of Applicability | Justification of requirements that cannot be applied in scope | Determination of in-scope products, services and activities | Proportionality of controls based on bribery risk assessment |
| Risk approach | Information security risk, CIA impact | Risks and opportunities | BIA (MTPD, RTO, RPO) and disruption risk assessment | Bribery risk per position, transaction, associate and region |
| Workbenches | None | Process Map, Customer Feedback, Nonconforming Output | BIA Workbench, BC Plan Library, Exercise Programme | Due Diligence Register, Gifts and Hospitality Register, Concerns and Investigations |
| Critical gate (PRD 7.1) | Risk and SoA | Risk and Opportunity + Process Map | BIA and Risk Assessment | Bribery Risk Assessment |

Packs must hold the current edition and the previous edition for the transition period set by accreditation and certification bodies. ISO 9001:2026 subclause numbering must be verified against the official text when the pack is written; editions and transition periods must be confirmed with the customer's certification body.

### 15.7 Content rules

- Packs hold numbering, short titles and provider guidance only; never the official ISO text (PRD 3.3). `title_short` is "a short title, not the standard's text" (TS 4.1). Copyright position is an open question (TS 10.2, PRD 15.4).
- Activity content is shown in the pack's authoring language; UI labels follow the user's language; translation columns are prepared per the seed data README (PRD 7.4).
- Content depth for ISO 9001, 22301 and 37001 is a separate content work-stream with release criteria (minimum activities, finding conditions, templates) (PRD 5.2, 15.1).

## 16. Licence and entitlements

### 16.1 Format (TS 2.5)

A licence is a JSON document signed with Ed25519. The application verifies the signature with a public key embedded in the image, so on-premise validation needs no connection.

```json
{
  "license_id": "LIC-2026-0142", "organization": "Client A",
  "valid_from": "2026-10-01", "valid_until": "2027-09-30", "grace_days": 30,
  "frameworks": ["ISO27001", "ISO9001"], "max_management_systems": 4, "max_users": 400,
  "storage_adapters": ["managed_vault", "m365"], "features": ["integrated_mode"],
  "signature": "ed25519:..."
}
```

### 16.2 Entitlements and enforcement

| Entitlement | Enforcement |
|---|---|
| `frameworks` | Creating an MS on an unlicensed framework is rejected (BR-21); Framework Library activates only licensed frameworks (PRD 5.4) |
| `max_management_systems` | MS creation requires "licence allows" (TS 6.2) [A-15] |
| `max_users` | Not specified [A-39] |
| `storage_adapters` | An adapter removed from the licence makes its repositories read-only for the app; old links are still verified (TS 5.7) |
| `features` | e.g. `integrated_mode`; PRD 12 lists licensable features generally |
| Validity | After `valid_until`, a grace period of `grace_days`; after that, read-only mode. Data is never deleted or locked; it stays readable and exportable (TS 2.5, BR-37) |
| Validation mode | `license.validation`: online (SaaS, subscription enforced service-side) or offline (on-premise default, signed file) (TS 2.4, PRD 10.1) |
| Permissions | `license`: Tenant Admin CRU, Top Management R (TS 7.3) |

The licence model (per framework, per MS, per user, or a mix) is still open (PRD 15.4).

## 17. Deployment

### 17.1 Logical components (TS 2.1)

Both modes use the same release artefact: a set of signed container images. The listed technologies are recommendations as long as interfaces are kept.

| Component | Responsibility | Reference technology | Scaling |
|---|---|---|---|
| web | SPA and static assets | Nginx container or equivalent | Horizontal, stateless |
| api | Application API, RBAC, state machines, business rules | Application container | Horizontal, stateless |
| worker | Scheduled and async jobs: freshness engine, link health check, notifications, evidence pack, import | Application container, worker mode | Horizontal per queue |
| storage-gateway | The only component that talks to storage providers; runs adapters | Application container, gateway mode | Horizontal; can sit in a separate network zone |
| database | Structured data, audit trail | PostgreSQL 15 or later | Primary + replica |
| queue / cache | Job queue, session cache | Redis, or a PostgreSQL-based queue for small installs | Primary + replica |
| object storage | Managed Vault, evidence pack artefacts, imports | S3-compatible | By volume |
| secrets / KMS | Data encryption keys, connector credentials | SaaS: cloud KMS. On-premise: HashiCorp Vault, customer HSM, or encrypted file-based key | n/a |
| license-service | Licence validation and entitlements | Module inside api; offline signature validation | n/a |

The storage-gateway is separate because only connectors need outbound access to Microsoft Graph or Google APIs. On-premise customers can place this single component in an egress-allowed zone, and security review focuses on the one point that holds repository credentials.

### 17.2 Deployment profile keys (TS 2.4)

Code reads capabilities, never the mode name.

| Key | Values | SaaS | On-premise |
|---|---|---|---|
| `tenancy.mode` | multi, single | multi | single |
| `tenancy.isolation` | schema, database | schema | database |
| `license.validation` | online, offline | online | offline (default) |
| `updates.channel` | managed, online, offline | managed | online or offline |
| `packs.channel` | managed, online, offline | managed | online or offline |
| `telemetry.enabled` | boolean | true (operational) | false (default) |
| `kms.provider` | cloud_kms, vault, hsm, file | cloud_kms | vault, hsm or file |
| `identity.providers` | local, saml, oidc, ldap | local, saml, oidc | local, saml, oidc, ldap |
| `mail.transport` | provider, smtp | provider | smtp |
| `storage.adapters.enabled` | adapter list | managed_vault, m365, google_drive, s3 | managed_vault, m365, google_drive, smb, s3, webdav |
| `network.egress_allowlist` | host list | provider managed | filled by the customer |

`docs/ARCHITECTURE.md` 11.1 adds `jobs.driver` (pgboss or bullmq).

### 17.3 SaaS (TS 2.2, PRD 10.2)

- Multi-tenant, one cluster per region. Isolation: PostgreSQL schema per organisation, Row-Level Security on `organization_id` as a second layer, and a per-tenant data key (envelope encryption with KMS).
- Region chosen per tenant at onboarding, including an Indonesian region for data residency; cannot move without a managed migration. All tenant data, backups and application logs holding tenant data stay in that region.
- Tenant connector credentials are encrypted with the tenant key; provider operators cannot read them in plain text.
- Rolling updates with schema migrations backward compatible by one version, in announced maintenance windows.
- Offboarding: full export of structured data and Managed Vault files in open formats, then verified deletion after the contractual retention period.
- The system itself is auditable: access logs, change logs and access-control evidence available to the tenant and its auditors.

### 17.4 On-premise (TS 2.3, PRD 10.3)

| Variant | Target | Package contents | Notes |
|---|---|---|---|
| Kubernetes (primary) | Production | Helm chart, signed images, HA reference values, NetworkPolicy manifests | Supported distributions in the compatibility matrix |
| Docker Compose | Small installs, PoC, lab | Compose file, images, init scripts | No HA; not for large production |
| Offline bundle | Air-gapped | All images, Helm chart, Framework Packs, migration scripts, checksums and signatures | Imported into the customer's internal registry |

Indicative sizing (must be validated by load tests before becoming contractual):

| Profile | Users / MS | Resources |
|---|---|---|
| Small (Compose) | Up to 150 users, 1 to 2 MS | 1 VM: 8 vCPU, 32 GB RAM, 500 GB SSD; local object storage |
| Medium (Kubernetes) | Up to 1,000 users, up to 6 MS | 3 worker nodes of 8 vCPU, 32 GB RAM; PostgreSQL primary + replica; 2 TB object storage |
| Large (Kubernetes) | Over 1,000 users or many subsidiaries | Designed per case with the customer's infrastructure team |

Outbound connections:

| Destination | Component | Required? | Note |
|---|---|---|---|
| Provider update channel | api | No | Only when the customer chooses online updates |
| graph.microsoft.com, login.microsoftonline.com | storage-gateway | Only with the Microsoft 365 adapter | HTTPS 443 |
| www.googleapis.com, oauth2.googleapis.com | storage-gateway | Only with the Google Drive adapter | HTTPS 443 |
| Customer IdP, SMTP relay, file share, internal S3 | api, worker, storage-gateway | As configured | Inside the customer network |

Other on-premise requirements (PRD 10.3): works air-gapped (licence, packs and updates as signed offline packages); uses customer services when available (PostgreSQL, S3-compatible storage, SMTP, IdP, NTP, backup); at least the last three minor releases supported with a documented upgrade path; remote support only through sessions opened and supervised by the customer. Feature parity is a product promise: every feature must pass tests in both modes; exceptions only for inherently operational items (such as automatic updates), listed in a published parity matrix.

### 17.5 Mode comparison (PRD 10.1)

| Aspect | SaaS | On-premise |
|---|---|---|
| Location | Provider cloud, region per data residency need | Customer servers in the customer data centre |
| Tenancy | Multi-tenant; per-tenant schema and encryption key | Single-tenant; one install per organisation (many MS and subsidiaries allowed) |
| Operation | Provider: install, update, monitor, back up, restore | Customer infrastructure team, with provider support per contract |
| Identity | Local accounts with MFA, or SSO via SAML 2.0 / OIDC | Same plus LDAP / Active Directory |
| App updates | Automatic rolling in announced windows | Signed release package; customer chooses timing |
| Pack updates | Automatic; tenant chooses when to activate a new edition | Online channel or offline bundle |
| Licence | Subscription, enforced service-side | Signed licence file validated offline |
| Email | Provider email service | Customer SMTP relay |
| Outbound | Not relevant to the customer | Optional: online update channel and cloud repository connectors only |
| Telemetry | Operational service metrics | Off by default; diagnostics exported manually by the customer after redaction |
| Default file storage | Managed Vault in the provider cloud | Managed Vault on object storage in customer infrastructure |
| Customer Repository | Supported | Supported, including repositories on the internal network |

## 18. Read model and API conventions

### 18.1 Principles (TS 9.1)

- **One derivation source.** Every number, derived status and flag (freshness, chain record status, After audit, locked) is computed by the same server function for all modules. The client never recomputes status.
- **Server-side aggregation.** Summary cards, chip counts and stage readiness are sent as aggregates; lists are sent separately and paginated.
- **Filters and search as parameters.** Status, frequency, stage, holder and keyword use the same query parameters on every endpoint.
- **Stable cross links.** Every record carries a ref sufficient to open its source entity: `{module, entity_type, id}`.

### 18.2 Read model endpoints (TS 9.2)

| Endpoint | Main parameters | Returns | Module |
|---|---|---|---|
| `GET /ms/{ms}/implementation/summary` | | Five summary cards, phases with derived text | 1 |
| `GET /ms/{ms}/applicability` | status, group, q, page | Applicability items with documents, evidence, integrity | 1 |
| `GET /ms/{ms}/documents` | status, type, q, due_within | Document register with shared documents and item links | 1, 3 |
| `GET /ms/{ms}/gates` | | Gate items with affected entities | 1 |
| `GET /ms/{ms}/phases/{n}/activities` | | Phase activities with derived status and output | 1 |
| `GET /ms/{ms}/audit/event/next` | | Next audit event and panel numbers | 2, 3 |
| `GET /ms/{ms}/audit/stages` | | Readiness per chain stage | 2 |
| `GET /ms/{ms}/audit/stages/{key}/records` | status, q, page | Stage records with action, holder, due date, upstream, downstream | 2 |
| `GET /ms/{ms}/audit/chain` | anchor_id | One complete chain from the chosen node | 2 |
| `GET /ms/{ms}/audit/pending` | owner, stage, overdue_only | Pending items across stages; aggregated per person when owner is empty | 2 |
| `GET /ms/{ms}/surveillance/events/{id}` | | Event detail, preparation checklist, findings to close or results | 3 |
| `GET /ms/{ms}/surveillance/cycle` | cycle_id | Cycle completeness | 3 |
| `GET /ms/{ms}/surveillance/drift` | rule | Active drift patterns with affected records | 3 |
| `GET /ms/{ms}/evidence` | freshness, frequency, q | Evidence with next due, freshness, integrity | 3 |
| `POST /reminders` | entity_ref, recipient | Reminder (BR-50) | 2, 3 |

Version prefix, write endpoints, auth and rate limits are outside the TS (TS 10.3); `docs/ARCHITECTURE.md` 13 sets `/api/v1`, explicit transition endpoints, RFC 9457 errors with the rule id, and a `warnings` array for warn-and-allow rules [A-20].

### 18.3 Pending record contract (TS 9.3)

```json
{
  "ref": {"module": "audit", "stage": "risk", "entity_type": "risk", "id": "R-003"},
  "title": "Loss of customer data through unencrypted backup media",
  "status": "pending",
  "state": "Residual risk awaiting owner sign-off",
  "action": "Sign off residual risk",
  "holder": {"user_id": "...", "display_name": "Bambang Sutrisno", "role_label": "Head of IT"},
  "due_at": "2026-10-05", "days_to_due": 8, "after_audit": false,
  "upstream": [{"stage": "ctx", "id": "INT-004"}],
  "downstream": [{"stage": "treat", "id": "TR-003"}],
  "file": {"repository": "SharePoint, Compliance Library", "link_status": "intact"}
}
```

`status` is one of `ready`, `pending`, `overdue`, `missing` [A-21].

### 18.4 After audit derivation (TS 9.4)

```text
next_event  = audit_event WHERE management_system_id = ms AND scheduled_at >= TODAY
              ORDER BY scheduled_at LIMIT 1
after_audit = status <> "ready" AND due_at IS NOT NULL AND next_event IS NOT NULL
              AND due_at > next_event.scheduled_at
```

Recomputed automatically when the audit date changes (BR-42). PRD 8.7 calls this the most important feature of Module 2 [A-22].

### 18.5 Performance and caching (TS 9.5)

- Summary aggregates and stage readiness are stored in per-MS summary tables, updated on write and re-verified by a daily job.
- Drill-down lists are paginated at 200 rows; client search works on the loaded page, server search on the whole set.
- Freshness and `link_status` are read from stored columns; drill-downs never call external repositories synchronously.
- Targets: drill-down opens under 2 seconds; filter and search under 300 ms on a loaded page.

### 18.6 One number, one function (TS 9.6)

The expired document count appears on the Module 1 card, the Module 2 Document stage and the Module 3 review calendar. Implement one derivation function per concept, test with a snapshot that compares the three modules, and fail the build when they differ.

### 18.7 Other API-relevant conventions

- Unlisted state transitions are rejected (TS 6).
- Rule messages are fixed user-facing texts per rule (TS 8); BR-22 and BR-38 need a confirm step; BR-23, BR-30, BR-32, BR-36, BR-47 warn without blocking.
- `open_url` returns time-limited URLs, never permanent ones (TS 5.1).
- Enum values are short `snake_case` strings (TS 1.1).
- Deep links carry the MS identity (PRD 5.4).
- Public API contract, versioning and rate limiting are out of the TS scope (TS 10.3).

## 19. Module features and drill-down behaviour

### 19.1 Module 1 features (PRD 7.1)

| Feature | Description | Priority |
|---|---|---|
| Phase Tracker | Activity progress per phase from the framework template, with owner, output and outcome | P0 |
| Gate Enforcement | Next phase locked until gate criteria pass; critical gates from the pack | P0 |
| Document Register | ID, tier, version, owner, approver, approval date, review date, storage location, MS using it | P0 |
| Applicability Builder | Pre-loaded catalogue; applicability, justification, implementation status, document and evidence refs. Shown as SoA Builder on 27001 | P0 |
| Risk Register and Treatment | Named owner, framework risk profile, treatment options, residual approval | P0 |
| Clause Readiness Meter | Readiness per clause and per catalogue theme, with open gate items | P0 |
| My Tasks | Cross-MS tasks with plain-language instructions and examples of accepted evidence | P0 |
| Framework Workbench | Pack-enabled workbenches (BIA, Process Map, Due Diligence, Gifts and Hospitality) | P0 for released frameworks |
| Shared Artefact Manager | Mark and review shared artefacts; show impact per MS | P1 |
| Orphan Detector | Documents not linked to any requirement, and requirements without an implementing document, per MS | P1 |
| Bulk Import | From Excel workbooks or another MS of the same organisation | P1 |
| Template Library | Document skeletons following the ID convention | P2 |

Readiness must never be a single percentage that hides gaps: show the score with unmet gate items per MS, and never average readiness across frameworks (PRD 7.2).

### 19.2 Module 1 drill-downs (PRD 7.3, 7.4)

- Five summary cards open lists and stay visible as tabs: Controls / Requirements implemented, Partially implemented, Open gate items, Documents approved, Documents expired. Content follows the active framework (27001: 93 Annex A controls by theme A.5 to A.8; others: clause 4 to 10 requirements by clause).
- Control and requirement list: status chips with counts (All, Implemented, Partial, Planned, Not started, Blocked, Not applicable; zero-count chips hidden); live search by ID, title, owner, note or implementing document; columns ID, title and status note, status, owner, implementing document, last evidence with freshness, file location with integrity; gate-holding marker in the row; row detail with applicability and justification, linked risks (27001) or risk basis, implementing document with status and version, operating frequency, last evidence; document IDs cross-link both ways.
- Document register: status chips All, Approved, Expired, In review, Draft; grouped by tier (Policies, Standards, Procedures, Plans, Registers, Records, Forms); columns ID, title, status, owner, version, approval date, review due with late or due-soon marker, file location; shared documents show other frameworks (shared IDs prefixed `IMS-`); unlinked documents flagged as Orphan Detector candidates.
- Phase drill-down: phase cards as tabs with computed text; counts Verified, Complete (awaiting verification), In progress, Blocked, Not started or Locked; banners for critical gate, locked phase (names the holding gate phase with a link) and completed phase; activity table with number, activity, owner action, owner, required output, status, completion or due date, grouped by clause when the template has clauses; detail with expected outcome, required output and its document status, blocking reason referencing the gate item; actions Mark complete, Record blocker, Verify output, Open gate item.
- Consistency: blocked activities in a gate phase must equal open gate items and each must reference its gate item; document outputs must point to the register so activity and document status never contradict (BR-46, BR-47).

### 19.3 Module 2 features (PRD 8.1)

| Feature | Description | Priority |
|---|---|---|
| Audit Activity Planner | Stage 1 and Stage 2 activities per framework, with auditee, key questions, evidence to request | P0 |
| Finding Condition Library | Conditions per framework (Major, Minor, OFI, Signal, Not a finding) as the self-assessment base | P0 |
| Self-Assessment Workbench | Per condition: status, supporting evidence, PIC, target fix date | P0 |
| Golden Thread Viewer | Chain per pack definition in one screen, with broken-chain markers and file integrity | P0 |
| Evidence Pack Generator | Per clause, control, framework; on customer repository a manifest plus repository-side copy | P0 |
| Finding Register | Framework, classification, source, clause, tracking to closure | P0 |
| Corrective Action Workflow | Correction, RCA, systemic check, corrective action, effectiveness verification by a different person | P0 |
| Integrated Audit Planner | One audit event across frameworks; shared requirement mapping avoids auditing twice | P1 |
| Internal Audit Programme | Multi-year programme with coverage mapping against all requirements of each MS, and independence checks | P1 |
| Auditor Guest Access | Read-only, time-limited, limited to the audited framework | P1 |
| Mock Audit Mode | Audit simulation from the condition library, auditor-style report | P2 |

Golden Thread node content (PRD 8.2): identity, status and named owner; mandatory upstream and downstream relations or a red marker with the violated clause; for file nodes the production date, cycle marker, storage location and integrity; Shared marker with a link to the chain in the other MS. Render time is recorded as a proxy for the auditor traceability test.

### 19.4 Module 2 drill-downs (PRD 8.3 to 8.7)

- Next audit event panel: name, date, days left; open items along the chain, overdue or missing, due after the audit date, records ready.
- Interactive traceability test: chain picker (all risks or equivalent upstream nodes, with random pick); nodes coloured green ready, yellow pending, red broken (overdue, missing or no relation); not-ready nodes show holder and due date; nodes open the stage drill-down on the record; warning text generated from data (break count, cause, holder, due date, pending nodes).
- Readiness per chain stage: stage name with the auditor's likely question (from the pack), three-colour bar and ready percentage, records, pending, overdue or missing, after audit, next due.
- Stage drill-down: stages as tabs with open counts; summary Records, Ready, Pending, Overdue, Missing, Due after audit; filters Open (default), All, Pending, Overdue, Missing, Ready; search by ID, title, person or status; columns ID, record and current state, status, pending action, holder (name and role), due date with late, due-soon and After audit markers; detail with auditor question, clickable upstream and downstream links, file location and integrity, and an explanation when the due date is after the audit; actions Send reminder, Reassign, Change due date, Trace from here. Control, SoA, Document and Evidence stages use the same data as Module 1.
- Pending per person: per holder the open, overdue and after-audit counts, nearest due date and stages held, sorted by most overdue; clicking a person lists all their items across stages by nearest due date.

### 19.5 Module 3 features (PRD 9.1)

| Feature | Description | Priority |
|---|---|---|
| Certification Cycle Timeline | Three-year timeline per MS; combined view to spot audit merging opportunities | P0 |
| Evidence Freshness Engine | Evidence age against operating frequency, plus link integrity on customer repositories | P0 |
| Document Review Calendar | Tiered alerts around review dates | P0 |
| Cycle Completeness Check | Risk assessment, internal audit, management review with all mandatory inputs, and for 22301 the exercise programme | P0 |
| Regression Detector | Risk register unchanged across cycles, management review inputs disappearing, metrics no longer updated, expired due diligence, untested BC plans | P0 |
| Edition Transition Assistant | Automatic gap analysis old to new requirements, transition task list, transition deadline | P1 |
| Change Trigger Monitor | New system, new supplier, reorganisation, significant incident, new business associate in a risky region | P1 |
| Management Review Pack | Mandatory inputs compiled into one discussion-ready file, per framework or joint | P1 |
| Executive Summary View | One screen for top management across frameworks: decisions needed, risks above appetite, finding trends | P1 |
| Surveillance Scope Predictor | Predicts likely sampled areas from prior findings | P2 |

### 19.6 Module 3 drill-downs (PRD 9.4 to 9.8)

- Audit event detail: all events show date, audit days, audit type, certification body and lead auditor, scope, expected focus. Next event adds chain readiness (link to Module 2), the preparation checklist (all due before the audit) and previous findings that must be shown closed. Past events show the result and findings with today's status. Planned events show the preparation window date (default 60 days before) and the cycle prerequisites the auditor will check.
- Cycle completeness: risk assessment, performance measurement and analysis, internal audit, management review with all mandatory inputs, corrective action closure, timely document review, plus framework items (exercise programme for 22301; compliance function report to the governing body for 37001; customer satisfaction analysis and edition transition tasks for 9001). Each item has clause reference, owner, status, due date and condition note. The main page shows the top four.
- Drift drill-down: each pattern shows affected count and opens a list (ID, title, current status, holder, due date) linking to the source record. Example patterns: risk not reassessed in 12 months, unverifiable evidence files, metrics no longer updated, BC exercise not scheduled, expired due diligence, native Google document evidence without a hash.
- Evidence freshness explorer: see 10.3; frequency rows (Daily to Per event) filter the list; status and frequency filters combine; search by evidence code, control or requirement, owner; columns evidence code, control or requirement, frequency, production date, next due, freshness, file location and integrity, owner.
- Review calendar: overdue documents and those due in the next four months, grouped by month, Overdue first, in Module 1 register row format so review can start from the calendar.

### 19.7 Cross-module features (PRD 12)

| Feature | Priority |
|---|---|
| Management System Switcher | P0 |
| Framework Library (activation, edition, scope, certification body) | P0 |
| Role-Based Access Control (generic roles, per-framework labels, per-MS grants, admin roles) | P0 |
| Audit Trail | P0 |
| Notification Engine | P0 |
| Storage Repository Manager (connect, test, monitor; routing per MS and classification) | P0 |
| Link Health Monitor | P1 |
| License and Entitlement | P0 |
| Operations Console (service health, job queues, pack versions, diagnostic export; Platform Operator) | P1 |
| Search and Traceability Query (across entities and MS) | P1 |
| Reporting and Export (evidence packs, readiness reports, registers) | P1 |
| Localization (Indonesian and English UI; standard terminology kept in its original terms) | P1 |

Integrations (PRD 12.1) are optional and never a prerequisite; the system works fully with manual upload; on-premise integrations need no internet. Listed: identity directory (P1), vulnerability scanner (P1), ticketing / ITSM (P1), training platform (P2), ERP / procurement (P2), whistleblowing channel (P2). File repositories are core, not optional (P0).

### 19.8 Drill-down interaction pattern (PRD 12.2) and named accountability (PRD 12.3)

| Element | Behaviour |
|---|---|
| Breadcrumb | Shows position; one click back to the module home |
| Summary as tabs | Cards or stage rows that open a drill-down stay above the list with the active item highlighted |
| Filter chips | Status with counts; zero-count chips hidden except the default filter |
| Search | Filters rows live without reload; group counts update |
| Expandable rows | `+` shows details in place; open state remembered for the session |
| Cross links | Control, document and record IDs open the entity in its home module with details open |
| Follows framework | Switching framework inside a drill-down keeps the list type and loads the new framework's content |

Every pending item shows a person's name with their role. When several people hold a role, the item is assigned to one person. Items without a holder show as Unassigned and count as a readiness risk.

## 20. Non-functional requirements

### 20.1 PRD 13

| Aspect | Requirement |
|---|---|
| Security | TLS 1.2 or higher in transit, encryption at rest, MFA for all users, tenant data isolation on SaaS, classification-based access control, least-privilege connector permissions (only the designated folder or library) |
| Traceability | Status changes cannot be deleted; deletion is logical with who and when |
| Availability | SaaS: 99.5 percent per month. On-premise: HA reference architecture provided; achievement depends on customer infrastructure |
| Performance | Golden Thread Viewer under 3 seconds, independent of external repositories. List of 5,000 evidence rows under 2 seconds. MS switch under 1 second. Every drill-down opens under 2 seconds; in-list search and filter under 300 ms |
| Number consistency | Same number identical in every module, from one derivation function |
| Data retention | Evidence and records at least one full certification cycle (3 years), ideally two. On customer repository, metadata and verification history for the same period |
| System auditability | Access logs, change logs and access-control evidence available to external auditors in both modes |
| Scalability | Per organisation: up to 4 frameworks and 10 MS, 500 requirements and catalogue items per MS, 1,000 documents, 2,000 risks, hundreds of thousands of evidence items over a cycle |
| Portability | One release artefact for both modes; common Kubernetes distributions and Docker Compose |
| Offline operation | On-premise runs fully without internet, except cloud repository connectors |
| Ease of adoption | Domain Owners complete tasks without formal training, without clause numbers and without knowing which framework needs the task |

### 20.2 Other security points

- Per-tenant data keys with envelope encryption on SaaS; connector credentials encrypted with the tenant key (TS 2.2).
- Credentials only via `credential_ref` into secrets/KMS (TS 4.5).
- Microsoft 365 app auth by certificate, `Sites.Selected`; Google without domain-wide delegation (TS 5.2).
- Zero-transit never trusts browser metadata (TS 5.3).
- `web_url` not shared with auditors without permission; `open_url` time-limited (TS 4.5, 5.1).
- Field-level encryption for ISO 37001 concerns (TS 4.7).
- A threat model of the storage-gateway and connectors is advised before TS stage 7 (TS 10.3).

### 20.3 Internationalisation

- UI in Indonesian and English; standard terminology stays in its original terms (PRD 12).
- Pack label dictionary `labels.{id,en}.json`, keyed generically, per language and per role (TS 3.1, 3.3).
- Pack content (activities) shown in the pack's authoring language; UI labels follow the user (PRD 7.4).
- BR-03 phrase dictionary is per language (TS 8.1).
- Rule messages exist as user-facing text per rule (TS 8); both languages are needed.

### 20.4 Success metrics (PRD 3.2)

| Metric | Baseline | Target |
|---|---|---|
| Trace one control or requirement to operating evidence | 10 to 30 minutes | Under 30 seconds |
| Major NCs at first certification audit | Typically 3 to 8 | Zero |
| Evidence pack preparation | 2 to 3 working weeks | Under 1 working day |
| Requirements implemented without current-cycle evidence | Undetected until audit | Detected automatically; zero at audit |
| Documents past review date without action | Not tracked | Zero documents late by more than 30 days |
| Internal audit findings missing from the corrective action register | Found at external audit | Zero (prevented by the system) |
| Evidence reused across frameworks | Zero | At least 30 percent of clause 7, 9 and 10 evidence linked to more than one framework |
| On-premise install to ready | n/a | Under 2 working days on compliant infrastructure |
| Undetected broken links in customer repositories | n/a | Zero; every broken link detected within one check cycle |
| Answer "what is still pending before the audit, who holds it, when is it due" | Coordination meetings and manual roll-ups | Under 1 minute from one screen |
| Pending items due after the audit date | Discovered during the audit | Flagged from creation; zero on audit day |
| Summary number mismatch between modules | Common | Zero |

## 21. Build order and releases

### 21.1 TS 10.1 implementation stages

| Stage | Scope | Reason |
|---|---|---|
| 1 | Deployment profile, licence, users and roles per MS, audit trail, KMS abstraction | Foundation for both modes; expensive to add later |
| 2 | Framework Engine: generic reference tables, pack installer, label dictionary; package seed v1 as the ISO27001 pack | Every business entity depends on requirement and catalogue_item |
| 3 | management_system, entity_ms_link | Replaces scope_id; shapes every query |
| 4 | Storage Abstraction + managed_vault adapter + storage-gateway; document + document_version | No direct file_uri column from day one |
| 5 | context_issue, risk (with risk_profile), treatment, residual_acceptance, applicability_entry, operating_criteria | Upstream and downstream chain |
| 6 | State machines and BR-01 to BR-09, BR-21, BR-22 | Integrity before real data arrives |
| 7 | On-premise package (Helm, Compose), offline licence, m365 adapter | Release v1.0 |
| 8 | finding, corrective_action, self_assessment; joint audit | Module 2 |
| 9 | ISO9001 pack, google_drive adapter, Integrated mode | Release v1.5 |
| 10 | certification_cycle, freshness engine, link health check, transition assistant; ISO22301 pack | Module 3, release v2.0 |
| 11 | ISO37001 pack, zero_transit, smb and s3 adapters, offline update bundle | Release v2.5 |
| Cross-cutting | Drill-down read model (TS 9) and shared drill-down UI components; built with each module, contract fixed from stage 5 | Avoid three different drill-down implementations |

Parity testing from stage 1: run a CI pipeline that installs the app in two profiles, multi-tenant SaaS and single-tenant on-premise with telemetry off and no outbound connection, on every commit. Features that silently depend on the internet fail in the second profile before reaching customers.

`docs/ARCHITECTURE.md` 17 moves a basic freshness calculation to Phase 4 and a basic link health check to Phase 5.

### 21.2 PRD 14 releases

| Release | Scope | Done when |
|---|---|---|
| MVP | Multi-framework foundation (Framework, ManagementSystem, Requirement, CatalogueItem, ApplicabilityEntry) + ISO/IEC 27001 pack + core Module 1 + RBAC + Audit Trail + Storage Abstraction with Managed Vault + SaaS | One organisation builds a full ISMS without companion spreadsheets on a generic data model |
| v1.0 | Full Module 1 + core Module 2 + on-premise package (Kubernetes, Compose, offline licence) + Microsoft 365 adapter in Link and Pass-through modes | ISO 27001 Stage 1 and Stage 2 can run on SaaS and on-premise with evidence in the customer's SharePoint |
| v1.5 | ISO 9001 pack (2026, with 2015 during transition) + Switcher and Integrated mode + full Module 2 + Google Drive adapter | ISO 9001 and ISO 27001 share documents, internal audits and evidence in one system |
| v2.0 | ISO 22301 pack (BIA, BC Plan, Exercise) + full Module 3 + Link Health Monitor + Edition Transition Assistant | First surveillance passes without findings from regression or lost files |
| v2.5 | ISO 37001 pack (Due Diligence, Gifts and Hospitality, Concerns and Investigations) + Zero-transit + SMB and S3 adapters + air-gapped updates | All four frameworks on both modes and all four storage configurations |
| v3.0+ | Integrations (identity, vulnerability, ITSM, ERP), Mock Audit Mode, Surveillance Scope Predictor, P2 adapters | Evidence collected automatically for high-frequency controls |

Drill-down features by release: summary and phase drill-downs (PRD 7.3, 7.4) in MVP for ISO 27001 and with each new pack; Module 2 drill-downs (8.3 to 8.7) in v1.0; Module 3 drill-downs (9.4 to 9.8) in v2.0; interaction pattern and named accountability (12.2, 12.3) in MVP as shared UI components.

Framework order (9001, 22301, 37001) may change with the sales pipeline without architectural change; pack content must start at least one release ahead. MVP order: Framework and ManagementSystem first, then Document Register and Applicability Builder; Storage Abstraction built with the Document Register; Golden Thread Viewer last (PRD 14).

## 22. Open questions listed in the sources

TS 10.2 (to answer before coding):

| Question | Impact if unanswered |
|---|---|
| SaaS region and cloud provider | KMS, object storage and data residency |
| Kubernetes distribution and minimum PostgreSQL for on-premise | Compatibility matrix and test scope |
| Bundle PostgreSQL and object storage on-premise, or customer-provided | Support responsibility and third-party licences |
| Zero-transit mandatory from v1.0? | Whether file picker and direct browser upload enter stage 7 |
| Minimum depth of ISO9001, ISO22301, ISO37001 packs | Release criteria and domain expert needs |
| Can tenants edit the finding condition library? | Whether `finding_condition` needs a per-tenant copy |
| Copyright policy on clause and control titles in packs | `title_short` content and content licensing |
| External auditor access model for files in customer repositories | Whether a pass-through proxy is in the first release |
| Who may see pending per person? | RBAC filter on `GET /audit/pending` |
| Supported reminder channels | Notification integration for `POST /reminders` |

TS 10.3 (not covered by the TS): full public API contract, versioning and rate limiting; detailed UI/UX; user stories and acceptance criteria; detailed backup and DR per mode including service RPO and RTO; storage-gateway and connector threat model; automated test strategy including adapter contract tests.

PRD 15.4 adds: SaaS dedicated single-tenant option; licence model; owner and depth of the 9001, 22301, 37001 packs; editable or add-only finding conditions; zero-transit in v1.0; personal repositories allowed with warning or blocked by tenant config; Kubernetes and database support; ISO copyright and possible agreement with the national standards body; pending-per-person visibility (HR); reminder channel and frequency; whether audit event data can come directly from the certification body.

## 23. Ambiguities and gaps

| Id | Topic | Issue | Suggested handling |
|---|---|---|---|
| A-01 | Missing v1.0 baseline | The v1.0 data dictionary, the v1.0 state machines (document, risk_treatment, finding, corrective_action, certification_cycle), the v1.0 RBAC matrix, the `audit_trail` columns and the full text of BR-01 to BR-20 are referenced as unchanged but are not in the sources | Reconstruct from TS 6.9, PRD 6.3, PRD 8 and the prototype; record the reconstruction as an explicit design decision |
| A-02 | implementation_activity_progress | TS 6 says its v1.0 machine is unchanged, yet TS 6.6 defines a v2.4 machine | Treat TS 6.6 as authoritative |
| A-03 | audit_event.outcome | "enum v1.0" without values | Define values (for example recommended, recommended_with_conditions, not_recommended) and confirm |
| A-04 | Control status `blocked` | TS 6.9 and PRD 7.3 use a blocked control status; TS 6.1 has no `blocked` state | Either add `blocked` to `implementation_status` or derive it from gate items |
| A-05 | integrity_status mapping | ok, degraded, broken are not mapped from the eight `link_status` values | Proposed: intact, moved to ok; version_changed, verification_pending within 7 days, access_denied within 72 hours, and `hash_source = none` to degraded; all non-valid states to broken |
| A-06 | Link health precedence | The TS 5.5 pseudo-code is a list of independent IF lines; several can be true at once (moved and version changed) and the order is unclear | Evaluate unreachable first, then not_found, forbidden, hash, version, moved, else intact; store `moved` as a location update on top of the version result |
| A-07 | Grouped v1.0 rules | Split of BR-04/05, BR-06 to 09, BR-10/11, BR-13/14, BR-15 to 20 is inferred from summary order; effects of BR-05, BR-13, BR-14, BR-15, BR-17, BR-18 and the BR-03 "meaningful" test are not stated; PRD 6.3 adds an ISO 9001 exclusion rule with no BR id | Confirm ids and effects with the product owner before coding stage 6 |
| A-08 | Computed hash checks | `hash_mismatch` is only defined for `hash_source = provider`; re-verification of computed hashes (vault, pass-through, SMB hash + size + mtime) is not described | Re-hash on a slower schedule for vault and SMB, or compare provider size and mtime |
| A-09 | Deleted records in packs | Evidence packs must read deleted records, but which deleted records belong in a pack is not stated | Include records soft-deleted after the pack period start, flagged as deleted |
| A-10 | Pack exceptions vs validity | TS 6.4 counts version_changed and verification_pending as valid; TS 5.6 puts everything except intact and moved into exceptions | Follow TS 5.6 for the manifest, with the reason shown |
| A-11 | MS state gaps | No path for certificate suspension or withdrawal, failed transition audit, or leaving `archived`; certification_cycle states are undefined | Add explicit states or keep as admin-only corrections recorded in the audit trail |
| A-12 | Pack tree incomplete | `cycle_requirement_def`, `drift_rule_def`, `prep_task_template`, auditor questions per stage and non-27001 chain derivation tables are pack data but not in the TS 3.1 tree | Add dataset files (for example `cycle_requirements.csv`, `drift_rules.json`, `prep_tasks.csv`, `chain_status.json`) |
| A-13 | PRD-only entities | ExternalProviderEvaluation, ProductService, ComplianceFunctionReport, Scope are named in PRD 6 but not defined in TS 4 | Define minimal tables when the related pack is built |
| A-14 | Framework-specific machines | No roles per transition; `bc_plan` has no exit from `untested` and no condition for approved → tested; `concern` has no triaged → closed path | Roles: MS Manager or compliance function; untested → tested on a recorded exercise |
| A-15 | MS creation limits | "Licence allows" covers framework (BR-21) but the `max_management_systems` check has no rule id or message | Add a rule using the BR-21 pattern |
| A-16 | Missing matrix columns | Programme Owner, Risk Owner and Compliance Investigator are not columns of TS 7.3; External Auditor is described as a guest but listed as a role | Programme Owner = MS Manager read set; Risk Owner = Domain Owner plus residual acceptance; investigator per TS 7.2 |
| A-17 | Pack signature | TS 3.1 shows a `signature` file but no algorithm or key; only the licence states Ed25519 | Use Ed25519 with a key separate from the licence key (as in ARCHITECTURE 10.7) |
| A-18 | Integrity of evidence without a file | Evidence may have no storage object ("system link"); freshness and integrity for it are undefined | Treat integrity as ok and rely on freshness only |
| A-19 | MFA for LDAP users | PRD 13 requires MFA for all users; LDAP gives no second factor | Add TOTP or WebAuthn on top of LDAP binds |
| A-20 | API prefix and writes | TS 9.2 paths have no `/api/v1` prefix and no write endpoints | Follow ARCHITECTURE 13 |
| A-21 | ref.id type | TS 9.3 shows business ids (`R-003`, `INT-004`) in `ref.id`, while TS 1.1 makes UUID the primary key | Send UUID `id` plus a separate `code` field |
| A-22 | "Today" and time zone | After audit, overdue and freshness depend on "today" without a time zone | Use the organisation time zone for date comparisons |
| A-23 | Task status exits | `audit_prep_task` has no transitions out of `blocked` or `overdue`; `cycle_requirement_status` has values but no transition table | Allow blocked → in_progress and overdue → in_progress or done by the owner, for both entities |
| A-24 | Owner NOT NULL vs Unassigned | `owner_user_id` is NOT NULL on activity progress, prep tasks and cycle requirements, yet BR-45 expects items without an owner | Make owner nullable where BR-45 applies, or assign to the MS Manager by default |
| A-25 | Joint audit After audit | Which MS's next event applies to shared records, and how a joint `audit_event` with NOT NULL `management_system_id` maps to several MS | Primary MS in the column, others via `entity_ms_link`; After audit per MS |
| A-26 | BR-43 vs BR-42 | `CHECK due_at < event.scheduled_at` is a cross-table rule (needs a trigger or app check); moving an audit earlier can make existing tasks violate it | Re-validate on date change and flag violating tasks instead of failing the update |
| A-27 | Gate items | `blocker_gate_item_ref` and `/gates` rely on "gate items", but no gate item entity or derivation is defined | Derive gate items from pack gate criteria over applicability, risk, document records; define `gate_item_ref` format |
| A-28 | Nullable unique key | `UNIQUE (management_system_id, target_type, catalogue_item_id, requirement_id)` does not enforce uniqueness when one id is NULL | Use `NULLS NOT DISTINCT` (PostgreSQL 15+) or two partial unique indexes |
| A-29 | One primary per entity | "Exactly one is_primary" is not expressible as a column constraint | Partial unique index on (entity_type, entity_id) WHERE is_primary, plus a deferred check |
| A-30 | audit_event sharing | `audit_event` is shareable through `entity_ms_link` and also has `management_system_id` NOT NULL | See A-25 |
| A-31 | management_review sharing | Joint reviews use `entity_ms_link` while inputs carry their own `management_system_id`; closure and `inputs_complete` per MS need clarity | Review is complete for an MS when its inputs are complete; BR-13 per MS |
| A-32 | "System link" evidence | Evidence with `storage_object_id` NULL is "a system link", not defined | Model as a URL or external record reference field on evidence |
| A-33 | Risk profile format | `risk_profile.json` structure and scales are not specified | Define a schema (dimensions, scale bounds, matrix, appetite) in the pack format |
| A-34 | Concern and investigation ownership | "Compliance function" is the ISO 37001 MS Manager label, while the investigator is a separate role | Grant via `user_ms_role` on the ABMS only |
| A-35 | Missing records | TS 6.9 "missing" refers to absent records (risk without treatment); how they appear in lists, counts and `ref` is not defined | Emit virtual rows referencing the upstream record |
| A-36 | Mode per repository vs per classification | Mode is a property of `storage_repository`, while PRD 11.2 sets mode per MS and classification; Restricted to zero-transit needs a second repository row on the same library. `equivalent` appears in both mapping groups | Allow several repository rows on one physical library with different modes; treat `equivalent` as cross-framework when source and target frameworks differ and as edition transition otherwise |
| A-37 | Routing precedence | "Most specific rule wins" and `priority` can disagree; tie-breaking undefined | Specificity first (MS, classification, kind), then priority |
| A-38 | Adapter list | PRD 11.3 names NFS, SharePoint Server and Nextcloud, which are not in the TS adapter enum | Cover through smb and webdav, or add later |
| A-39 | Licence details | No rules for `max_users` (who counts, what happens at the limit), behaviour during grace, the canonical JSON form that is signed, or what `license.validation: online` checks | Count active non-guest users; block new users at the limit; warn during grace; sign canonical JSON (sorted keys, no whitespace) |
| A-40 | Read-only mode scope | Under BR-37, whether jobs (freshness, link health, notifications) keep running is not stated | Keep read-side jobs and exports; stop user writes |
| A-41 | Default repository at creation | `default_storage_repository_id` is NOT NULL and required for `setup`, so a repository must exist before the first MS | Auto-provision a `managed_vault` repository per organisation at install |
| A-42 | Threshold configuration | Thresholds are configurable per tenant and framework (PRD 9.2), but `evidence_frequency_rule` is global pack data; no tenant override table and no numbers | Add a tenant override table; prototype bands as defaults (section 10.2) |
| A-43 | Frequency list | PRD 9.2 lists five frequencies (daily, monthly, quarterly, annual, per event), the ISO 27001 pack has 7 frequency rules, and the prototype uses seven (adding weekly and semi-annual) | Take the frequency set from the pack; prototype seven as the ISO 27001 default |
| A-44 | Verification date rule for activities | The prototype requires the activity verification date to differ from the completion date; TS 6.6 only requires a different person | Confirm whether the date rule applies to activities or only to corrective actions (BR-08) |
| A-45 | 5,000-row list vs page size 200 | PRD 13 asks for a 5,000-row evidence list under 2 seconds while TS 9.5 paginates at 200 | Measure the 5,000-row target on server search and aggregates, with paginated rendering |
| A-46 | Gift threshold | BR-27 threshold source (tenant policy, pack `rules.json` parameter, currency) not stated | `rules.json` parameter with a tenant override and currency |
| A-47 | Edition dates | ISO 9001:2026 publication (16 Sep 2026) and ISO 37001:2025 dates are stated but the PRD itself asks for confirmation | Keep as pack data, never hard-coded |
| A-48 | Verifier when the MS Manager owns the activity | Verification is by the MS Manager but must differ from the owner | Require another MS Manager or the Programme Owner |
| A-49 | Platform Operator on-premise | On-premise the operator is the customer's infrastructure team; whether "no business data" still applies is not stated | Same rule in both modes; database access is an infrastructure matter |
| A-50 | Single admin | The four-eyes flow and BR-38 need a second Tenant Admin; behaviour with one admin is undefined | Block BR-38 changes until a second admin exists; allow other routing changes with an audit trail entry |

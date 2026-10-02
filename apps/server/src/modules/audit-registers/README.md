# audit-registers module

Findings, corrective actions, self-assessment, the audit activity planner, management reviews and cycle derivation
(build plan D.3 "Registers and workflows: audit side", C.13, E.2 `cycle.derive`).

Owner: WP-37; skeleton by WP-03 (build plan B.4).

| File | Content |
|---|---|
| `findings.service.ts` | Finding register (`ScopePolicy`, filters, `q`), raising a finding (`finding.raise`), changes with If-Match, the C.13 `finding.status` machine: closing checks BR-06 and BR-07 (major) and BR-08 (major and minor); OFI, signal and not a finding close with a note; a reopen needs a reason |
| `corrective-actions.service.ts` | Corrective actions for one or more findings of the system (`corrective_action_finding`), changes, the step machine with step texts and own grants, verification (BR-09, BR-08; not effective returns to the action step) |
| `self-assessments.service.ts` | One row per finding condition of the edition, assessments with evidence (gap needs owner and target date), raising a finding (`SA-<year>-<nn>`, source `self_assessment`) from a gap once |
| `audit-activities.service.ts` | Activities of an audit event, generated from `ref.audit_activity_template` of the event type (existing codes skipped), planning (auditee must be a member) |
| `management-reviews.service.ts` | Reviews shared through `entity_ms_link` (`integrated_mode` for a joint review), inputs per linked system, planned to held to closed with BR-13 and BR-14; closing queues `cycle.derive` per linked system |
| `cycle-derive.service.ts`, `cycle-derive.job.ts` | `cycle.derive` (E.2): the four derivation kinds over the current cycle; sets `done` or keeps the stored status; unknown kinds skipped with a warning |
| `rules.ts` | `@BusinessRule` providers of BR-06, BR-07, BR-08, BR-09, BR-13 and BR-14 |
| `support.ts` | Shared steps: C.13 row choice, record refs, `updated_at` bump, links of shared records, audit events of the path system |

The CHECK constraints of `finding` and `corrective_action` are the database backstops of BR-06, BR-07, BR-08 and
BR-09; a violation that reaches them is answered as the rule.

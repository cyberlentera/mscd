# Framework pack sources

This folder holds the source datasets of the framework packs that MSCD installs. `packages/pack-tools` builds and signs each source folder into `packs/dist/<pack_id>-<version>.pack` (git-ignored), and the server installs those archives into the `ref` schema (build plan E.8).

| Path | Content |
|---|---|
| `sources/<pack_id>/` | One folder per pack, generated from the web sample data. Never edit these files by hand |
| `scripts/extract-from-sample.mjs` | Writes `sources/` from `apps/web/src/data/mscd-data.js` and the tables at the top of the script |
| `scripts/validate-sources.mjs` | Checks every source folder and prints the dataset counts |
| `scripts/lib/pack-format.mjs` | The file list, CSV headers and encoding rules shared by both scripts |

## Commands

Plain Node 22 scripts with no dependencies, run from the repository root:

```bash
node packs/scripts/extract-from-sample.mjs           # rewrite packs/sources from the sample
node packs/scripts/extract-from-sample.mjs --check   # exit 1 when packs/sources is out of date
node packs/scripts/validate-sources.mjs              # format and reference checks, dataset counts
```

The extractor owns `sources/`: it rewrites every file and removes files it does not produce. It never follows a symbolic link: a link or any other entry that is not a regular file or folder under `sources/` stops both modes before anything is written or removed, and every removal is checked to stay inside `sources/`. To change a pack, change the sample data or the tables in `extract-from-sample.mjs`, run the extractor, then the validator. `--check` regenerates in memory and lists every file that differs, is missing or is not produced by the script, so CI catches drift between the sample and the packs.

## Packs

| Pack | Version | Framework | Edition status | Built from | Notes |
|---|---|---|---|---|---|
| `ISO27001-2022` | 1.2.0 | ISO/IEC 27001 | current | `isms` | Catalogue of the 93 Annex A controls; applicability target `catalogue_item` |
| `ISO9001-2026` | 0.9.0 | ISO 9001 | current | `qms` | Supersedes edition 2015, transition ends 2029-09-15 |
| `ISO9001-2015` | 1.4.2 | ISO 9001 | current | `qms` | The installer moves it to `transition` when 2026 is installed |
| `ISO22301-2019` | 1.0.0 | ISO 22301 | current | `bcms` | |
| `ISO37001-2025` | 0.6.0 | ISO 37001 | current | `abms` | Pre-release (shown as beta) |
| `ISO37001-2016` | 1.0.0 | ISO 37001 | withdrawn | `abms` | |

Every manifest has `engine_min_version` 1.0.0 and an empty `modules` list (the framework workbenches are deferred). The two ISO 9001 packs share their datasets, and so do the two ISO 37001 packs, because the sample has one system for each framework.

## Content rule: short titles only

Packs hold numbering, short titles and provider guidance only, never text of ISO standards (PRD 3.3, TS 4.1). Requirement and control titles are the short titles of the sample. The text written for this build is limited to the tables in `extract-from-sample.mjs`: Indonesian labels, phase names and auditor questions, lookup labels, drift rule messages, risk profile labels, and the ISO 27001 audit activities and finding conditions below. The other packs carry only the header row of `audit_activities.csv` and `finding_conditions.csv`; deeper pack content is a separate work-stream (build plan Appendix 1).

ISO 27001 audit activity templates (`audit_activities.csv`):

| Code | Event | Clause | Title | Auditee |
|---|---|---|---|---|
| `AA-S1-01` | Stage 1 | 4.3 | Review ISMS scope and context | ISMS Manager |
| `AA-S1-02` | Stage 1 | 6.1 | Review risk method and Statement of Applicability | ISMS Manager |
| `AA-S1-03` | Stage 1 | 9.2 | Confirm audit programme and management review plan | ISMS Manager |
| `AA-S2-01` | Stage 2 | 5.1 | Interview top management on leadership | Top Management |
| `AA-S2-02` | Stage 2 | 8.1 | Sample controls in operation | Domain Owner |
| `AA-S2-03` | Stage 2 | 10.2 | Follow up nonconformities and corrective actions | ISMS Manager |

ISO 27001 finding conditions (`finding_conditions.csv`):

| Code | Classification | Requirement | Text |
|---|---|---|---|
| `FC-01` | major | 8.2 | No information security risk assessment performed for the scope |
| `FC-02` | major | 9.2 | Internal audit programme not carried out within the cycle |
| `FC-03` | minor | 6.1 | Control decision in the Statement of Applicability without a risk-based justification |
| `FC-04` | minor | 7.5 | Controlled document used after its review date |
| `FC-05` | minor | 10.2 | Corrective action closed without an effectiveness check |
| `FC-06` | ofi | 9.1 | Performance metrics without target values |

## File format

- UTF-8 without a byte order mark, LF line endings, a final newline.
- CSV: a header row (also when a dataset is empty), then one row per record. A field is quoted when it holds a comma, a double quote or a line break, with inner quotes doubled (RFC 4180). Booleans are `true` or `false`; an empty field means null.
- JSON: pretty-printed with two spaces.
- `manifest.json` has every field of E.8 except `datasets`, which the pack builder fills with the checksums. There is no `signature` file in a source folder.

| File | Columns or shape | Source in the sample |
|---|---|---|
| `manifest.json` | `pack_id`, `pack_version`, `framework_code`, `framework_name`, `edition`, `status`, `pre_release`, `supersedes?`, `engine_min_version`, `modules`, `applicability_target`, `catalogue` | `MS[].code` (framework name), `MS[].unit`; versions as in the build plan (D-14), checked against `PACKS` |
| `requirements.csv` | `requirement_code, parent_code, title_short, clause_group, is_hs_common, documented_info_mandatory, applicability_assessable, default_frequency_code, evidence_example, sort_order` | `buildReqs()` of the system; ISO 27001 uses the Harmonized Structure entries of the QMS list (clauses 4 to 7, 9 and 10) plus its clause 8 entries 8.1, 8.2 and 8.3 |
| `catalogue.csv` | `item_code, theme_code, title_short, requirement_code, default_frequency_code, evidence_example, sort_order` | `buildReqs(isms)`: code, title, theme `A.5` to `A.8`, frequency; examples from `EXAMPLES` |
| `chain.csv` | `stage_key, position, label_en, label_id, question_en, question_id, source, entity_type, risk_profile_code, is_mandatory, clause_at_risk, overview_clause, gate_type_label_en, gate_type_label_id` | `STAGES`, `CLAUSE_AT_RISK` |
| `activities.csv` | `phase_no, phase_name_en, phase_name_id, is_gate_phase, activity_no, title, clause_ref, output_document_code, expected_outcome` | `PHASES`, `OUTPUT_MAP` |
| `frequencies.csv` | `code, label_en, label_id, period_days, sort_order` | `FREQ`, `FREQ_ORDER` |
| `labels.en.json`, `labels.id.json` | Flat key to text: `ms.name`, `ms.long_name`, `ms.manager_role`, `gate.name`, `applicability.artefact_name`, `risk.object_name`, `catalogue.theme.<n>` | `MS[].short`, `name`, `mgrRole`, `theme`; gate names of the controller |
| `cycle_requirements.csv` | `code, requirement_code, title, derivation, sort_order` | `CYCLE_ITEMS` |
| `drift_rules.json` | Array of `{code, label_en, label_id, severity, source_stage, source_kind, predicate, message, sort_order}` | `DRIFT` |
| `prep_tasks.csv` | `code, title, days_before_audit, skip_on_first_audit, sort_order` | `PREP`, `MS[].audit.date` |
| `review_inputs.csv` | `code, title, mandatory, sort_order` | Header row only |
| `finding_conditions.csv` | `code, classification, requirement_code, text` | ISO 27001 only, written for this build |
| `document_templates.csv` | `code, title, doc_type` | Header row only |
| `audit_activities.csv` | `code, event_type, clause_ref, title, auditee_role, key_questions, evidence_to_request, sort_order` | ISO 27001 only, written for this build |
| `lookups.csv` | `domain, code, label_en, label_id, sort_order` | Document tiers of `DOCS` and `SHARED`, plus fixed lists |
| `rules.json` | Array of `{rule_id, active, params}` | Fixed list |
| `risk_profiles.json` | Array of `{code, definition}` | One profile per risk stage of the chain |
| `mappings/<target>.csv` | `source_code, target_pack_id, target_code, mapping_type, evidence_reusable, note` | None generated yet (the sample has no mappings) |

## Derivation rules

- Requirements are sorted by clause number segment by segment (8.2 before 8.10). `is_hs_common` is true for the Harmonized Structure entries and for 8.1 Operational planning and control. `documented_info_mandatory` is true for the Harmonized Structure clauses that ask for documented information (4.3, 5.2, 6.2, 7.2, 8.1, 9.1, 9.2, 9.3, 10.2) and, in ISO 27001, for 6.1, 8.2 and 8.3. `applicability_assessable` is true for ISO 9001 clause 8. Requirements carry no evidence examples: the sample's examples are keyed by Annex A control.
- Chain stages without a sample `src` are entity stages: `context` uses `context_issue`, `risk`, `drisk` and `brisk` use `risk` (profiles `information_security`, `quality`, `disruption`, `bribery`), `treatment` and `action` use `risk_treatment`, `objective` uses `quality_objective`, `metric` uses `metric`, `product` uses `prioritized_activity`, `bia` uses `business_impact_analysis`, `exercise` uses `exercise`, `associate` uses `business_associate`. `src` `req`, `soa`, `doc` and `ev` give the sources `applicability`, `justification` (entity type `chain_record`), `document` and `evidence`. The overview clause is 4 for `context` and `brisk`, 6 for `risk`, `treatment`, `soa`, `action` and `objective`, 7 for `document`, 9 for `metric` and 8 otherwise. Gate type labels are those of the sample (`Risk`, `Treatment`, `SoA`, `BIA`); other stages leave them empty and show their stage key. Every stage is mandatory.
- An activity's output document is the first `OUTPUT_MAP` keyword found in its title (case-insensitive), as the sample computes it; the expected outcome is the sample's text "<title>: approved and recorded in the register". The sample gives no clause per activity, so `clause_ref` is empty.
- Cycle requirements use the sample clause as `requirement_code` (empty for `-`), a code per kind (`RISK_ASSESSMENT`, `INTERNAL_AUDIT`, `MGMT_REVIEW`, `CORRECTIVE_ACTION` and others) and no derivation, so the `cycle.derive` job keeps the seeded statuses.
- Drift rules keep the sample ids as codes. `risk12` gets `source_kind` `stale_risk` with predicate `{"months": 12}`, `dd` gets `dd_expired`, `mr` and `csat` get `manual`, and the rules that the sample computes (`unverif`, `metric`, `exercise`, `nohash`) keep their kind. Severity: `unverif` is `crit`; `risk12`, `dd`, `mr` and `exercise` are `risk`; `metric`, `csat` and `nohash` are `warn`.
- Preparation tasks: `days_before_audit` is the next audit date minus the sample due date; tasks that close a named finding (for example "Close NC-2025-02 ...") are skipped on a system's first audit (BR-44).
- Lookups: `doc_type` holds the seven document tiers of the register (Policy, Standard, Procedure, Plan, Register, Record, Form) and every pack has `treatment_option` (`modify`, `retain`, `avoid`, `share`). ISO 22301 adds `exercise_type` (`tabletop`, `walkthrough`, `simulation`, `full`); ISO 37001 adds `bribery_risk_level` (`low`, `medium`, `high`, `very_high`) and `due_diligence_subject` (`associate`, `position`, `transaction`, `project`).
- Rules: every pack activates BR-01, BR-03, BR-04, BR-06 to BR-17, BR-21 to BR-23, BR-29 to BR-32 and BR-34 to BR-50 (39 rules); ISO 27001 and ISO 37001 also activate BR-02. BR-03 carries the phrases that do not count as a justification, per language (`params.phrases.en`, `params.phrases.id`). Not activated: BR-05 and BR-18 (deferred), BR-19 and BR-20 (enforced by permissions), BR-24 (a database constraint), BR-25 to BR-28 (workbenches deferred) and BR-33 (raised by the platform's pack lifecycle job).
- Risk profiles hold labels, likelihood and consequence scales of 1 to 5 and impact dimensions (confidentiality, integrity and availability for information security) until the profile format is defined (specification question A-33).

## Validation

`validate-sources.mjs` checks, per pack folder: every file of the list above exists and nothing else does (apart from `mappings/*.csv`); UTF-8, LF and the final newline; CSV headers and field counts; JSON formatting; manifest fields, semantic versions, `pack_id` equal to the folder name and to `<framework_code>-<edition>`, `catalogue` consistent with `catalogue.csv`, no `datasets`; value types and the lengths of the `ref` columns; unique codes; references (catalogue and finding conditions to requirement codes where given, requirement and catalogue frequencies, chain entity types in the record tables of C.10, risk profiles of risk stages, document template types in `doc_type`, drift rule stages); contiguous chain positions, phase numbers and activity numbers; the lookup domains `doc_type` and `treatment_option`; the same label keys in both languages, including a theme label for every catalogue theme. It prints the dataset counts per pack and exits 1 on any error.

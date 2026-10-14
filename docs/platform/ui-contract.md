# MSCD UI Contract for Live Data

| | |
|---|---|
| Purpose | Everything the current web app reads, derives and changes, stated exactly, so the backend can serve the same screens on live data |
| Source basis | `app/src/MscdApp.jsx` (controller) and `app/src/data/mscd-data.js` (sample data and helpers), state of 1 Oct 2026 |
| Related | `docs/ARCHITECTURE.md` sections 6, 13 and 14; TS 4.4 to 4.9, 6, 7, 8 and 9; PRD 7 to 9 |
| Parity rule | `app/src/views/*.jsx` and the view model built by `renderVals()` stay unchanged. Only the controller's data access and action handlers change (section 4.6) |

## Contents

0. [Conventions](#0-conventions)
1. [Entities the UI consumes](#1-entities-the-ui-consumes)
2. [Derived values](#2-derived-values)
3. [User actions and mutations](#3-user-actions-and-mutations)
4. [DataSource interface](#4-datasource-interface)
5. [Contract gaps and decisions](#5-contract-gaps-and-decisions)

## 0. Conventions

| Term | Meaning |
|---|---|
| `Pair` | `[en, id]` text tuple. The controller picks the language with `li(a)`, which returns `a[1]` when `L === 'id'` |
| `IsoDate` | Local date string `YYYY-MM-DD`. The controller compares dates as strings (`due > audit.date`) or through `dd()` |
| `PersonId` | Key into `PEOPLE`, for example `'bagus'`. `'none'` means unassigned (BR-45) |
| `MsId` | Management system id: `'isms'`, `'qms'`, `'bcms'`, `'abms'` in the sample; any stable slug on the API |
| `RecordKey` | `` `${msId}:${kind}:${id}` ``. Kinds: `req` (control or requirement, `isms:req:A.5.23`), `doc` (`isms:doc:PRC-07`), `ev` (evidence code, `isms:ev:EV-0313`), `soa` (applicability gate entry, `isms:soa:A.5.23`), `x` (explicit chain record, `isms:x:R-031`), `act` (activity `phase.activity`, `isms:act:4.5`), `drift` (row key only, `isms:drift:R-005`) |
| Today | `TODAY_S = '2026-09-29'` in the sample. `dd(s)` is whole days from today, negative in the past |
| Placement | **S**: computed by the server read model (TS 9.1, one function per concept). **S/C**: server aggregate; the client may count from server lists until the aggregate endpoint exists. **C**: client presentation only |

A `RecordKey` indexes `state.ov` (the override store), `state.sel`, `state.expanded`, list row keys, `_dets`, and every command in section 3. A record has the same key on every screen (controls, chain stages, gate tab, freshness, storage), so a selection survives navigation. The API must keep business ids stable and unique per management system.

Status codes double as translation keys: the controller renders `this.t(c.st)`, `this.t(doc.st)`, `this.t(e.fresh)`, `this.t(it.st)` and `this.t(a.st)`. Every status code listed below must exist in `T` with exactly that spelling.

## 1. Entities the UI consumes

"Read by" names controller methods. "Server source" names TS entities and columns.

### 1.1 Organisation

Source: getter `ORGS` in the controller, not the data module.

| Field | Type | Example | Read by | Server source |
|---|---|---|---|---|
| `id` | string | `'ndt'` | `org`, `setOrg`, `orgOptions` | `organization.id` (slug) |
| `name` | string | `'PT Nusantara Digital Teknologi'` | `orgVals.orgName`; `orgInitials` (drops a leading `PT ` or `RS `, first letters of up to 3 words); `fwScreen` licence card `org` | `organization.name` |
| `ms` | `MsId[]` | `['isms','qms','bcms','abms']` | `MSL` (filters `D.MS`), `setOrg` (first system; single-system orgs land on `m1overview`), `orgOptions` count, `single` flag | Management systems the user may see |
| `deploy` | `'saas'` or `'onprem'` | `'saas'` | `setOrg` copies it to `state.deploy`; `orgOptions` sub label via `t('saas')` or `t('onprem')` | Capability flags from `GET /system/profile` |
| `sites` | number | `2` | `orgVals.orgSub` (`n management systems, n sites`) | New field `organization.site_count` |

Sample: `ndt` (4 systems, saas, 2 sites), `bsd` (isms and qms, onprem, 3 sites), `rmn` (isms, saas, 1 site). All three reuse the same `MS` records and data.

### 1.2 Management system (`MS[]`)

| Field | Type | Example | Read by | Server source |
|---|---|---|---|---|
| `id` | `MsId` | `'isms'` | Key prefix everywhere; lookups into `STAGES`, `X`, `PHASES`, `PHASE_STATE`, `CHAINS`, `EVENTS`, `PREP`, `PAST`, `CYCLE_ITEMS`, `DRIFT`, `FOCUS`, `PACKS`; hard-coded switches in `gateName`, `docDetail` approver, `phases` owner pool, `gtScreen` suggestions, `portfolio` attention, `fwScreen` | `management_system.id`, exposed as a slug |
| `code` | string | `'ISO/IEC 27001'` | `portfolio`, `msOptions`, `fwScreen` (`code + ' : ' + ed.split(' ')[0]`) | `framework.code` (pack) |
| `ed` | string | `'2022'`, `'2015 + 2026'` | `portfolio`, `msOptions`, `fwScreen` | Active `framework_version` edition; `active + target` while transitioning |
| `short` | string | `'ISMS'` | `portfolio`, attention, tasks, timeline lanes, `fwScreen`, `storageScreen` (repo and routing filter, row column), `docDetail` path and used-by, sample vault path | `management_system.code` short label |
| `name` | `Pair` | `['Information security management system','Sistem manajemen keamanan informasi']` | `portfolio`, `fwScreen` | Pack label |
| `mgr` | `PersonId` | `'rina'` | `phasesScreen` owner action `'Verified by ' + pname(ms.mgr)` | User holding the MS Manager role |
| `mgrRole` | string | `'ISMS Manager'` | `actDetail` note `'Awaiting verification by the ' + mgrRole` | MS Manager role label from the pack |
| `color` | CSS colour | `'#e8731a'` | `portfolio`, attention, tasks, timeline, `fwScreen`, `msOptions` | New display attribute per system |
| `scope` | string | `'Data centre & managed services operations: Jakarta and Surabaya'` | `portfolio`, `msOptions`, timeline event, `fwScreen` | `scope_statement` |
| `certifier` | string | `'PT Sertifikasi Nusantara'` | `portfolio`, `upcoming`, chain and audit hero, timeline lane (strips `PT `, `Lembaga Sertifikasi `, ` Indonesia`), timeline event, `fwScreen` | `certification_body` |
| `lead` | string | `'Ir. Dwi Hartanto, IRCA LA'` or `'-'` | Chain and audit hero, timeline event | Next `audit_event.lead_auditor_name` |
| `cert` | string | `'Certified 14 Mar 2025, cycle ...'`, `'Not yet certified, Stage 1 planned'` | `portfolio` card | Derived from `certification_cycle` |
| `stage` | `Pair` | `['Surveillance 1, year 2','Surveillance 1, tahun ke-2']` | `portfolio`, `msOptions` | Derived from cycle, `management_system.status` and current phase |
| `audit` | object or `null` | see below | `dueTag`, `chain` (After audit), chain and audit hero, `portfolio`, `upcoming`, tasks week strip, reassign `afterWarn` | Next `audit_event` (TS 9.4) |
| `clauses` | `number[7]` | `[100,100,88,72,94,81,67]` (clauses 4 to 10) | `portfolio` radar and clause list, `overviewScreen` maturity | Readiness per Harmonized Structure clause (read model) |
| `findings` | `{open, major}` | `{open:3, major:1}` | `portfolio` stats, `overviewScreen` open count for clause 10 | Open findings; those classified major |
| `banner` | `{tone, text: Pair}` or absent | `{tone:'bad', text:['Google Shared Drive token expired 27 Sep 2026. ...', ...]}` | `portfolio` card and attention (weight 4), `renderVals.msBanner` (hidden on portfolio, tasks, fw, storage) | Derived alert: connector degraded, edition transition, beta pack |
| `loc` | `LocId` | `'sp'`, `'vault'`, `'gd'` | `buildReqs` default `loc`, `buildEvidence` version, hash and path, `docDetail` storage and pinned facts, `docRow` location cell, `openPicker` (`'vault'` opens upload, `'gd'` the Google picker, else SharePoint), `portfolio` `locLabel`, `fwScreen`, evidence pack toast | `default_storage_repository_id` |
| `locMode` | string | `'Customer Repository, Link'`, `'Managed Vault'` | `locFacts`, `docDetail`, `docRow`, `portfolio` (`split(', ')[0]`), `fwScreen` (`split(', ').pop()`) | Repository class and `storage_repository.mode` |
| `pack` | string | `'ISO27001-2022 v1.2.0'` | `renderVals.pack` | Installed pack id and version |
| `phase` | `Pair` | `['Operate & maintain','Operasi & pemeliharaan']` | `overviewScreen.gateLine` | Current implementation phase label |
| `unit` | `'ctrl'` or `'req'` | `'ctrl'` | `reqDetail` fact set, `gateItems` type label, `gtScreen` node shapes | Pack `applicability_model`: `catalogue_item` gives `ctrl`, `requirement` gives `req` |
| `theme` | object | `{5:'Organizational',6:'People',7:'Physical',8:'Technological'}` | `buildReqs` (ISMS only) | Catalogue group labels |

`audit` sub-object:

| Field | Type | Example | Read by | Server source |
|---|---|---|---|---|
| `name` | `Pair` | `['Surveillance audit 1','Audit surveillance 1']` | `portfolio`, `upcoming`, attention text, hero | `audit_event.event_type` label |
| `date` | `IsoDate` | `'2026-11-12'` | All After-audit flags, hero days, `portfolio`, `upcoming`, tasks week dots | `audit_event.scheduled_at` |
| `days` | number | `2` | Not read (timeline reads `EVENTS[].days`) | `audit_event.audit_days` |

Sample banners: QMS `info` (edition transition), BCMS `bad` (Google token expired), ABMS `warn` (beta pack). ABMS has `audit: null`.

### 1.3 Person (`PEOPLE`)

Shape: `{[PersonId]: [displayName, jobTitle]}`, with the sentinel `none: ['Unassigned','-']`.

| Element | Example | Read by | Server source |
|---|---|---|---|
| `[0]` display name | `'Bagus Prasetyo'` | `person()` (initials: first letter of the first two words; `'?'` and bad colours for `none`), `pname()`, every Owner and Holder fact (`name + ', ' + title`), `peopleOptions`, `roleOptions`, `me`, pending per person, tasks greeting (first word) | `user.display_name` |
| `[1]` job title | `'IT Infrastructure Lead'` | Owner facts, `peopleOptions` label, `roleOptions` sub, `me.role`, person banner | `user.job_title` |

`peopleOptions` lists every entry, including `none`, as `{id, label: name + ', ' + title}` for the reassign select. On the API it lists users who may hold items in the target system, plus `none`.

### 1.4 Role and current user (`ROLES`, `state.role`)

| Role key | `who` | `label` | Screens (`visFor`) |
|---|---|---|---|
| `manager` | `'rina'` | MS Manager | All |
| `owner` | `'bagus'` | Domain Owner | `mytasks`, `m1overview`, `controls`, `docs`, `fresh` |
| `auditor` | `'maya'` | Internal Auditor | `portfolio`, `audit`, `chain`, `gt`, `docs`, `controls`, `fresh`, `timeline`, `mytasks` |
| `top` | `'hendra'` | Top Management | `portfolio`, `m1overview`, `timeline`, `audit`, `chain`, `mytasks` |

`me` is `ROLES[state.role].who`. Read by `me` getter, `roleOptions`, the `me` view object (`name`, `role: label + ', ' + jobTitle`, initials), `visFor`, `landing`, owner scoping, `canVerify`, `canSeePeople`, self-verification checks and `taskItems`. Server source: the session user and `user_ms_role`. The UI holds one global role; the TS grants roles per system (section 5).

### 1.5 Requirement or control (`buildReqs(ms)`, used as `d.reqs`)

| Field | Type | Example | Read by | Server source |
|---|---|---|---|---|
| `id` | string | `'A.8.13'`, `'Cl. 8.7'` | Rows, details, keys, chain and gate ids, golden thread, `titleOf`, evidence link `e.ctrl` | Catalogue item code with `A.` prefix, or requirement code with `Cl. ` prefix |
| `key` | string | `'8.13'` | `buildEvidence` (`ctrlKey`, evidence title lookup `EVT`, BCMS evidence filter); tasks `EXAMPLES` lookup | Raw code |
| `title` | string | `'Information backup'` | `reqRow`, `reqDetail`, chain title, `evRow` and `evDetail`, `titleOf`, tasks | Pack label |
| `theme` | string | `'A.8 Technological'`, `'Clause 8'` | `reqRow` sub line when `note` is empty | Group label |
| `st` | `ReqStatus` | `'partial'` | Badges, tab and chip counts, chain inclusion and action text, evidence inclusion, action availability | `applicability_entry.implementation_status` (see 5.1) |
| `owner` | `PersonId` | `'bagus'` | Rows, facts, chain holder, gate holder, tasks, owner scoping, activity blocker owner | `owner_user_id` |
| `doc` | string | `'PRC-11'` | `reqRow`, `reqDetail` implementing document, chain downstream, document usage (orphan check), golden thread | First `applicability_entry_document` |
| `freq` | `FreqId` | `'monthly'` | `reqDetail` operating frequency and partial note, evidence period | `operating_criteria` frequency |
| `note` | string | `'Q3 backup log not found at pinned location'` | `reqRow` sub line (warn colour), gate item `why`, `reqDetail` gate note, search, tasks text | Status note: blocker reason or the derivation message |
| `gate` | boolean | `false` | `reqRow` tag, `reqDetail` badges, note and actions, chain `gate` flag | Derived: entry holds the critical gate |
| `just` | string | `'Required by risk treatment; see linked risks.'` | `reqDetail` justification fact (empty shows red) | `inclusion_justification` or `exclusion_justification` |
| `risks` | `string[]` | `['R-014','R-031']` | `reqDetail` linked risks and upstream links, `noUp`, chain upstream, golden thread risk node | `applicability_entry_risk` |
| `prod` | `IsoDate` or undefined | `'2026-04-14'` | `buildEvidence` only | Sample seed |
| `integ` | `IntegId` | `'missing'` | `buildEvidence` only | Sample seed |
| `loc` | `LocId` | `'sp'`, `'od'` | `buildEvidence` only | Sample seed |
| `by` | `PersonId` | set by override | `reqDetail` note, verify meta and self-verify check, chain action text, `taskItems` exclusion | `completed_by_user_id` |
| `due` | `IsoDate` | set by override | Chain item due for the control stage | Due date of the entry's pending action |

`ReqStatus`: `implemented`, `partial`, `planned`, `ns`, `blocked`, `na`, `complete` (complete, awaiting verification). Status tones in rows: implemented ok, partial warn, planned info, ns mute, blocked bad, na mute, complete info.

Sample counts: ISMS 93 controls (61 implemented, 18 partial, 6 planned, 2 ns, 2 blocked, 4 na), QMS 28 requirements, BCMS 27, ABMS 32.

### 1.6 Document (`buildDocs(ms)`, used as `d.docs`)

| Field | Type | Example | Read by | Server source |
|---|---|---|---|---|
| `id` | string | `'PRC-07'` | Rows, keys, links, chain id, golden thread, `titleOf` | `document.doc_id` |
| `title` | string | `'Access Control Procedure'` | Rows (truncated to 32 chars plus `...` in `reqRow`), details, chain title | `document.title` |
| `tier` | string | `'Procedure'` | `docRow` sub line, register grouping and sort order `Policy, Standard, Procedure, Plan, Register, Record, Form` | Document type |
| `ver` | string | `'3.2'`, `'7'`, `'-'` | `'v' + ver` in rows, facts and chain title; `nextDocVer` | Current `document_version` label |
| `st` | `DocStatus` | `'expired'` | Badges, chips, chain inclusion and action, actions, docs tabs | `document.status`; `expired` derived (see 2.4) |
| `appr` | `IsoDate` or `''` | `'2025-09-24'` | `docRow` approved column (no tag), `docDetail` | Approval date of current version |
| `rev` | `IsoDate` | `'2026-09-24'` | `docRow` review column with `dueTag`, `docDetail` (red with `overdue Nd` when past), chain due, calendar grouping, `docs30` | Next review date |
| `owner` | `PersonId` | `'bagus'` | Rows, facts, chain holder, reminders, owner scoping | `owner_user_id` |
| `shared` | boolean | `true` for `IMS-01` to `IMS-04` | `docRow` tag, badges, `usedBy` fact, golden thread `shared` marker | Linked to more than one system through `entity_ms_link` |
| `ms` | `MsId` | `'isms'` | Not read | Primary system |

`DocStatus`: `approved` (ok), `expired` (bad), `review` (warn, TS `in_review`), `draft` (info). Override fields `h` and `due` may be merged into a document but the register does not read them.

`buildDocs` returns `DOCS[ms.id]` followed by the four `SHARED` documents. Sample counts: ISMS 22 (14 approved, 5 expired, 1 review, 2 draft), QMS 10, BCMS 8, ABMS 5.

### 1.7 Evidence (`buildEvidence(ms, reqs)`, used as `d.evs`)

| Field | Type | Example | Read by | Server source |
|---|---|---|---|---|
| `code` | string | `'EV-0313'` | Rows, keys, chain id, golden thread, storage rows, `titleOf` | `evidence` business id |
| `ctrl` | string | `'A.8.13'` | Link to the requirement (`d.evs.find(e => e.ctrl === c.id)` takes the first), facts, chain upstream, golden thread `'ev:' + ctrl` nodes | `evidence_target` |
| `ctrlKey` | string | `'8.13'` | Tasks `EXAMPLES` lookup | Target raw code |
| `title` | string | `'Backup job log & restore test'` | Rows, details, chain title, tasks | `evidence.title` |
| `freq` | `FreqId` | `'monthly'` | Frequency column, rule text, freshness filters, chain action text | `operating_criteria` frequency |
| `p` | number (days) | `30` | `evDetail` rule text; `data()` recomputes `next` | Period length (0 for per-event) |
| `prod` | `IsoDate` | `'2026-05-31'` | Produced column, facts, golden thread sub line, tasks text | `evidence.produced_at` |
| `next` | `IsoDate` or `null` | `'2026-06-30'` | Next due column, chain due, reassign default, drift rows | `next_due_at` (derived) |
| `fresh` | `Fresh` | `'critical'` | Badges, tabs, donut, chain inclusion, notes, golden thread | `freshness_status` (stored, derived) |
| `integ` | `IntegId` | `'missing'` | Badges, notes, chain inclusion and missing flag, storage, drift | Mapped from `storage_object.link_status` (see 1.14) |
| `loc` | `LocId` | `'sp'`, `'od'`, `'gd'`, `'vault'` | `locCell`, `locFacts`, repository counts, tasks text, golden thread | `storage_object.storage_repository_id` |
| `owner` | `PersonId` | `'bagus'` | Rows, chain holder, tasks, owner scoping | `owner_user_id` |
| `ver` | string | `'v5.0'`, `'rev 3'`, `'v2'` | Pinned version fact, storage row, golden thread, vault upload increment | `storage_object.external_version_id` or vault version |
| `hashAlg` | string | `'quickXorHash'`, `'SHA-256'`, `'SHA-256 (provider)'`, `'none'` | Fingerprint fact, storage row | `storage_object.hash_algorithm` and `hash_source` |
| `path` | string | `'Compliance / ISMS / Evidence / 2026 / Q3'` | Storage fact, storage row sub line | Repository folder path of the item |

`Fresh`: `fresh` (ok), `aging` (warn), `expired` (warn), `critical` (bad). Overrides may add `h` and `due` (copied as raw fields) and replace `prod`, `integ`, `ver`, `hashAlg` and `loc`.

Sample counts: ISMS 79 (64 fresh, 6 aging, 6 expired, 3 critical; integrity 76 ok, 1 changed, 1 revoked, 1 missing), QMS 27, BCMS 11 (all `pending`), ABMS 2.

### 1.8 Chain stages and chain records

`STAGES[msId]`: ordered stage definitions.

| Field | Type | Example | Read by |
|---|---|---|---|
| `id` | string | `'risk'` | `chain` item `stage`, chain tabs, stage table, golden thread, `CLAUSE_AT_RISK` lookup, overview clause map |
| `l` | `Pair` | `['Risk','Risiko']` | Tab labels, stage column, person stages list, golden thread stage label |
| `q` | string | `'Show me how this risk was identified and assessed.'` | Item `q` ("Auditor is likely to ask"), `stageQ`, audit stage table |
| `rec` | number | `38` | Record count for explicit and `soa` stages (denominator of stage readiness) |
| `src` | `'req'`, `'soa'`, `'doc'`, `'ev'` or absent | `'req'` | Which records feed the stage; absent means explicit records from `X` |

Stages per system, with the server entity behind each:

| System | Stage (`id`, src or rec, sample records in `X`) | Server entity |
|---|---|---|
| ISMS | `context` (rec 12; CI-09), `risk` (38; R-031, R-014, R-022, R-027, R-035), `treatment` (41; T-014, T-019, T-026, T-031), `control` (src req), `soa` (src soa, rec 93; SOA-01), `document` (src doc), `evidence` (src ev), `metric` (24; M-07, M-11, M-15, M-19) | `context_issue`, `risk`, `risk_treatment`, `applicability_entry`, applicability justification plus SoA document, `document`, `evidence`, `metric` |
| QMS | `context` (9; CI-Q04), `risk` (21; RO-11, RO-07), `action` (24; ACT-09), `process` (src req), `objective` (6; QO-03), `document`, `evidence`, `metric` (12; MQ-02) | `context_issue`, `risk` (risks and opportunities), `risk_treatment`, `applicability_entry`, `quality_objective`, `document`, `evidence`, `metric` |
| BCMS | `context` (7; CI-B02), `product` (8; PA-05), `bia` (8; BIA-03, BIA-06), `drisk` (11; DR-04), `strategy` (src req), `document`, `exercise` (3; EX-01, EX-02), `evidence` | `context_issue`, `prioritized_activity`, `business_impact_analysis`, `risk` (disruption), `applicability_entry`, `document` and `bc_plan`, `exercise`, `evidence` |
| ABMS | `context` (0), `brisk` (0), `control` (src req), `associate` (0), `document`, `evidence`; every `q` is empty | `context_issue`, `risk` (bribery), `applicability_entry`, `business_associate`, `document`, `evidence` |

`X[msId][stageId]`: explicit chain records, each with an open pending action.

| Field | Type | Example | Read by |
|---|---|---|---|
| `id` | string | `'R-031'` | Chain item id, gate item id, `findX`, `titleOf`, drift rows, golden thread search (case-insensitive) |
| `t` | string | `'Unpatched hypervisor in Surabaya DC'` | Chain title, `titleOf`, drift row title |
| `act` | string | `'Select a treatment: no treatment linked'` | Chain action, gate `why`, action fact |
| `h` | `PersonId` | `'rina'`, `'none'` | Chain holder, gate holder, activity blocker owner, drift holder |
| `due` | `IsoDate` or `null` | `null` | Chain due, gate due, drift due |
| `gate` | boolean, optional | `true` | Chain `gate`, `gateItems` |
| `up`, `down` | `string[]`, optional | `['CI-03']`, `[]` | Chain upstream and downstream links; golden thread fallback scan |

Server: every stage record exposes the TS 9.3 pending record contract (`title`, `status`, `action`, `holder`, `due_at`, `after_audit`, `upstream`, `downstream`), plus a `gate` flag.

`CHAINS[msId]`: traceability chain instances, `{id, nodes: [[stageId, recordId]]}`. A node id of `'ev:' + controlId` means "latest evidence of that control"; `null` means no record linked. Example: `{id:'R-014', nodes:[['context','CI-02'],['risk','R-014'],['treatment','T-014'],['control','A.8.2'],['soa','A.8.2'],['document','PRC-07'],['evidence','ev:A.8.2'],['metric','M-07']]}`. Read by `auditScreen` (picks and nodes) and `gtScreen`. Server: `GET /ms/{ms}/audit/chain?anchor_id=` built from `traceability_chain_def`.

`TITLES`: `{id: title}` for ids that exist only as chain nodes, for example `'CI-02': 'Dependence on privileged administrators'`. Read by `titleOf` as the last fallback. Server: titles travel in chain node payloads.

`CLAUSE_AT_RISK`: `{stageId: clause}`, for example `risk: '6.1.2'`. Read by `gtScreen` for broken nodes. Server: per stage in `traceability_chain_def`.

### 1.9 Phases and activities

| Source | Shape | Example | Read by |
|---|---|---|---|
| `PHASES[msId]` | `[{n, gate?, acts: string[]}]` | `{n:'Risk assessment & SoA', gate:true, acts:['Define risk assessment methodology', ...]}` | `phases` |
| `PHASE_STATE[msId]` | `{verifiedUpTo, current?, lockedFrom?, ov: {'p:a': status or 'blocked:REF'}}` | `{verifiedUpTo:3, current:4, lockedFrom:5, ov:{'4:3':'blocked:BIA-03'}}` | `phases` |
| `OUTPUT_MAP` | `[[keyword, docId]]` | `['Statement of Applicability','SOA-01']` | `phases` (first keyword contained in the activity title, case-insensitive) |

Derived activity (from `phases(d)`), read by `phasesScreen`, `actDetail`, `overviewScreen`:

| Field | Type | Example | Server source |
|---|---|---|---|
| `key` | `RecordKey` | `'isms:act:4.5'` | `implementation_activity_progress` ref |
| `no` | string | `'4.5'` | `activity_template` number |
| `title` | string | `'Select Annex A controls'` | Template activity text |
| `st` | `ActStatus` | `'blocked'` | `status` (TS 6.6); `locked` derived |
| `blocker` | string or `null` | `'A.8.12'` | `blocker_gate_item_ref` |
| `owner` | `PersonId` | `'bagus'` | `owner_user_id` |
| `out` | string or `null` | `'SOA-01'` | Template output document id |
| `doc` | document object or `null` | the `SOA-01` document | `output_document_id` |
| `date` | `IsoDate` or `null` | `'2026-11-03'` | `completed_at` or `verified_at` when verified, else `due_at` |
| `pno` | number | `4` | Phase number |
| `by` | `PersonId` or undefined | set by override | Completed by (for the self-verification check) |

Derived phase: `{no, n, gate, acts, c: {verified, complete, progress, blocked, ns, locked}, total}`.

`ActStatus`: `verified` (ok), `complete` (info), `progress` (warn, TS `in_progress`), `blocked` (bad), `ns` (mute, TS `not_started`), `locked` (mute, derived, never stored).

### 1.10 Audit events, preparation, findings, cycle and drift

| Source | Shape | Example | Read by | Server source |
|---|---|---|---|---|
| `EVENTS[msId]` | `[{t, d, days, result?, next?}]` | `{t:'Surveillance 1', d:'2026-11-12', days:2, next:true}` | `timelineScreen` lanes and event detail | `audit_event` (`event_type` label, `scheduled_at`, `audit_days`, `outcome_summary`); `next` derived (TS 9.4) |
| `FOCUS[msId]` | string | `'Vulnerability remediation (NC-2025-02), ...'` | Timeline event `focus` | `audit_event.expected_focus` |
| `PREP[msId]` | `[title, owner, due, 'done' or 'progress' or 'open']` | `['Approve SoA v3.0','hendra','2026-10-15','open']` | Timeline event `prep` (next event only) | `audit_prep_task` (TS 4.9, 6.7) |
| `PAST[msId]` | `[id, 'Minor' or 'Major' or 'OFI', clause, title, 'open' or 'closed', note]` | `['NC-2025-02','Minor','8.8 / A.8.8','Remediation SLA missed ...','open','Corrective action implemented, ...']` | Timeline event `findings` (next and past events) | `finding` and `corrective_action` |
| `CYCLE_ITEMS[msId]` | `[clause, title, owner, due, 'done' or 'progress' or 'open', note]` | `['9.3','Management review with all mandatory inputs','hendra','2026-10-28','open','2 of 7 inputs not yet prepared']` | Timeline cycle list; prerequisites of planned events and of systems without events | `cycle_requirement_status` (TS 4.9, 6.8) |
| `DRIFT[msId]` | `[{id, l: Pair, rows?: [[id, title, owner, due]], src?: 'unverif' or 'metric' or 'exercise' or 'nohash'}]` | `{id:'risk12', l:['Risks not reassessed in 12 months', ...], rows:[['R-005','Data centre power failure','bagus','2026-10-30']]}` | Timeline regression detector | `drift_rule_def` and `drift_result` (TS 4.9) |

TS status mapping for the three-state tuples: `done` from `done`; `progress` from `in_progress`; `open` from `not_started`, `blocked` and `overdue` (all rendered with the bad tone).

### 1.11 Review calendar items

No separate entity. `calScreen` reads `d.docs` (`id`, `title`, `owner`, `rev`, plus every `docRow` field) and groups them by `rev` (rule in 2.10). Server: `GET /ms/{ms}/documents?due_within=` or the documents list.

### 1.12 Tasks

No separate entity. `taskItems(me)` collects chain items held by the current user across every system of the organisation (rule in 2.11). `EXAMPLES` (`{requirementKey: text}`, for example `'8.13': 'Backup job log export and restore test sign-off'`) supplies the "accepted evidence" hint. Server: a cross-system tasks endpoint returning chain records where the holder is the session user, and example text from the pack (`evidence_frequency_rule` or catalogue guidance).

### 1.13 Framework packs and licence

| Source | Field | Example | Read by | Server source |
|---|---|---|---|---|
| `PACKS[msId]` | `v` | `'0.9.0 (2026), 1.4.2 (2015)'` | `fwScreen` card `pack` | Installed pack versions |
| | `installed` | `'18 Sep 2026'` (display string) | Card | Install date |
| | `eds` | `'2026 current, 2015 in transition'` | Card `eds` and `edsShort` (drops ` current`) | Edition statuses (TS 6.3) |
| | `update` | `'1.0.0: subclause numbering verified against published text'` or `null` | Card `update` and `updateShort` (text before the first `:` and `,`) | Available update |
| `LICENCE` | `org` | `'PT Nusantara Digital Teknologi'` | Not read (card uses `this.org.name`) | Licence holder |
| | `to` | `'31 Mar 2027'` | Card `to` | Licence expiry |
| | `fw` | `'4 of 4'` | Denominator only; numerator replaced by `MSL.length` | Entitled frameworks |
| | `ms` | `'4 of 10'` | Denominator only; numerator replaced by `MSL.length` | Entitled systems |
| | `users` | `'86 of 150'` | Both numbers | Active users and seats |
| | `adapters` | `'Managed Vault, Microsoft 365, Google Workspace, SMB'` | Card | Entitled storage adapters |
| | `features` | `['Integrated Management System', ...]` | Feature chips and joined text | Entitled features |
| | `sig` | `'Ed25519, verified'` | Card (`+ ' offline'` on onprem) | Signature check result |

The card status (`transition` for `qms`, `Beta pack` for `abms`, `Current` otherwise) is hard-coded by system id.

### 1.14 Storage

`LOC`: `{[LocId]: [name, id, short, colour, iconPath]}` for `sp` (SharePoint Online), `od` (OneDrive personal), `gd` (Google Shared Drive), `vault` (Managed Vault), `smb` (File share). Read by `locCell` (`short`, icon, colour, `name` as title), `locFacts`, `docDetail`, `portfolio`, `fwScreen`, storage rows, tasks and golden thread text.

`INTEG`: `{[IntegId]: [en, id, tone]}`.

| `IntegId` | Label | Tone | UI treats as unverifiable | TS 6.4 `link_status` source |
|---|---|---|---|---|
| `ok` | Verified | ok | No | `intact` with a hash |
| `nohash` | No hash (Google Doc) | warn | No | `intact`, `hash_algorithm` none |
| `pending` | Check pending | warn | No | `verification_pending` |
| `changed` | Version changed | warn | Yes | `version_changed` or `hash_mismatch` |
| `moved` | Moved | warn | Yes | `moved` |
| `missing` | Missing | bad | Yes | `missing` or `pinned_version_lost` |
| `revoked` | Access revoked | bad | Yes | `access_denied` |

The UI's unverifiable rule differs from TS 6.4 for `moved` and `changed` (see 5.3).

`REPOS`: `[{id, name, type, modes, status, msg?, tenant, ms, last}]`.

| Field | Example | Read by | Server source |
|---|---|---|---|
| `id` | `'gd'` (matches a `LocId`) | Evidence matching `e.loc === r.id`; action set (`gd` re-authorise, `od` move to library, `gd` failing test) | `storage_repository.id` |
| `name` | `'Google Shared Drive'` | Card | `name` |
| `type` | `'Google Workspace'` (vault replaced by a deploy-specific text) | Card | Adapter display name |
| `modes` | `'Zero-transit, Link'` | Card | `mode` values |
| `status` | `'ok'`, `'bad'`, `'warn'` | Tone and label: Connected, Degraded, Flagged | `connection_status` and `ownership_type` (personal gives warn, BR-30) |
| `msg` | `Pair` | Card message | Last check error or BR-30 advice |
| `tenant` | `'Compliance BCMS drive, drive.file'` | Card | Repository config summary (no secrets) |
| `ms` | `['BCMS']` | Repo filter (shown when it intersects the org's systems), card text | Routing rules and default repositories |
| `last` | `'27 Sep 2026 06:00'` | Card | `last_checked_at` |

`ROUTING`: `[[msShort, repositoryName, mode, ruleText]]`, for example `['BCMS','Google Shared Drive','Zero-transit','Internal to Link']`. Filtered to the org's systems. Server: `storage_routing_rule`.

### 1.15 Picker files

`PICKER_FILES`: `{sp | gd: {path, files: [[name, dateLabel, version, hashAlg, modifiedBy]]}}`, for example `['Backup-Job-Log-Sep-2026.xlsx','28 Sep 2026','v3.0','quickXorHash','Bagus Prasetyo']`. Read by `modalVals` (picker: `meta = date + ', ' + version + ', ' + modifiedBy`, `hash = 'no hash'` when `none`) and `modalOk` (selected row). Server: a repository browse call through `storage-gateway` (`list` on the configured root folder) until the browser pickers (MSAL, Google Picker) replace the modal.

### 1.16 Frequencies

`FREQ`: `{[FreqId]: [en, id, days]}`: `daily` 1, `weekly` 7, `monthly` 30, `quarterly` 91, `semi` 182, `annual` 365, `event` 0. `FREQ_ORDER` gives the bar order on the freshness screen. Server: `operating_criteria` frequencies and the period in days.

### 1.17 Tera guidance

`TERA[screen]`: `{what: Pair, how: Pair[]}` for every screen id. Read by `renderVals.tera`. Stays static content in the web bundle.

### 1.18 Translations

`T[key]`: `Pair`. Read by `t(k)` (returns the key itself when missing) and the `t` proxy passed to views. Groups: navigation labels, status labels (the status codes listed in this section), column headers (`c_*`), action labels (also used by `act()` to pick an icon from `ACT_ICONS` by label), modal texts, toasts (`toast*`), empty states, timeline, tasks, framework and storage labels. Unused keys today: `toastTest`, `toastPass2`, `toastIms`. Stays in the web bundle (react-i18next catalogues later). Framework terms (stage labels, requirement titles, role labels) come from packs through the API.

### 1.19 Date helpers and constants

`TODAY_S`, `P(s)` (parses `s + 'T00:00:00'` local), `dd(s)`, `iso(d)`, `addD(s, n)`, `fmt(s, l)` (`'-'` when empty, else `day + ' ' + month + ' ' + year`, Indonesian month names for `id`). Client helpers; `TODAY_S` must come from the server (organisation time zone). `PLACEHOLDERS`, `DOCS` and `SHARED` are not read by the controller directly.

## 2. Derived values

Every rule below is quoted from the controller or the data module. Placement uses the codes from section 0.

### 2.1 Freshness, integrity and dates

| Value | Rule | Placement |
|---|---|---|
| Period `p` | `FREQ[freq][2]` | S |
| Freshness `fresh` | `freshOf(prod, p)`, see below | S (`freshness_status`) |
| Next due `next` | `p ? addD(prod, p) : null` | S |
| `nohash` | After building, `integ === 'ok'` and `hashAlg === 'none'` becomes `'nohash'` | S |
| Unverifiable (`bad`) | `!['ok','nohash','pending'].includes(integ)`; `chain()` uses the same set written as `['missing','revoked','changed','moved']` | S (integrity broken) |
| Missing file | `integ === 'missing'` or `'revoked'` (chain item `missing` flag) | S |
| Freshness rule text | `fresh <= p+1 d, aging <= round(p*1.25+1) d, expired <= 2p d, critical > 2p d`; per event: `no expiry; validity tied to the event` | S thresholds (configurable per tenant, ARCHITECTURE 6.2), C text |
| `dueTag(due, audit)` | No due: none. `dd(due) < 0`: `Overdue Nd` (bad). `audit` and `due > audit.date`: `After audit` (bad). `dd(due) <= 14`: `Due soon` (warn). Else none | C, with server `today` |
| Days left | `dd(audit.date)` | C |

```js
freshOf(prod, p) {
  if (!p) return 'fresh';
  const age = -dd(prod);
  if (age <= p + 1) return 'fresh';
  if (age <= p * 1.25 + 1) return 'aging';
  if (age <= p * 2) return 'expired';
  return 'critical';
}
```

### 2.2 Records after overrides (`data(msObj)`)

`data()` returns `{ms, reqs, docs, evs}` with `state.ov` applied. On the API these are stored state; the merge rules define what each command must change.

- Requirement, key `ms:req:id`: `st = o.st` if set; `owner = o.h` if set; `due = o.due` if set; `by = o.by` always copied when an override exists.
- Document, key `ms:doc:id`: shallow merge `{...doc, ...o}`.
- Evidence, key `ms:ev:code`: shallow merge; if `o.prod` then `next = p ? addD(o.prod, p) : null` and `fresh = freshOf(o.prod, p)`; then `owner = o.h` if set; then `next = o.due` if set (a reassign due date wins over the recomputed next date).
- `buildEvidence` runs on the overridden requirements, so a status change can add or remove sample evidence (see 2.16).

### 2.3 Chain items (`chain(d)`), placement S

Output: `{items, recs}`. `items` excludes any item whose override has `done: true`. `recs[stageId]` is the stage denominator.

Item factory `mk(stage, kind, id, title, act, h, due, o)`:

```js
key = ms.id + ':' + kind + ':' + id;  v = ov[key] || {};
h = v.h || h;  due = v.due !== undefined ? v.due : due;
st = (o.missing || (!due && h === 'none')) ? 'missing'
   : (due && dd(due) < 0) ? 'overdue' : 'pending';
after = !!(due && audit && due > audit.date);        // audit = ms.audit
item = {key, stage, kind, id, title, act, h, due, st, after,
        gate: !!o.gate, up: o.up || [], down: o.down || [], ref: o.ref, q: o.q};
```

Per stage source:

| `src` | `recs` | Items |
|---|---|---|
| `req` | `d.reqs.length` | Every requirement whose `st` is not `implemented` or `na`. Kind `req`, title `c.title`, holder `c.owner`, `ref` the requirement, `up` `c.risks`, `down` `[c.doc]`, `gate` `c.gate`, `missing` when `st === 'blocked'`. Action by status: partial `Complete implementation`; planned `Start implementation`; ns `Assign and start`; blocked `Resolve gate item: justification missing`; complete `Verify output (<name of by or owner> marked complete)`. Due: `c.due`, else `null` for blocked, else `addD('2026-10-01', (i*9) % 95)` with `i` the index in `d.reqs` (sample fabrication) |
| `soa` | `s.rec` | Every blocked requirement as kind `soa`: title `'Applicability entry: ' + c.title`, action `Add risk-based justification`, holder `c.owner`, due `null`, `missing`, `gate`, `down [c.id]`. Then every `X.soa` record as kind `x` |
| `doc` | `d.docs.length` | Every document not `approved`. Kind `doc`, title `title + ', v' + ver`, holder `owner`, due `rev`, `ref` the document, `up` the ids of up to 3 requirements with `c.doc === doc.id`. Action: expired `Start review: review date passed`; review `Approve review`; draft `Continue draft and approve` |
| `ev` | `d.evs.length` | Every evidence that is unverifiable or has `fresh` `expired` or `critical`. Kind `ev`, id `code`, title `title + ', ' + ctrl`, holder `owner`, due `next`, `ref` the evidence, `up [ctrl]`, `missing` when integ is `missing` or `revoked`. Action: unverifiable `Re-link file in repository (<INTEG English label>)`, else `Submit <frequency, lower case> evidence` |
| absent | `s.rec` | Every `X[stageId]` record as kind `x` with its `t`, `act`, `h`, `due`, `gate`, `up`, `down` |

Every item carries `q` from its stage. Sample totals: ISMS 63 items, QMS 18, BCMS 25, ABMS 35.

Mapping to the TS 9.3 pending record: `key` to `ref`; `stage` to `ref.stage`; `id` to `ref.id`; `title`; `act` to `action`; `h` to `holder.user_id`; `due` to `due_at`; `st` to `status`; `after` to `after_audit`; `up` and `down` to `upstream` and `downstream` ids; `gate` (new); `q` from the stage definition; `ref` rehydrated on the client (section 4.3). The server should implement the TS 6.9 per-stage derivation table; the UI only displays `st`.

### 2.4 Requirements, documents and gates

| Value | Rule | Placement |
|---|---|---|
| Document `expired` | Stored in the sample. Every sample `expired` document has `rev` before today and every `approved` one has `rev` on or after today. Server: `approved` and `rev < today` gives `expired` (BR-10) | S |
| Gate items `gateItems(d)` | Blocked requirements as `{id, type: 'Control' or 'Requirement' (by unit, localised), why: c.note or 'Blocked', h: c.owner, due: null, key: 'req:' + id}`; then every `X` record of any stage with `gate: true` as `{id, type, why: x.act, h: x.h, due: x.due, key: 'x:' + id}` where `type` is `Risk`, `Treatment`, `SoA`, `BIA` for those stage ids, else the stage id. Overrides are not applied (see 5.11) | S |
| Gate name `gateName(ms)` | `isms` `Risk & SoA`; `qms` `Risk & Opportunity + Process Map`; `bcms` `BIA & Risk Assessment`; `abms` `Bribery Risk Assessment` | S (pack gate phase name) |
| Orphan candidate | No requirement with `c.doc === doc.id`: badge `Orphan candidate`, `noUp` `Not linked to any control or requirement` | S |
| Used by | `doc.shared` gives the organisation's system shorts joined plus `' (shared IMS document)'`, else `ms.short`; golden thread shared marker lists the other systems of the organisation | S (`entity_ms_link`, the systems that actually link the document) |
| Requirement notes | Gate: `note + ': ' + gateName + ' gate cannot close until this is resolved.'`; partial with expired or critical evidence: held at Partial text; complete: `Marked complete by <by or owner>. Verification by a different person is required ...` | C over S data |
| `noUp`, `noDown` | `noUp` for controls applicable without risks: `No risk linked (Cl. 6.1.3)`; `noDown` when no evidence and `st` not `na`, `ns`, `planned`: `No evidence this cycle` | S flags, C text |

Sample gate items: ISMS `A.5.23`, `A.8.12`, `R-031`, `SOA-01`; BCMS `Cl. 8.2`, `BIA-03`, `BIA-06`; ABMS `Cl. 4.5`; QMS none.

### 2.5 Counts per screen

Owner scoping: when `role === 'owner'`, `controlsScreen`, `freshScreen` and `docsScreen` filter requirements, evidence and documents to `owner === me`. Chips with `n === 0` are hidden unless active or marked `always`. Search `match(q, ...parts)`: every whitespace-separated word of `q` must occur in the lower-cased joined parts.

| Screen | Value | Rule | Placement |
|---|---|---|---|
| Nav | `controls` badge | `gateItems(d).length` | S |
| Nav | `chain` badge | Chain items with `st !== 'pending'` | S |
| Nav | `fresh` badge | Evidence with `fresh === 'critical'` | S |
| Nav | `mytasks` badge | `taskItems(me).length` | S |
| Controls | Tabs | `implemented` (sub `of <reqs>`), `partial` (partial plus complete), `gate` (gate items), `docsApproved` (sub `of <docs>`), `docsExpired`; default tab `implemented` | S/C |
| Controls | Requirement chips | `all`, `implemented`, `complete`, `partial`, `planned`, `ns`, `blocked`, `na`; default chip is the tab id, or `['partial','complete']` for the partial tab | S/C |
| Controls | Document chips | `all`, `approved`, `expired`, `review`, `draft`; default `expired` on the expired tab, else `approved` | S/C |
| Chain | Hero | `items.length` (sub `of <sum of recs> records`), overdue or missing (`st !== 'pending'`), after audit, ready `= sum(recs) - items.length` | S |
| Chain | Stage tabs | Per stage: `open` items, `ov` (not pending), `pend`, `ready = max(0, rec - open)`, sub `ready / rec ready`, tone bad if `ov`, warn if `pend`, else ok, bar widths `ready/rec`, `pend/rec`, `ov/rec` | S/C |
| Chain | Default stage | Requested tab if valid, else the first stage with items, else the first stage | C |
| Chain | Chips | `open` (all items in pool, default), `pending`, `overdue`, `missing`, `after`; for `req`, `doc`, `ev` stages without a person filter also `ready` (`max(0, recs - open)`) and `all` | S/C |
| Chain | Ready rows | `req`: `implemented` or `na`; `doc`: `approved`; `ev`: `fresh` or `aging` and integ `ok`, `nohash` or `pending`; `soa`: none | S |
| Chain | Pending per person | Per holder: `open`, `overdue` (not pending), `after`, `next` (earliest due), stage labels; sorted by overdue desc then open desc; shown only to `manager` and `auditor` and only when items exist | S (`/audit/pending`) |
| Freshness | Tabs | Counts per band, `cannot` (unverifiable), `docs30` (`dd(rev) <= 30`, includes overdue); no default tab; `fresh` sub `of <evs>` | S/C |
| Freshness | Frequency bars | Per `FREQ_ORDER`: segment widths per band over `max(1, count)`, sub `count, <expired or critical> expired` | S/C |
| Freshness | Donut | Arc length `count / evs * 2*PI*17` per band | C |
| Freshness | Sort | Unverifiable first, then `critical, expired, aging, fresh`, then `next` ascending (`'9'` for none); `docs30` sorted by `rev` | C |
| Docs | Chips | `all` (default), `approved`, `expired`, `review`, `draft`; groups by tier order with labels `Policies` to `Forms` | S/C |
| Lists | Paging | `finishRows`: 30 rows times `(1 + more)`, extended to keep the selected or expanded row visible; empty group headers dropped | C (server pages of 200) |

### 2.6 Implementation overview (`overviewScreen`)

| Value | Rule | Placement |
|---|---|---|
| Open per clause | Chain item stage to clause: `context` and `brisk` 4; `risk`, `treatment`, `soa`, `action`, `objective` 6; `document` 7; `metric` 9; every other stage 8. Clause 10 gets `findings.open` when non-zero | S |
| Maturity values | Per clause with readiness `p` and open count `o`: `[min(100, p+14), p, max(0, p-10-(o ? 8 : 0)), max(0, p-22)]` for Documented, Implemented, Evidenced, Measured | S (real per-dimension scores, see 5.14) |
| Level | `q(x) = max(0, min(4, round(x/25)))`; level `q(mean of the four values)`; labels Initial, Basic, Defined, Managed, Optimised; colour ok at 3 or more, warn at 2, else bad | S value, C labels |
| Current phase | First phase with `verified < total` and no locked activity, else the last phase | S |
| Blockers | Gate items (`title = titleOf(id)` or `why`), then overdue non-gate chain items sorted by due; first 5 | S |
| Next gate | Gate phase not fully verified: `<gate phase name>, <gate items> items`; else `All gates passed` | S |

### 2.7 Phases (`phases(d)`, `phasesScreen`)

Activity status, in precedence order (placement S, TS 6.6):

```js
o = PHASE_STATE.ov[no + ':' + (ai+1)];
if (o) st = o.startsWith('blocked:') ? 'blocked' (blocker = o.slice(8)) : o;
else if (no <= verifiedUpTo) st = 'verified';
else if (lockedFrom && no >= lockedFrom) st = 'locked';
else if (no === current) st = 'progress';
else st = 'ns';
if (ov[key].st) st = ov[key].st;
```

| Value | Rule | Placement |
|---|---|---|
| Owner | `ov[key].h`, else for a blocked activity the blocker's requirement owner or `X` holder, else a rotating pool `ppl[(pi*3 + ai) % ppl.length]` (sample fabrication; pools per system hard-coded) | S |
| Output | First `OUTPUT_MAP` keyword in the title gives `out`; `doc` is that document in `d.docs` | S |
| Date | `verified`: `addD('2024-09-01', pi*45 + ai*4)`; `locked`: `null`; else `ov[key].due` or `addD('2026-10-01', (ai*6 + pi*3) % 50)` (sample fabrication) | S |
| Counts | `c` per status and `total` | S |
| Default phase | `state.tab.phases`, else the current phase (2.6) | C |
| Stepper | `done` when all verified, `locked` when all locked, `blocked` when any blocked, `started` when any verified, complete or in progress; fill `lastDone / (n-1) * 90 %` | C |
| Banner | All locked: `lockedBanner + ' ' + <gate no>. <gate name>.`; gate phase not fully verified: `gateBanner + ' ' + <blocked> blocked = <gate items> open gate items.` (the BR-46 comparison); fully verified: `phaseDone` | C over S counts |
| Owner action text | verified `Verified by <ms.mgr>`; complete `Awaiting verification`; progress `Produce output and mark complete`; blocked `Resolve gate item <blocker>`; ns `Start when predecessor is complete`; locked `-` | C |
| Verify phase page action | Phase counts all verified: `Phase <n> is already verified`, else `Phase verification needs all activities Verified` | S (BR-12) |

### 2.8 Portfolio (`portfolio()`)

| Value | Rule | Placement |
|---|---|---|
| Card stats | Gate items count; findings `open` (label adds `, <major> Major`; colour bad when major, warn when open); `docExp` (documents `expired`); `evCrit` (evidence `critical`); `evBad` (unverifiable evidence); `af` (chain items after audit) | S |
| Clause colour | `>= 90` ok, `>= 60` warn, `> 0` bad, else border | C |
| Radar | Points at angle `-90 + i*360/7`, radius `max(2, p/100*46)` around (60, 60) | C |
| Attention items | Weight 0: gate items (`<n> open gate items, <gateName>`, tag Blocked). Weight 1: audit within 70 days (`<audit name> in <n> days`; sub `<af> pending items are due after the audit date` or `Preparation window open`; tag `After audit, <af>` or Due soon). Weight 2: expired documents (sub lists the ids). Weight 3: critical evidence (`<n> critical evidence`, tag Critical, opens the fresh tab `critical`) and unverifiable evidence (`<n> evidence files cannot be verified`, tag Integrity, opens the fresh tab `cannot`). Weight 4: banner, with text and target hard-coded per system (`bcms` connector degraded, tag `Error`, opens storage; `qms` edition transition, tag `Transition`; others beta pack, tag `Beta`; both open fw). English texts switch to the singular when the count is 1. Sorted by weight | S data, C rules |
| Attention groups | Blocking: weight 0 or (4 and tag `Error`). Audit soon: weight 1. Housekeeping: weights 2, 3, or (4 and tag not `Error`) | C |
| Upcoming audits | Systems with `audit`, sorted by date; tag `Prep window open` at 60 days or less, `Prep opens <date - 60>` at 120 or less, else `Planned` | C (60 days should come from `audit_event.prep_window_days`) |

Sample (gate, findings, expired documents, critical evidence, unverifiable evidence, after audit): ISMS 4, 3 (1 major), 5, 3, 3, 16; QMS 0, 2, 1, 0, 0, 4; BCMS 3, 0, 0, 0, 0, 0; ABMS 1, 0, 0, 0, 0, 0.

### 2.9 Audit readiness and traceability test (`auditScreen`, `resolveNode`)

```js
resolveNode(stage, id, d, ch) {
  if (id && id.startsWith('ev:')) { e = d.evs.find(x => x.ctrl === id.slice(3));
    if (!e) return {stage, id:'-', st:'broken', cause:'No evidence recorded this cycle', h:'none', due:null, title:''};
    id = e.code; }
  if (!id) return {stage, id:'-', st:'broken', cause:'No record linked', h:'none', due:null, title:''};
  item = ch.items.find(i => i.id === id);           // first match, so a blocked control resolves to its control-stage item
  if (item) return {stage, id, st: item.st === 'pending' ? 'pending' : 'broken', cause:item.act, h:item.h, due:item.due, after:item.after, item, title:titleOf(id)};
  return {stage, id, st:'ready', h:null, due:null, title:titleOf(id)};
}
```

| Value | Rule | Placement |
|---|---|---|
| Hero | Same four numbers as the chain hero | S |
| Selected chain | `CHAINS` entry with `id === traceId`, else the first; `Random` picks another chain at random | C |
| Node label | Due: `Overdue, ` when past, `After audit, ` when after, then the date; no due and not ready: `Missing` | C |
| Warning | Broken nodes: `<n> break points: <stage> <id>: <cause> (<holder or Missing>, <due>); ...` plus pending list; only pending: pending list; none: `No break points: this chain is audit-ready.` | C |
| Stage table | Per stage: `rec`, `pend`, `ov`, `af`, `ready = max(0, rec - open)`, `pct = round(ready/rec*100)`, `next` = earliest due not in the past | S |

### 2.10 Golden thread, documents calendar and drill links

Golden thread node resolution (`gtScreen`), placement S (`/audit/chain?anchor_id=`). With `lc` the lower-cased query:

1. A `CHAINS` entry whose id matches `lc`: its nodes.
2. Else find requirement, evidence (by code), document and `X` record (case-insensitive). With a requirement (or the evidence's requirement) `cc`: for `unit === 'ctrl'` nodes `risk` (first linked risk or `null`), `control`, `soa`; otherwise the `req` stage only; then `document` (`cc.doc`) and `evidence` (`'ev:' + cc.id`).
3. Else a document: `document` then up to 4 requirements implementing it.
4. Else an `X` record: the chain containing its exact id, else a single node.
5. Else a chain containing the id as a node (case-insensitive), else requirements linking the id as a risk (`risk` node plus up to 4 `control` nodes), else the first `X` record whose `up` or `down` lists the id: two nodes, the hit placed on the adjacent stage (previous stage for `up`, next for `down`).

Node fields: stage label, id, title (or the cause when broken), status label, colours, `clause` from `CLAUSE_AT_RISK` when broken, `shared`, owner (`n.h`, else requirement, document or evidence owner), sub line (evidence: repository, version, integrity, freshness, produced date, red when integ is not `ok` or freshness is expired or critical; document: version, status, review date, red unless approved; other non-ready nodes: cause and due). Suggestions: chain ids plus a hard-coded list per system, first 7.

Review calendar (`calScreen`), placement C over the documents list: group `Overdue` with `dd(rev) < 0` sorted by `rev`; then for months 0 to 3 from the current month, documents with `rev` inside the month (month 0 only `dd(rev) >= 0`), sorted by `rev`; empty months skipped; documents more than four months out are not shown.

Drill links (`nodeGo` and fact links), placement C: chain item to the chain stage with the row open; requirement to controls (tab `partial` or `implemented` by status, chip set to the status); document to docs; evidence to freshness.

### 2.11 Timeline and My Tasks

| Value | Rule | Placement |
|---|---|---|
| Lane position | `fx(s)` maps dates between `2023-04-01` and `2028-10-01` to 0 to 100 percent; year ticks 2024 to 2028 | C |
| Event kind | `past` when `dd(d) < 0`, `next` when `e.next`, else `planned`; default selection is the current system's next event | S (`next` per TS 9.4) |
| Event detail | Tag: Completed, `<n> days left`, or Planned. Next: readiness numbers from that system's chain, `prep` from `PREP`, `findings` from `PAST`. Past: `result` and `findings`. Planned: `window = date - 60 (60 d)` and `prereq` from `CYCLE_ITEMS` | S |
| Cycle list | `CYCLE_ITEMS` of the current system; first 4 unless `cycleAll` | S |
| Drift rows | `rows` as given; `src` `unverif`: unverifiable evidence; `nohash`: evidence with `nohash`; `metric`: every `X.metric` record; `exercise`: every `X.exercise` record. Tone bad when any row | S (`drift_result`) |
| Task list | `taskItems(me)`: per system of the organisation, chain items with `h === me`, excluding requirement items with `st === 'complete'` completed by `me` (`(ref.by or ref.owner) === me`) | S |
| Task tone | Not pending or after audit: bad; due within 7 days: warn; else mute | C |
| Task groups | Overdue: `st !== 'pending'`; This week: pending and `dn <= 7`; Later: pending and (`dn` null or `> 7`); sorted by `dn` (null last) | C |
| Due label | `Overdue Nd`, `Today`, `<date>[, After audit]`, or `Missing` | C |
| On-track ring | `round((total - overdue) / total * 100)`, 100 when empty | C |
| Week strip | Monday to Sunday of the current week; dots: overdue item due that day (bad), other item due (warn), audit day (accent); Monday gets a bad dot when anything is overdue and it has no other dot | C |
| Greeting | Wall-clock hour (`new Date()`), first name | C |

### 2.12 Storage and licence

| Value | Rule | Placement |
|---|---|---|
| Repositories shown | `REPOS` whose `ms` list intersects the organisation's system shorts | S |
| Reference counts | Evidence of every org system with `e.loc === r.id`: `bad` (unverifiable), `pend` (`pending`), `nohash`, `okN = total - bad - pend` (includes `nohash`); bar ok, pending, bad; `refLine = okN / total references` | S |
| Status label | `ok` Connected, `bad` Degraded, other Flagged | C |
| Issues chip | Evidence with `integ !== 'ok'` (includes `pending` and `nohash`); one chip per non-ok `INTEG` code; `all` | S/C |
| Last check column | Literal `27 Sep 2026 06:00` for `pending`, else `29 Sep 2026 06:00` | S (`storage_object.last_verified_at`) |
| Licence bars | `pr('a of b')` gives `n = a`, `pct = round(a/b*100)`; frameworks and systems use `MSL.length` as `a` | S |

### 2.13 Access rules enforced in the browser today

| Rule | Code | Server enforcement |
|---|---|---|
| Visible screens | `visFor(role)`; `landing()` keeps the wanted screen if allowed, else the first allowed screen (never portfolio for single-system orgs) | RBAC per route and endpoint |
| Owner scoping | Lists filtered by `owner === me` for `owner` (controls, fresh, docs) | RLS on owner (TS 7.1, 9.1) |
| Verify allowed | `canVerify = role === 'manager' or 'auditor'` | MS Manager per TS 6.1 and 6.6 (see 5.5) |
| Self-verification | Requirement: `c.by === me` shows `toastSelfVerify`; activity: `a.by === me` | Separation of duties (TS 7.4, CHECK on verifier) |
| Pending per person | `canSeePeople = role === 'manager' or 'auditor'` | TS 7.5 matrix (see 5.6) |
| Mark complete | No role check | Domain Owner on own entries, MS Manager (TS 7.3) |

### 2.14 Values hard-coded in the controller that must become data

| Location | Hard-coded value | Replacement field |
|---|---|---|
| `ORGS` | Organisation list | `orgs` from session |
| `gateName` | Gate names per system id | `ms.gateName` |
| `docDetail` | Approver per system (`hendra`, `sari`, `hendra`, `lina`), storage path `Compliance / <short> / Documents`, pinned hash algorithm by `ms.loc` | `doc.approver`, `doc.path`, `doc.hashAlg` |
| `locFacts` | Fingerprint suffix `<code letters>a91f...3c7e`; last check `27 Sep 2026 (ok)` for pending | `e.hash` (shortened), `e.lastGoodCheck` |
| `phases` | Owner pools per system | Stored owners |
| `gtScreen` | Suggestions per system | `ms.gtSuggestions` |
| `portfolio` | Banner attention text, tag and target per system id | `ms.banner.kind` plus text |
| `fwScreen` | Transition (`qms`) and beta (`abms`) flags; update channel texts with dates; check-update results | `PACKS[ms].status`, profile and pack-channel data |
| `storageScreen` | Actions by repo id (`gd`, `od`); `gd` test failure text; vault type text by deploy; last check times | Repository `adapter`, `ownership_type`, `connection_status`, `last_checked_at` |
| `timelineScreen` | Window 2023-04-01 to 2028-10-01; label rewrites for event titles | Derived from events |
| `renderVals` | `updatedAt` `2 min ago` | Snapshot timestamp |
| Data module | `TODAY_S` | Server `today` |

### 2.15 Sample-only fabrications the API must not copy

- Requirement chain due dates `addD('2026-10-01', (i*9) % 95)`; activity owners from pools; activity dates; evidence `prod` generation in `buildEvidence` (including resetting `prod` when the period ended more than 120 days ago); evidence version, hash algorithm and path built from list indexes; static stage `rec` counts; maturity values derived from the clause percentage.
- `buildEvidence` skips `na`, `ns`, `planned`, `blocked` and, for BCMS, keys outside a fixed list. Because it runs on overridden requirements, marking a planned control complete creates an evidence row, and marking a partial control complete makes its generated evidence fresh.
- For parity tests the database seed writes these generated values as stored data, so sample and API outputs match field for field.

## 3. User actions and mutations

### 3.1 Override store

`ovSet(key, patch)` merges `patch` into `state.ov[key]`. Consumers: `data()` for `req`, `doc` and `ev` keys; the chain item factory for any chain key (`h`, `due`, `done`); `phases()` for `act` keys (`st`, `h`, `due`, `by`). Overrides live in memory, are lost on reload, and are not scoped by organisation (the same system id in another organisation sees them). On the API every patch below becomes a server command; the read model then returns the new state.

### 3.2 Detail panel actions

Toast texts are English; every one also has its Indonesian form. `Reminder sent to` is `t('toastRemind')`.

| Action | Shown when | Current effect | Server command |
|---|---|---|---|
| Requirement: Mark complete | `st` in `partial`, `planned`, `ns`, `blocked` and not `gate`; any role | `ovSet(ms:req:id, {st:'complete', by:me})`; toast `Marked complete: awaiting verification by the MS Manager` | `POST /ms/{ms}/applicability/{id}/transitions {to:'complete'}`; records `completed_by`, `completed_at`; RBAC owner or MS Manager; audit trail (state gap, 5.1) |
| Requirement: Verify | `st === 'complete'` and role manager or auditor | If `c.by === me`: toast `You completed this item: verification must be done by someone else`. Else verify modal with meta `<id>, completed by <by>, verify as <me>, <today>`. Confirm: `ovSet(key, {st:'implemented', by:null})`; toast `Verified. Status recalculated across Module 1, 2 and 3.` | `POST .../applicability/{id}/transitions {to:'implemented'}`; verifier differs from completer and verification date differs from completion date (modal text; principle of BR-08 and BR-09), BR-01 evidence in period with a valid link; 422 with the rule id otherwise |
| Requirement: Trace (gate) | `gate` | `go('chain', {tab:{chain:'soa'}})` | None |
| Requirement: Send reminder | Always | Toast `Reminder sent to <owner>, email + in-app` | `POST /reminders {entity_ref, recipient}`; BR-50 throttle (72 hours) |
| Requirement: Reassign | Always | Opens reassign modal with `h = owner`, `due` = chain item due, else `c.due`, else empty | Assignment command (3.3) |
| Requirement: Trace from here | Not `gate` | `go('gt', {gtId: id})` | None |
| Document: Start review | `st === 'expired'` | `ovSet(ms:doc:id, {st:'review'})`; toast `<id>, review started: assigned to <owner>` | `POST /ms/{ms}/documents/{id}/transitions {to:'in_review'}`; review task for the owner |
| Document: Open review | `st === 'review'` | Toast `Opening <id> v<ver>: review workflow`; no change | None today; approval command missing (5.8) |
| Document: Continue draft | `st === 'draft'` | Toast `Opening <id> v<ver>: draft editor` | None |
| Document: Upload new version | `st === 'approved'` | `openPicker(key, ms, 'doc')` | Link or upload command (3.3) |
| Document: Send reminder, Trace | Always | Toast `Reminder sent to <owner>`; `go('gt', {gtId})` | `POST /reminders`; none |
| Evidence: Re-link file or Submit evidence | Re-link when unverifiable, else Submit | `openPicker(key, ms, 'ev')` with the evidence's system | Link or upload command (3.3) |
| Evidence: Send reminder | Always | Toast `Reminder sent to <owner>` | `POST /reminders` |
| Evidence: Reassign | Always | Reassign modal with `h = owner`, `due = next` | Assignment command; changes owner and next due |
| Evidence: Trace | Always | `goIn(ms)('gt', {gtId: code})`, switching system when opened from storage | None |
| Chain record (`x`, `soa`): Send reminder | Always; primary when holder is not `none` | Toast `Reminder sent to <holder>, email + in-app` | `POST /reminders` |
| Chain record: Reassign | Always; primary when holder is `none` | Reassign modal with `it.h`, `it.due`, `it.id` | Assignment command |
| Chain record: Change due date | Always | Same modal | Assignment command |
| Chain record: Trace | Always | `go('gt', {gtId: id})` | None |
| Activity: Mark complete | `st` `progress` or `ns` | `ovSet(ms:act:no, {st:'complete', by:me})`; toast as requirement | `POST /ms/{ms}/activities/{id}/transitions {to:'complete'}`; BR-40 output document; TS 6.6 order (5.12) |
| Activity: Verify output | `st === 'complete'` and role manager or auditor | Self check on `a.by`; verify modal with `verifyTo:'verified'`, meta `<no> <title>, <by or owner> to <me>, <today>`. Confirm: `ovSet(key, {st:'verified', by:null})`; toast `Verified. ...` | `POST .../activities/{id}/transitions {to:'verified'}`; `verified_by` differs from owner |
| Activity: Open gate item | `st === 'blocked'` | `go('controls', {tab:{controls:'gate'}})` | None |
| Activity: Record blocker | `st` `progress` or `ns` | Toast `Blocker recorded and linked to the gate item`; no change | `POST .../activities/{id}/transitions {to:'blocked', blocker_gate_item_ref, blocker_reason}` (BR-39); needs a form |
| Activity: Send reminder, Reassign | Not `locked` | Toast `Reminder sent to <owner>`; reassign modal with `a.owner`, `a.date`, `<no> <title>` | `POST /reminders`; assignment command |
| Drift row with fixed rows: Send reminder, Trace | Always | Toast; `go('gt')` | `POST /reminders`; none |

Fact links (implementing document, last evidence, control, output, blocked by) are navigation only.

### 3.3 Modals (`modalVals`, `modalOk`)

| Modal | Opened by | Fields | On confirm (current) | Server command |
|---|---|---|---|---|
| Reassign | `openReassign(key, h, due, id)` | `h` select from `peopleOptions` (default `'none'`), `due` date input; `afterWarn` when `due > msObj.audit.date` (current system's audit) | `ovSet(key, {h, due: due or null})`; toast `Item updated. After-audit flag recalculated.` | `POST /ms/{ms}/records/{entity_type}/{id}/assignment {holder_user_id, due_at}` with `If-Match`; returns a BR-41 warning when after the audit |
| Picker | `openPicker(key, ms, kind)` when `ms.loc !== 'vault'`; source `gd` when `ms.loc === 'gd'`, else `sp` | Title `Select evidence file from repository` (`Select document file from repository` for documents); file list from `PICKER_FILES[src]`; `fileIdx` selection (default 0) | Evidence: `ovSet(key, {prod: today, integ: hash 'none' ? 'nohash' : 'ok', ver: file version, hashAlg: file hash or 'none', loc: src})`; toast `Evidence linked: version pinned, hash recorded, <file>, <version>`. Document: `ver = nextDocVer(doc)` (`floor(parseFloat(ver) or 0) + 1` with one decimal: `3.2` to `4.0`, `-` to `1.0`), `ovSet(key, {ver, appr: today, rev: today + 365, st:'approved'})`; toast `<id> v<ver> approved, <file> pinned` | Evidence: `POST /ms/{ms}/evidence/{id}/files {repository_id, external_item_id, external_version_id, produced_at, mode: 'submit' or 'relink'}` (ARCHITECTURE 6). Document: `POST /ms/{ms}/documents/{id}/versions {repository_id, external_item_id}` creating a version for approval (5.7) |
| Upload | `openPicker` when `ms.loc === 'vault'` | Title `Submit evidence` (`Upload new version` for documents); no file input today | Evidence: `n = digits of ver or 0`, `ovSet(key, {prod: today, integ:'ok', ver:'v' + (n+1), hashAlg:'SHA-256'})`; toast `Evidence uploaded to Managed Vault: SHA-256 recorded`. Document: same patch as the picker; toast `<id> v<ver> uploaded to Managed Vault: SHA-256 recorded` | `POST /storage/upload-intents`, upload through `storage-gateway` (SHA-256 computed), then the evidence or document version command with `storage_object_id` |
| Verify | Verify actions | `meta` text | `ovSet(key, {st: verifyTo or 'implemented', by:null})`; toast `Verified. ...` | Transition commands in 3.2 |

`record(key)` resolves the current document or evidence behind a key for these handlers.

### 3.4 My Tasks

| Task kind | Button | Current effect | Server command |
|---|---|---|---|
| `ev` | Submit | `openPicker(i.key, m, 'ev')` | Link or upload (3.3) |
| `req` | Mark done | `ovSet(i.key, {st:'complete', by:me})`; toast `Marked complete: ...` | Requirement complete transition |
| `doc` | Start review (expired) or Open document | Expired: `ovSet(i.key, {st:'review'})`; then toast `Opening <id>` | Document `in_review` transition when expired; else none |
| `x` | Mark done | `ovSet(i.key, {done:true})` (item leaves every chain list); toast `Item updated. After-audit flag recalculated.` | `POST /ms/{ms}/records/{entity_type}/{id}/complete-action`: completes the record's pending action (reassessment, metric value, confirmation) and writes the audit trail |

Task card text by kind: evidence `Re-link the file for <title>` or `Upload this period's <title>`; requirement `Finish setting up <title>` with `note` or action; document `Finish the draft of <title>` or `Review <title>`, with action and version; record: action as title, record title as text. Filters (`all`, `over`, `week`, `later`, `ms:<id>`) are client state.

### 3.5 Storage, framework, timeline and portfolio actions

| Action | Current effect | Server command |
|---|---|---|
| Storage: Re-authorise (repo `gd`) | Toast `Redirecting to Google Workspace consent...` | `POST /admin/storage/repositories/{id}/reauthorize` returning a consent URL; browser redirect |
| Storage: Move to team library (repo `od`) | Toast `Move request sent to Tenant Administrator` | `POST /admin/storage/repositories/{id}/move-requests` (BR-30) |
| Storage: Test connection | `gd`: toast `Connection failed: token expired (401)`; else `Connection OK, <references> references reachable, next check 06:00` | `POST /admin/storage/repositories/{id}/test`; result sets `connection_status`, returns counts and next check |
| Storage: Settings | Toast `Connector settings opened` | None (settings screen later) |
| Storage: row detail | `evDetail` of the row's system | As 3.2 |
| Framework card: Manage | `setMs(id)`, `go('m1overview')` | None |
| Framework card: transition assistant | `setMs(id)`, `go('phases', {tab:{phases:9}})` | None (phase 9 is hard-coded) |
| Framework: check (card area) | onprem: toast `Choose a signed .bundle file to import`; saas: toast `Checked: ISO9001-2026 1.0.0 and ISO37001-2025 0.7.0 available` | `POST /admin/packs/import` (multipart) or `POST /admin/packs/check-updates` |
| Timeline: add event (lane without events) | Toast `Audit event form opened` | `POST /ms/{ms}/audit-events` (needs a form) |
| Timeline: Open audit readiness | `setMs(em.id)`, `go('audit')` | None |
| Portfolio: card, stats, gate chips, attention rows | `setMs` plus `go` to controls, audit, fresh, chain, storage or fw | None |

### 3.6 Page actions (`pageActions`)

| Screen | Action | Current toast | Server command |
|---|---|---|---|
| portfolio | Export board | `Board exported as PDF` | `POST /exports {type:'portfolio_board', format:'pdf'}` (job, download link) |
| m1overview | Readiness report | `Readiness report queued, you will get a link shortly` | `POST /ms/{ms}/exports {type:'readiness'}` |
| controls | Export SoA | `Statement of Applicability exported (xlsx)` | `GET /ms/{ms}/applicability/export?format=xlsx` |
| controls | Add control (primary) | `New custom control form opened` | `POST /ms/{ms}/applicability` (needs a form) |
| phases | Verify phase (primary) | Rule in 2.7 | `POST /ms/{ms}/phases/{n}/verify` (BR-12) |
| docs | Export | `Document register exported (xlsx)` | `GET /ms/{ms}/documents/export?format=xlsx` |
| docs | New document (primary) | `New document form opened` | `POST /ms/{ms}/documents` (needs a form) |
| audit | Build evidence pack (primary) | `Evidence pack is being compiled, manifest will appear in <repository of ms.loc>` | `POST /ms/{ms}/evidence-packs` (job `evidence-pack.build`, BR-34) |
| audit | Auditor access | `Guest access link created, valid 14 days` | `POST /ms/{ms}/auditor-access {expires_in_days:14}` (BR-20) |
| chain | Remind all holders (primary) | `Reminders sent to <n> holders`, `n` = distinct non-`none` holders of the chain items | `POST /reminders/bulk {ms, scope:'open_chain_items'}`; count from the result after BR-50 throttling |
| timeline | Add audit event (primary) | `Audit event form opened` | `POST /ms/{ms}/audit-events` |
| fresh | Run integrity check (primary) | `Integrity check started for <evidence count> references` | `POST /ms/{ms}/link-health/run` (job `link-health.check`) |
| cal | Calendar feed | `Calendar feed (.ics) copied to clipboard` | `GET /ms/{ms}/surveillance/reviews.ics` (signed URL) |
| fw | Import offline bundle (onprem) or Check for updates (saas) | `Choose a signed .bundle file to import` or `Checked, 2 updates available` | As 3.5 |
| storage | Connect repository (primary) | `Repository connection wizard opened` | `POST /admin/storage/repositories` (needs a wizard) |
| gt, mytasks | None | | |

### 3.7 Client-only interactions

These never reach the server: `go`, `goIn`, `setMs`, `setOrg` (on the API, an organisation switch reloads the snapshot), `setTab`, `setChip`, `openRow`, search (`setQ`), person filter, frequency filter, drift selection, `cycleAll`, timeline event selection, trace chain selection and Random, golden thread query (`gtQ`, `gtId`), task filter, theme, language, sidebar, Tera panel, menus, Show more, close panel and modal, the persona switcher (`roleOptions`) and the deploy toggle (`toggleDeploy`). The last two are demo features; on the API the role comes from the session and the deploy mode from `GET /system/profile`.

## 4. DataSource interface

### 4.1 Approach

The views keep reading the same view model. The controller keeps its row, detail and screen builders. What changes is where the records and the derived lists come from:

- `this.D` becomes a `Snapshot` from a `DataSource`, with the same keys the controller reads today.
- `data(ms)`, `chain(d)`, `gateItems(d)` and `phases(d)` read precomputed values from `Snapshot.bundles[msId]` (the derived values marked S in section 2).
- `state.ov` and `ovSet` disappear from the controller. Each action calls a command, then reloads the changed bundles.
- `SampleDataSource` holds the override store and computes bundles with the current code moved verbatim from the controller into `src/data/sample-derive.js`. `ApiDataSource` reads the same shapes from the API.
- The source is chosen at build time (`VITE_DATA_SOURCE=sample` or `api`), as ARCHITECTURE 14.1 states.

### 4.2 Interface

```ts
// apps/web/src/data/DataSource.ts
export type Pair = [string, string];
export type IsoDate = string;
export type PersonId = string;                       // 'none' = unassigned
export type MsId = string;
export type RecordKey = string;                      // `${MsId}:${'req'|'doc'|'ev'|'soa'|'x'|'act'}:${string}`
export type ReqStatus = 'implemented'|'partial'|'planned'|'ns'|'blocked'|'na'|'complete';
export type DocStatus = 'approved'|'expired'|'review'|'draft';
export type Fresh = 'fresh'|'aging'|'expired'|'critical';
export type IntegId = 'ok'|'nohash'|'pending'|'changed'|'moved'|'missing'|'revoked';
export type ItemStatus = 'pending'|'overdue'|'missing';
export type ActStatus = 'verified'|'complete'|'progress'|'blocked'|'ns'|'locked';
export type FreqId = 'daily'|'weekly'|'monthly'|'quarterly'|'semi'|'annual'|'event';

export interface Organisation { id: string; name: string; ms: MsId[]; deploy: 'saas'|'onprem'; sites: number }
export interface ManagementSystem {                  // section 1.2; new optional fields replace hard-coded switches
  id: MsId; code: string; ed: string; short: string; name: Pair; mgr: PersonId; mgrRole: string; color: string;
  scope: string; certifier: string; lead: string; cert: string; stage: Pair;
  audit: { name: Pair; date: IsoDate; days: number } | null;
  clauses: number[]; findings: { open: number; major: number };
  banner?: { tone: 'info'|'warn'|'bad'; text: Pair; kind?: 'connector'|'transition'|'beta' };
  loc: string; locMode: string; pack: string; phase: Pair; unit: 'ctrl'|'req'; theme?: Record<number, string>;
  gateName?: string; gtSuggestions?: string[];
}
export interface Requirement { id: string; key: string; title: string; theme: string; st: ReqStatus; owner: PersonId;
  doc: string; freq: FreqId; note: string; gate: boolean; just: string; risks: string[]; by?: PersonId|null; due?: IsoDate|null }
export interface Document { id: string; title: string; tier: string; ver: string; st: DocStatus; appr: IsoDate|''; rev: IsoDate;
  owner: PersonId; shared: boolean; ms: MsId; approver?: PersonId; path?: string; hashAlg?: string; usedBy?: string[] }
export interface Evidence { code: string; ctrl: string; ctrlKey: string; title: string; freq: FreqId; p: number; prod: IsoDate;
  next: IsoDate|null; fresh: Fresh; integ: IntegId; loc: string; owner: PersonId; ver: string; hashAlg: string; path: string;
  hash?: string; lastCheck?: string; lastGoodCheck?: string }
export interface ChainItem { key: RecordKey; stage: string; kind: 'req'|'soa'|'doc'|'ev'|'x'; id: string; title: string; act: string;
  h: PersonId; due: IsoDate|null; st: ItemStatus; after: boolean; gate: boolean; up: string[]; down: string[]; q: string;
  ref?: Requirement|Document|Evidence;              // rehydrated by the source, never sent as an object
  refKey?: RecordKey }                               // wire form of ref
export interface GateItem { id: string; type: string; why: string; h: PersonId; due: IsoDate|null; key: string }
export interface Activity { key: RecordKey; no: string; title: string; st: ActStatus; blocker: string|null; owner: PersonId;
  out: string|null; doc: Document|null; date: IsoDate|null; pno: number; by?: PersonId|null }
export interface Phase { no: number; n: string; gate: boolean; acts: Activity[]; total: number;
  c: Record<'verified'|'complete'|'progress'|'blocked'|'ns'|'locked', number> }
export interface Stage { id: string; l: Pair; q: string; rec?: number; src?: 'req'|'soa'|'doc'|'ev' }
export interface XRecord { id: string; t: string; act: string; h: PersonId; due: IsoDate|null; gate?: boolean; up?: string[]; down?: string[] }

export interface MsBundle {                          // derived per system; S values from section 2
  reqs: Requirement[]; docs: Document[]; evs: Evidence[];
  chain: { items: ChainItem[]; recs: Record<string, number> };
  gates: GateItem[];
  phases: Phase[];
}

export interface Snapshot {                          // same keys the controller reads as this.D today
  today: IsoDate;                                    // replaces TODAY_S; date helpers are bound to it
  generatedAt: string;
  orgs: Organisation[];
  MS: ManagementSystem[];
  PEOPLE: Record<PersonId, [string, string]>;
  ROLES: Record<string, { who: PersonId; label: Pair }>;
  LOC: Record<string, [string, string, string, string, string]>;   // [1] is the adapter kind: sp, od, gd, vault, smb
  INTEG: Record<IntegId, [string, string, 'ok'|'warn'|'bad']>;
  FREQ: Record<FreqId, [string, string, number]>; FREQ_ORDER: FreqId[];
  STAGES: Record<MsId, Stage[]>; X: Record<MsId, Record<string, XRecord[]>>;
  CHAINS: Record<MsId, { id: string; nodes: [string, string|null][] }[]>;
  TITLES: Record<string, string>; CLAUSE_AT_RISK: Record<string, string>; EXAMPLES: Record<string, string>;
  EVENTS: Record<MsId, { t: string; d: IsoDate; days: number; result?: string; next?: boolean }[]>;
  FOCUS: Record<MsId, string>;
  PREP: Record<MsId, [string, PersonId, IsoDate, 'done'|'progress'|'open'][]>;
  PAST: Record<MsId, [string, 'Minor'|'Major'|'OFI', string, string, 'open'|'closed', string][]>;
  CYCLE_ITEMS: Record<MsId, [string, string, PersonId, IsoDate, 'done'|'progress'|'open', string][]>;
  DRIFT: Record<MsId, { id: string; l: Pair; rows?: [string, string, PersonId, IsoDate][]; src?: 'unverif'|'metric'|'exercise'|'nohash' }[]>;
  PACKS: Record<MsId, { v: string; installed: string; eds: string; update: string|null; status?: 'current'|'transition'|'beta' }>;
  LICENCE: { org: string; to: string; fw: string; ms: string; users: string; adapters: string; features: string[]; sig: string };
  REPOS: { id: string; name: string; type: string; modes: string; status: 'ok'|'bad'|'warn'; msg?: Pair; tenant: string; ms: string[]; last: string;
           actions?: ('reauthorise'|'moveToLibrary')[] }[];
  ROUTING: [string, string, string, string][];
  bundles: Record<MsId, MsBundle>;                   // every system of the selected organisation
}

export interface PickerListing {                     // same shape as PICKER_FILES[src], plus refs
  path: string;
  files: [string, string, string, string, string][]; // name, date label, version, hash algorithm, modified by
  refs: { repositoryId: string; externalItemId: string; externalVersionId?: string }[];
}

export interface CommandResult {
  ok: boolean;
  changed: MsId[];                                   // bundles to reload; empty when nothing changed
  count?: number;                                    // reminders sent, references checked
  message?: Pair;                                    // server text when the UI cannot compose it
  warnings?: { rule: string; message: Pair }[];      // BR-23, BR-30, BR-36, BR-41
  error?: { status: number; rule?: string; message: Pair };   // RFC 9457 problem mapped
  redirectUrl?: string;                              // re-authorise consent
  downloadUrl?: string;                              // exports and evidence packs
}

export interface DataSource {
  readonly kind: 'sample' | 'api';
  load(orgId?: string): Promise<Snapshot>;
  reload(snapshot: Snapshot, msIds: MsId[]): Promise<Snapshot>;
  listPickerFiles(key: RecordKey, src: 'sp'|'gd'): Promise<PickerListing>;

  markComplete(key: RecordKey): Promise<CommandResult>;                          // req, act
  verify(key: RecordKey, to: 'implemented'|'verified'): Promise<CommandResult>;   // req, act
  assign(key: RecordKey, h: PersonId, due: IsoDate|null): Promise<CommandResult>; // reassign and change due
  remind(key: RecordKey, recipient: PersonId): Promise<CommandResult>;
  remindAll(msId: MsId): Promise<CommandResult>;
  completeRecordAction(key: RecordKey): Promise<CommandResult>;                  // My Tasks, kind x
  startReview(key: RecordKey): Promise<CommandResult>;                           // doc
  recordBlocker(key: RecordKey, gateRef: string, reason: string): Promise<CommandResult>;
  linkFile(key: RecordKey, file: { src: 'sp'|'gd'; index: number; ref?: PickerListing['refs'][number] }): Promise<CommandResult>;
  uploadFile(key: RecordKey, file: File | null): Promise<CommandResult>;        // null in sample mode
  repositoryAction(repoId: string, action: 'test'|'reauthorise'|'moveToLibrary'): Promise<CommandResult>;
  pageAction(msId: MsId, action: 'exportBoard'|'exportReadiness'|'exportSoa'|'exportDocs'|'evidencePack'|'auditorAccess'
             |'runCheck'|'calendarFeed'|'checkUpdates'|'importBundle'|'verifyPhase', arg?: unknown): Promise<CommandResult>;
}
```

### 4.3 Wire rules

- Business ids (`A.5.23`, `PRC-07`, `EV-0313`, `R-031`) are returned as `id` or `code`; the API also returns `ref: {module, entity_type, id}` (UUID) on every record (ARCHITECTURE 13). The API source keeps a `RecordKey` to `ref` map from the last load and sends `ref` in commands.
- `ChainItem.ref` and `Activity.doc` travel as keys (`refKey`, document id). The source rehydrates them to the objects in `reqs`, `docs` and `evs` of the same bundle, so `it.ref.st`, `it.ref.ver` and `a.doc.st` work unchanged.
- Labels that are `Pair` on the client may arrive as one string in the user's language from the API; the source wraps them as `[s, s]`.
- `today` is the organisation's local date from the server. `dd`, `fmt`, `addD`, `P` and `iso` come from a client module bound to `snapshot.today`.
- All lists are complete per system for the parity phase (ISMS: 93 requirements, 79 evidence, 22 documents, 63 chain items). Paginated per-screen endpoints replace this when volumes need it (TS 9.5, 200 rows per page).

### 4.4 Sample implementation

- `load()` returns the module data plus `today = TODAY_S`, `orgs` (today's `ORGS`), and `bundles` computed by `sample-derive.js` (`data`, `chain`, `gateItems`, `phases`, `findX`, moved from the controller unchanged).
- Commands apply exactly the override patches of section 3 to its own `ov` store and return `{ok: true, changed: [msId]}`. `remindAll` returns `count` = distinct non-`none` holders. `pageAction('runCheck')` returns `count` = evidence of the system.
- Commands return already-resolved promises, so the Playwright suite sees the same timing as today's synchronous `setState`.

### 4.5 API implementation

| Snapshot or command | Parity endpoint (prefix `/api/v1`) | Later per-screen source (TS 9.2) |
|---|---|---|
| `today`, deploy flags | `GET /system/profile` | Same |
| `orgs`, `ROLES`, current user | `GET /me` | Same |
| `MS`, `PEOPLE`, `LOC`, `REPOS`, `ROUTING`, `PACKS`, `LICENCE`, `STAGES`, `CHAINS`, `TITLES`, `CLAUSE_AT_RISK`, `EXAMPLES` | `GET /ui/org` | `/license`, `/admin/packs`, `/admin/storage/repositories`, pack labels |
| `bundles[ms]`, `X`, `EVENTS`, `FOCUS`, `PREP`, `PAST`, `CYCLE_ITEMS`, `DRIFT` | `GET /ui/ms/{ms}` | `/implementation/summary`, `/applicability`, `/documents`, `/evidence`, `/gates`, `/phases/{n}/activities`, `/audit/stages`, `/audit/stages/{key}/records`, `/audit/event/next`, `/surveillance/events/{id}`, `/surveillance/cycle`, `/surveillance/drift` |
| `listPickerFiles` | `GET /storage/repositories/{id}/browse?path=` | Browser pickers |
| `markComplete`, `verify` | `POST /ms/{ms}/applicability/{id}/transitions`, `POST /ms/{ms}/activities/{id}/transitions` | Same |
| `assign` | `POST /ms/{ms}/records/{entity_type}/{id}/assignment` | Same |
| `remind`, `remindAll` | `POST /reminders`, `POST /reminders/bulk` | Same |
| `completeRecordAction` | `POST /ms/{ms}/records/{entity_type}/{id}/complete-action` | Entity-specific forms |
| `startReview` | `POST /ms/{ms}/documents/{id}/transitions` | Same |
| `recordBlocker` | `POST /ms/{ms}/activities/{id}/transitions` | Same |
| `linkFile` | `POST /ms/{ms}/evidence/{id}/files`, `POST /ms/{ms}/documents/{id}/versions` | Same |
| `uploadFile` | `POST /storage/upload-intents`, then the evidence or version command | Same |
| `repositoryAction` | `POST /admin/storage/repositories/{id}/test`, `/reauthorize`, `/move-requests` | Same |
| `pageAction` | Endpoints listed in 3.6 | Same |

`GET /ui/org` and `GET /ui/ms/{ms}` are assembled server-side from the read-model functions, so the numbers match the per-screen endpoints (TS 9.6). They are the parity contract; the snapshot test in 4.7 runs against them.

### 4.6 Controller changes

1. `componentDidMount`: `ds.load()` and store the snapshot as `D` (merged with `T`, `TERA` and the bound date helpers).
2. `ORGS` reads `D.orgs`; `setOrg` calls `ds.load(orgId)`.
3. `data(ms)` returns `{ms, ...D.bundles[ms.id]}`; `chain(d)` returns `d.chain`; `gateItems(d)` returns `d.gates`; `phases(d)` returns `d.phases`.
4. Each `ovSet` call site becomes the matching command; after it resolves, `ds.reload(D, result.changed)`, then the same toast as today. On `error`, toast `li(error.message)`; append `warnings` to the toast.
5. `openPicker` tests `D.LOC[ms.loc][1]` (adapter kind) instead of `ms.loc`; in API mode it awaits `listPickerFiles` and stores the listing in `modal.listing`; `modalVals` reads `m.listing` or `D.PICKER_FILES[m.src]`.
6. The upload confirm opens a hidden `<input type="file">` from the controller in API mode and passes the file to `uploadFile`; `Modals.jsx` stays unchanged.
7. Hard-coded switches read the optional fields of 2.14 and fall back to today's literals, so sample mode renders identically.
8. Toasts that embed counts use `result.count` when present.

### 4.7 Parity tests

- A seed script converts the sample (including the fabricated values of 2.15) into database rows for one organisation.
- Snapshot test: `SampleDataSource.load()` and `ApiDataSource.load()` against the seeded server must produce equal JSON for `MS` and every `bundles[ms]` (after rehydration keys are stripped), and equal nav counts.
- Command test: for each action in section 3, apply it in both sources and compare the reloaded bundles.
- The Playwright suite runs once per source.

Reference numbers from the sample (role `manager` unless stated):

| System | Requirements | Evidence | Documents | Chain items | Not pending | Gate items | Critical evidence |
|---|---|---|---|---|---|---|---|
| ISMS | 93 | 79 | 22 | 63 | 24 | 4 | 3 |
| QMS | 28 | 27 | 10 | 18 | 5 | 0 | 0 |
| BCMS | 27 | 11 | 8 | 25 | 2 | 3 | 0 |
| ABMS | 32 | 2 | 5 | 35 | 3 | 1 | 0 |

My Tasks across all four systems: `rina` 3, `bagus` 31, `maya` 1, `hendra` 3.

## 5. Contract gaps and decisions

| # | Gap | Recommendation |
|---|---|---|
| 5.1 | The UI has a requirement status `complete` (awaiting verification). TS 6.1 has no such state for `applicability_entry` | Add `complete` between the working states and `implemented`, with `completed_by_user_id` and `completed_at`; MS Manager verifies |
| 5.2 | The UI has a requirement status `blocked`; TS 6.1 has none | Derive `blocked` in the read model for entries holding the gate (BR-02 for ISO 27001 and ISO 37001, gate requirements for others); never store it |
| 5.3 | The UI counts `moved` and `changed` as unverifiable; TS 6.4 counts `moved` and `version_changed` as valid, and BR-32 says not to downgrade | Decide before Phase 5. If TS wins, add `Evidence.valid` and have the controller's `bad` predicate read it when present; the sample sets it false for `changed` and `moved` |
| 5.4 | Verification checks differ: UI blocks the completer; TS 6.6 requires `verified_by` to differ from the owner; the modal text also requires a different date | Enforce all three on the server; return 422 with the rule id |
| 5.5 | The UI lets Internal Auditors verify | TS says MS Manager; keep auditors read-only unless the PRD owner decides otherwise |
| 5.6 | The UI shows pending per person to Internal Auditors | TS 7.5 says no; the view also needs HR sign-off |
| 5.7 | Uploading a new document version marks it approved immediately with a new review date | Create the version in review (approval separate, TS 7.1, BR-16); the controller shows `result.message` instead of `approved` |
| 5.8 | Documents in review have no approve action; drafts have no editor | Add an approval command and a review entry point |
| 5.9 | Record blocker, Add control, New document, Connect repository, Add audit event and Settings only show toasts | Commands exist (3.2, 3.6); forms are later UI work |
| 5.10 | The vault upload modal has no file input | Controller-owned hidden file input (4.6) |
| 5.11 | `gateItems` ignores overrides, so a reassigned gate record keeps its old holder in the gate tab | The server derives gate items from current state |
| 5.12 | The UI allows `ns` to `complete` directly; TS 6.6 requires `in_progress` first | Server performs both transitions in one command, or the UI shows Start first |
| 5.13 | Critical evidence and unverifiable evidence are separate counts (nav badge and portfolio `evCrit`: critical only; portfolio `evBad` and freshness tab `cannot`: unverifiable). Evidence can be in both | One named server function per count (TS 9.6), returned as `criticalEvidence` and `unverifiableEvidence` in the summary |
| 5.14 | Clause readiness and the four maturity dimensions have no defined source | Define the per-clause computation in the read model (PRD 7.2) |
| 5.15 | Past-event findings list every finding of the system; drift `metric` and `exercise` list every record | Findings per `audit_event`; drift rows from `drift_result` predicates only |
| 5.16 | One global role in the UI; roles are per system in the TS | Session returns the role per system; the controller uses the role of the selected system |
| 5.17 | Requirement chain due dates, activity owners and dates, and stage record counts are fabricated | Store a due date on the pending action of each record; store activity owners and dates; count records per stage |
| 5.18 | Overrides are not scoped by organisation in the sample | No effect on the API, which is tenant scoped |
| 5.19 | The tasks greeting uses the browser clock while dates use `today` | Use the organisation time zone for both |

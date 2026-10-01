# risk-registers module

Context issues, interested parties, assets, risks, treatments, residual acceptance, metrics, operating criteria, evidence records and entity links (build plan D.3 "Registers and workflows: risk side").

Owner: WP-36; skeleton by WP-03 (build plan B.4).

| File | Content |
|---|---|
| `registers.service.ts` | `GET`, `POST` and `PATCH /ms/{ms}/registers/{register}` for the five register kinds (lists through `ScopePolicy`, lookups and risk profile scales of the edition, `entity_ms_link` rows with one primary, BR-17, BR-22 confirmation, `integrated_mode` for a second system) and `POST /ms/{ms}/metrics/{id}/values` |
| `treatments.service.ts` | Treatments of a risk, their changes, the C.13 `risk_treatment.status` machine and residual acceptance by the risk's owner (BR-04, implementer snapshot) |
| `evidence.service.ts` | Evidence records, their changes (BR-22, `freshness.recompute`), targets in other systems (`integrated_mode`, BR-23 warning) and target removal |
| `entity-links.service.ts` | Linking a shareable record to a system, moving the primary system and removing a link (A-29) |
| `operating-criteria.service.ts` | `PUT /ms/{ms}/applicability/{id}/operating-criteria` (enqueues `freshness.recompute`) |
| `rules.ts` | `@BusinessRule` providers of BR-04, BR-17 and BR-23; `confirmShared` for BR-22 (whose provider WP-35 registers) |
| `support.ts` | Shared steps: C.13 row choice, record refs, `updated_at` bump, links of shareable records, edition lookups, the freshness job |

Chain records stay meaningful for the read model: a new risk waits for a treatment, a new metric for its first value, each treatment status carries its own pending action (none once implemented), an implemented treatment hands the risk the residual acceptance action, and an acceptance clears it when no other implemented treatment waits.

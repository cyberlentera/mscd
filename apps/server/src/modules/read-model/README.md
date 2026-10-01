# read-model module

Derivation functions of the read model, one per concept (build plan E.3, G.5), and the assembly of the UI parity
snapshots (D-05).

- `derive/`: pure functions. `freshness.ts` (E.3, including `entryEvidenceState`, used by the commands and jobs),
  `integrity.ts` (C.12, A-05), `requirements.ts`, `documents.ts`, `evidence.ts`, `chain.ts` (D-12), `gates.ts`
  (A-27), `phases.ts` (D-13), `overview.ts` (UI 2.6 maturity), `portfolio.ts` (UI 2.8 counts), `tasks.ts` (D-29),
  `drift.ts` (G.5 `DRIFT` and the predicates of `drift.evaluate`), `ms-fields.ts`, `org-formats.ts` (G.5 text
  formats), `audit.ts`, `refs.ts`.
- `load/loader.ts`: the rows of one or every system in a fixed number of queries (no N+1).
- `build/`: the system snapshot (`GET /ui/ms/{ms}`) and the organisation snapshot (`GET /ui/org`) on the full data.
- `read-model.service.ts`: `ReadModelService`, which applies `ScopePolicyService` (F.7) after deriving.

Owner: WP-17; skeleton by WP-03 (build plan B.4).

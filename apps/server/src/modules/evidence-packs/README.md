# evidence-packs module

Evidence pack builds, manifests and downloads (build plan E.7, D-34, F.13). Owner: WP-26.

- `POST /ms/{ms}/evidence-packs` (`evidence_pack.build`): a queued pack and its background task; the job
  `evidence-pack.build` copies the intact and moved files of the system's evidence of the current cycle into
  `<root>/_packs/<MS code>/<event label or date>/` of their repositories (gateway `ensure-folder`, `copy-within`),
  lists everything else as exceptions with the reason, writes the CSV and PDF manifests (and, in the Managed Vault,
  a `.tar.gz` archive) and records every copy, manifest and archive as a storage object.
- `GET /ms/{ms}/evidence-packs` and `/{id}` (`ms.read`): external auditors see ready packs of their system only.
- `GET /ms/{ms}/evidence-packs/{id}/download?file=manifest_pdf|manifest_csv|archive`: through `FileResponder`,
  audited `evidence_pack.downloaded`. Pack copies are the only files external auditors can open (files module,
  `ScopePolicy.canReadObject`).

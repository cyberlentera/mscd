# registers module

Commands of D.3 owned by WP-35, except reminders (module `reminders`):

| Route | Service |
|---|---|
| `POST /ms/{ms}/records/{entityType}/{id}/assignment` | `RecordCommandsService.assign`: holder and due columns by `AssignmentRequest.kind` (K.2 WP-35 table), 422 when the kind does not fit the entity type, BR-43 for preparation tasks, warnings BR-41 and BR-17 |
| `POST /ms/{ms}/records/{entityType}/{id}/complete-action` | `RecordCommandsService.completeAction`: clears `pending_action` of a chain record (or resolves a drift row); 409 without an open action |
| `POST /ms/{ms}/records/{entityType}/{id}/delete` | `RecordCommandsService.softDelete`: `deleted_at` with the reason in `record.deleted`; BR-22 confirmation for shared entities; 422 with open dependants |
| `POST /tasks/{id}/complete` | `RecordCommandsService.completeTask`: the owner closes an open stored task (D-29) |
| `POST /ms/{ms}/documents`, `PATCH /ms/{ms}/documents/{id}`, `POST /ms/{ms}/documents/{id}/transitions` | `DocumentCommandsService`: register, edit (BR-22), review, approve (BR-16; the version in review becomes current, the earlier one superseded) and return to draft |
| `POST /ms/{ms}/audit-events`, `PATCH /ms/{ms}/audit-events/{id}` | `AuditEventCommandsService`: plan and change events; a date change flags preparation tasks (A-26) and notifies holders whose items now fall after the audit (BR-42) |
| `POST /ms/{ms}/audit-events/{id}/prep-tasks`, `PATCH /ms/{ms}/prep-tasks/{id}`, `PATCH /ms/{ms}/cycle-items/{id}` | `AuditEventCommandsService`: preparation tasks (BR-43) and cycle items, status through C.13 |

Rules registered here: BR-16, BR-22, BR-41 (warning), BR-42 (flag), BR-43 (`register.rules.ts`). Other modules call
BR-22 through the exported `SharedChangeGuard` and never register it again.

Owner: WP-35 (build plan B.4).

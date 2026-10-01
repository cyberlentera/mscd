// Routes of the register, document, audit event and task commands (D.3 "Commands from the UI", WP-35): the
// `records`, `documents` and `audit-events` areas of the shared route table.
import { Controller } from '@nestjs/common';
import {
  auditEventsCreateRoute,
  auditEventsUpdateRoute,
  cycleItemsUpdateRoute,
  documentsCreateRoute,
  documentsTransitionRoute,
  documentsUpdateRoute,
  prepTasksCreateRoute,
  prepTasksUpdateRoute,
  recordsAssignRoute,
  recordsCompleteActionRoute,
  recordsDeleteRoute,
  tasksCompleteRoute,
  type AssignmentRequest,
  type AuditEventCreateRequest,
  type AuditEventPatch,
  type CommandResult,
  type CompleteActionRequest,
  type CycleItemPatch,
  type DocumentCreateRequest,
  type DocumentPatch,
  type DocumentTransitionRequest,
  type PrepTaskCreate,
  type PrepTaskPatch,
  type RecordParams,
  type SoftDeleteRequest,
} from '@mscd/shared';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, IfMatchHeader, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { AuthzState, Principal } from '../../common/tokens';
import { AuditEventCommandsService } from './audit-events.service';
import { DocumentCommandsService } from './documents.service';
import { RecordCommandsService } from './records.service';

type MsId = { ms: string; id: string };

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class RegistersController {
  constructor(
    private readonly records: RecordCommandsService,
    private readonly documents: DocumentCommandsService,
    private readonly events: AuditEventCommandsService,
  ) {}

  // Records -------------------------------------------------------------------------------------------------------

  @ApiRoute(recordsAssignRoute)
  assign(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: RecordParams,
    @RouteInputParam('body') body: AssignmentRequest,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.records.assign(required(principal), params.ms, params.entityType, params.id, body, ifMatch);
  }

  @ApiRoute(recordsCompleteActionRoute)
  completeAction(
    @CurrentPrincipal() principal: Principal | null,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: RecordParams,
    @RouteInputParam('body') body: CompleteActionRequest,
  ): Promise<CommandResult> {
    return this.records.completeAction(required(principal), authz, params.ms, params.entityType, params.id, body ?? {});
  }

  @ApiRoute(recordsDeleteRoute)
  softDelete(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: RecordParams,
    @RouteInputParam('body') body: SoftDeleteRequest,
  ): Promise<CommandResult> {
    return this.records.softDelete(required(principal), params.ms, params.entityType, params.id, body);
  }

  @ApiRoute(tasksCompleteRoute)
  completeTask(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { id: string },
    @RouteInputParam('body') body: CompleteActionRequest,
  ): Promise<CommandResult> {
    return this.records.completeTask(required(principal), params.id, body ?? {});
  }

  // Documents -----------------------------------------------------------------------------------------------------

  @ApiRoute(documentsTransitionRoute)
  transitionDocument(
    @CurrentPrincipal() principal: Principal | null,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsId,
    @RouteInputParam('body') body: DocumentTransitionRequest,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.documents.transition(required(principal), authz, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(documentsCreateRoute)
  createDocument(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: DocumentCreateRequest,
  ): Promise<CommandResult> {
    return this.documents.create(required(principal), params.ms, body);
  }

  @ApiRoute(documentsUpdateRoute)
  updateDocument(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsId,
    @RouteInputParam('body') body: DocumentPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.documents.update(required(principal), params.ms, params.id, body, ifMatch);
  }

  // Audit events, preparation tasks and cycle items ---------------------------------------------------------------

  @ApiRoute(auditEventsCreateRoute)
  createAuditEvent(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: { ms: string },
    @RouteInputParam('body') body: AuditEventCreateRequest,
  ): Promise<CommandResult> {
    return this.events.createEvent(required(principal), params.ms, body);
  }

  @ApiRoute(auditEventsUpdateRoute)
  updateAuditEvent(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsId,
    @RouteInputParam('body') body: AuditEventPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.events.updateEvent(required(principal), params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(prepTasksCreateRoute)
  createPrepTask(
    @CurrentPrincipal() principal: Principal | null,
    @RouteInputParam('params') params: MsId,
    @RouteInputParam('body') body: PrepTaskCreate,
  ): Promise<CommandResult> {
    return this.events.createPrepTask(required(principal), params.ms, params.id, body);
  }

  @ApiRoute(prepTasksUpdateRoute)
  updatePrepTask(
    @CurrentPrincipal() principal: Principal | null,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsId,
    @RouteInputParam('body') body: PrepTaskPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.events.updatePrepTask(required(principal), authz, params.ms, params.id, body, ifMatch);
  }

  @ApiRoute(cycleItemsUpdateRoute)
  updateCycleItem(
    @CurrentPrincipal() principal: Principal | null,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsId,
    @RouteInputParam('body') body: CycleItemPatch,
    @IfMatchHeader() ifMatch: string | undefined,
  ): Promise<CommandResult> {
    return this.events.updateCycleItem(required(principal), authz, params.ms, params.id, body, ifMatch);
  }
}

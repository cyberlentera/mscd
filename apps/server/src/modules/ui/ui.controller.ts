// `GET /ui/org`, `GET /ui/ms/{ms}` and `GET /tasks` (build plan D.3 "UI parity reads", D-05, G.5, D-29).
import { Controller } from '@nestjs/common';
import { uiMsRoute, uiOrgRoute, uiTasksRoute, type TaskList, type UiMsSnapshot, type UiOrgSnapshot } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { ReadModelService } from '../read-model/read-model.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class UiController {
  constructor(private readonly readModel: ReadModelService) {}

  @ApiRoute(uiOrgRoute)
  org(@CurrentPrincipal() principal: Principal | null): Promise<UiOrgSnapshot> {
    return this.readModel.orgSnapshot(required(principal));
  }

  @ApiRoute(uiMsRoute)
  ms(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('params') params: { ms: string }): Promise<UiMsSnapshot> {
    return this.readModel.msSnapshot(required(principal), params.ms);
  }

  @ApiRoute(uiTasksRoute)
  tasks(@CurrentPrincipal() principal: Principal | null): Promise<TaskList> {
    return this.readModel.tasks(required(principal));
  }
}

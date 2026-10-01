// Routes of the reminder commands (D.3, E.5, WP-35): `POST /reminders` and `POST /reminders/bulk`. The system comes
// from the body (`msSource: 'body'`); the guard checks `reminder.send` there.
import { Controller } from '@nestjs/common';
import {
  remindersBulkRoute, remindersSendRoute, type BulkReminderRequest, type BulkReminderResult, type CommandResult, type ReminderRequest,
} from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import { UnauthenticatedError } from '../../common/problems';
import type { Principal } from '../../common/tokens';
import { RemindersService } from './reminders.service';

function required(principal: Principal | null): Principal {
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

@Controller()
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @ApiRoute(remindersSendRoute)
  send(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: ReminderRequest): Promise<CommandResult> {
    return this.reminders.send(required(principal), body);
  }

  @ApiRoute(remindersBulkRoute)
  bulk(@CurrentPrincipal() principal: Principal | null, @RouteInputParam('body') body: BulkReminderRequest): Promise<BulkReminderResult> {
    return this.reminders.bulk(required(principal), body);
  }
}

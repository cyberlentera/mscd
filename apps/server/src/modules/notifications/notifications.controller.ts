// Routes of D.3 owned by WP-24 for in-app notifications (E.6).
import { Controller } from '@nestjs/common';
import { notificationsListRoute, notificationsReadRoute, type IdParams, type Notification, type NotificationsQuery, type Page } from '@mscd/shared';
import { ApiRoute, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { Principal } from '../../common/tokens';
import { NotificationsService } from './notifications.service';

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiRoute(notificationsListRoute)
  list(@CurrentPrincipal() principal: Principal, @RouteInputParam('query') query: NotificationsQuery): Promise<Page<Notification>> {
    return this.notifications.list(principal, query);
  }

  @ApiRoute(notificationsReadRoute)
  async read(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams): Promise<void> {
    await this.notifications.markRead(principal, params.id);
  }
}

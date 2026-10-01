// Default provider of SESSION_RESOLVER (build plan B.4, WP-08): it authenticates nobody, so every route that needs a
// session answers 401 until WP-11 registers the real resolver (cookie, `platform.session`, F.7 session resolution).
import { Injectable } from '@nestjs/common';
import type { Principal, SessionResolver } from '../../common/tokens';

@Injectable()
export class NoSessionResolver implements SessionResolver {
  async resolve(): Promise<Principal | null> {
    return null;
  }
}

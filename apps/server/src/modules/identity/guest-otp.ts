// Extension point for the guest one-time code step (build plan F.14, D.3 `auth: 'guest_otp'`). The routes of that
// step have no session yet: the caller is identified by the guest binding cookie of an `auth_transaction`. The
// guest access work (WP-26, `identity/guest`) registers its resolver here at start; until then such routes answer
// 401, because nobody is resolved.
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../common/tokens';

export interface GuestOtpResolver {
  /** The guest of the request's binding cookie (`Principal.guestTransactionId` set, `session` null), or null. */
  resolve(request: FastifyRequest): Promise<Principal | null>;
}

@Injectable()
export class GuestOtpResolverRegistry {
  private resolver: GuestOtpResolver | null = null;

  /** Registers the resolver of the guest binding cookie; a second registration replaces the first. */
  register(resolver: GuestOtpResolver): void {
    this.resolver = resolver;
  }

  async resolve(request: FastifyRequest): Promise<Principal | null> {
    return this.resolver ? this.resolver.resolve(request) : null;
  }
}

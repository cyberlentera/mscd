// Starters of identity linking per provider kind (build plan D.3 `POST /me/identities/{slug}/link`, F.8, F.9). The
// route is served by the OIDC controller, which checks the provider, the user's membership in its organisation and
// the recent proof of the session, then hands over to the starter of the provider's kind: OIDC (this folder) and
// SAML (identity/saml, WP-19, which registers its starter here in `onModuleInit`).
import { Injectable } from '@nestjs/common';
import type { IdentityLinkStart, IdentityProviderKind } from '@mscd/shared';
import type { FastifyReply } from 'fastify';
import type { CurrentSession } from '../session.service';

/** The provider a link starts with: enabled, of an organisation where the user is an active member. */
export interface LinkableProvider {
  id: string;
  slug: string;
  kind: IdentityProviderKind;
  organizationId: string;
}

export interface IdentityLinkStarter {
  /**
   * Opens a link transaction (`oidc_link` or `saml_link`, with the session user) and its browser binding cookie on
   * `reply`, and returns the URL the browser follows to the identity provider.
   */
  start(current: CurrentSession, provider: LinkableProvider, reply: FastifyReply): Promise<IdentityLinkStart>;
}

@Injectable()
export class IdentityLinkRegistry {
  private readonly starters = new Map<IdentityProviderKind, IdentityLinkStarter>();

  /** Registers the starter of a provider kind; a second registration for the same kind is a programming error. */
  register(kind: IdentityProviderKind, starter: IdentityLinkStarter): void {
    if (this.starters.has(kind)) throw new Error(`An identity link starter for ${kind} providers is already registered`);
    this.starters.set(kind, starter);
  }

  /** The starter of a kind, or null when no module of this application links that kind. */
  starterFor(kind: IdentityProviderKind): IdentityLinkStarter | null {
    return this.starters.get(kind) ?? null;
  }
}

// Rules of OIDC sign-in that need no database (build plan F.8 steps 3 and 6, F.5): the subject of a token, the
// verified email, the MFA proof of the `amr` claim, and the outcome codes the login page shows.
import type { LoginErrorCode } from '@mscd/shared';

/** Claims of a validated ID token as the rules read them. */
export type IdTokenClaims = Readonly<Record<string, unknown>>;

/** The provider settings the rules use (`platform.identity_provider`). */
export interface ProviderRuleSettings {
  subject_mode: 'sub' | 'entra';
  entra_tenant_id: string | null;
  require_mfa_claim: boolean;
  accepted_amr: readonly string[];
  mfa_fallback: 'local_totp' | 'reject';
}

/** `user_identity.subject` is varchar(255). */
export const SUBJECT_MAX_LENGTH = 255;

/** A sign-in that cannot continue, with the code of `/login?error=<code>` (F.8 step 6). */
export class SsoFailure extends Error {
  constructor(
    readonly code: LoginErrorCode,
    /** Reason for the audit trail and the log (never shown to the user). */
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'SsoFailure';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The subject of a token (F.8 step 3): `sub`, or for `subject_mode = 'entra'` the pair `<tid>:<oid>` (lower case),
 * where `tid` must equal the provider's `entra_tenant_id`. Anything else is `idp_error`.
 */
export function subjectOf(claims: IdTokenClaims, provider: Pick<ProviderRuleSettings, 'subject_mode' | 'entra_tenant_id'>): string {
  if (provider.subject_mode === 'entra') {
    const tid = claims.tid;
    const oid = claims.oid;
    if (typeof tid !== 'string' || typeof oid !== 'string' || !UUID.test(tid) || !UUID.test(oid)) {
      throw new SsoFailure('idp_error', 'entra_claims_missing');
    }
    if (!provider.entra_tenant_id || tid.toLowerCase() !== provider.entra_tenant_id.toLowerCase()) {
      throw new SsoFailure('idp_error', 'entra_tenant_mismatch');
    }
    return `${tid.toLowerCase()}:${oid.toLowerCase()}`;
  }
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > SUBJECT_MAX_LENGTH) throw new SsoFailure('idp_error', 'subject_invalid');
  return sub;
}

/**
 * The email of a token, lower-cased, only when the token has `email` and `email_verified === true` (F.8 step 3:
 * absent counts as unverified, so Entra ID tokens never qualify). Null otherwise.
 */
export function verifiedEmailOf(claims: IdTokenClaims): string | null {
  const email = claims.email;
  if (claims.email_verified !== true || typeof email !== 'string') return null;
  const normalised = email.trim().toLowerCase();
  if (normalised.length === 0 || normalised.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) return null;
  return normalised;
}

/** The domain of an email (after the last `@`), lower case. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** The `amr` claim as a list of distinct strings (anything else counts as no claim). */
export function amrOf(claims: IdTokenClaims): string[] {
  const amr = claims.amr;
  if (!Array.isArray(amr)) return [];
  const values = amr.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40);
  return [...new Set(values)].slice(0, 20);
}

/**
 * True when the `amr` claim proves multi-factor authentication (F.5): it contains `mfa`, or at least two distinct
 * values that are both in the provider's `accepted_amr`. `['otp']` alone is not proof; neither are two values of which
 * one is not accepted.
 */
export function amrProvesMfa(amr: readonly string[], acceptedAmr: readonly string[]): boolean {
  const values = new Set(amr);
  if (values.has('mfa')) return true;
  const accepted = new Set(acceptedAmr);
  let count = 0;
  for (const value of values) if (accepted.has(value)) count += 1;
  return count >= 2;
}

/** What the second factor of an OIDC sign-in is (F.5). */
export type SsoMfaDecision =
  /** The identity provider proved MFA: the session is active at once. */
  | { kind: 'idp' }
  /** No proof: continue with the local TOTP step (`mfa_pending`, or `mfa_enrolment` without a factor). */
  | { kind: 'local_totp' }
  /** No proof and the provider rejects such sign-ins (`mfa_required_by_policy`). */
  | { kind: 'reject' };

/**
 * F.5 for OIDC: with `require_mfa_claim` the `amr` claim is evaluated; without it the claim is ignored and the local
 * TOTP step always follows (the profile schema allows `require_mfa_claim = false` only with `local_totp`). Without a
 * proof `mfa_fallback` decides.
 */
export function decideSsoMfa(amr: readonly string[], provider: Pick<ProviderRuleSettings, 'require_mfa_claim' | 'accepted_amr' | 'mfa_fallback'>): SsoMfaDecision {
  if (provider.require_mfa_claim && amrProvesMfa(amr, provider.accepted_amr)) return { kind: 'idp' };
  if (provider.mfa_fallback === 'reject') return { kind: 'reject' };
  return { kind: 'local_totp' };
}

/**
 * A return path that stays inside the application (F.8 step 1: relative path only). The start query schema already
 * refuses others; this is the last check before a redirect.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /\s/.test(value)) return '/';
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) < 0x20 || value.charCodeAt(i) === 0x7f) return '/';
  return value;
}

/** `/login?error=<code>` (F.8 step 6). */
export function loginErrorPath(code: LoginErrorCode): string {
  return `/login?error=${encodeURIComponent(code)}`;
}

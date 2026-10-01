// Rules of SAML sign-in that need no database (build plan F.9, F.5): what a signature-checked assertion says (its
// id, subject, issuer, validity, the request it answers and the authentication context), the checks on those facts,
// and the MFA decision from `AuthnContextClassRef`. The XML signature, the timestamps of `Conditions` and the audience
// are checked by `@node-saml/node-saml` before these rules see the assertion.
import { SsoFailure, SUBJECT_MAX_LENGTH, type SsoMfaDecision } from '../oidc/oidc-rules';

/** The only NameID format accepted as subject (F.9). */
export const PERSISTENT_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
/** Subject confirmation method of browser SSO. */
export const BEARER_METHOD = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
/** Accepted clock skew between the identity provider and this server (F.9). */
export const SAML_CLOCK_SKEW_MS = 60_000;

/** An xml2js node as `@node-saml/node-saml` parses it (`explicitCharkey`, prefixes stripped). */
type XmlNode = { $?: Record<string, string | undefined>; _?: string } & Record<string, unknown>;

/** The facts of a signature-checked assertion that the sign-in uses. */
export interface AssertionFacts {
  /** The assertion's `ID` attribute (replay cache key). */
  id: string;
  issuer: string | null;
  nameId: string | null;
  nameIdFormat: string | null;
  /** Bearer subject confirmations with their `InResponseTo`, `Recipient` and `NotOnOrAfter`. */
  confirmations: { inResponseTo: string | null; recipient: string | null; notOnOrAfter: Date | null }[];
  /** `Conditions/@NotOnOrAfter`. */
  notOnOrAfter: Date | null;
  /** `AuthnStatement/AuthnContext/AuthnContextClassRef` of every authentication statement. */
  authnContextClassRefs: string[];
  /** The `email` attribute (or `mail`), never treated as verified (F.9). */
  email: string | null;
}

function children(node: unknown, name: string): XmlNode[] {
  if (!node || typeof node !== 'object') return [];
  const value = (node as Record<string, unknown>)[name];
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as XmlNode[]) : [];
}

function text(node: XmlNode | undefined): string | null {
  const value = node?._;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Reads the facts of an assertion parsed by the library (`profile.getAssertion()`, which is built from the
 * signature-checked XML only). Throws `idp_error` when the assertion has no `ID`.
 */
export function assertionFacts(parsed: unknown): AssertionFacts {
  // The root element is an object (`explicitRoot`), every child element a list.
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).Assertion : undefined;
  const assertion = (Array.isArray(root) ? root[0] : root) as XmlNode | undefined;
  const id = assertion?.$?.ID;
  if (!assertion || typeof id !== 'string' || id.length === 0) throw new SsoFailure('idp_error', 'assertion_id_missing');
  const subject = children(assertion, 'Subject')[0];
  const nameIdNode = children(subject, 'NameID')[0];
  const confirmations = children(subject, 'SubjectConfirmation')
    .filter((c) => c.$?.Method === BEARER_METHOD)
    .flatMap((c) => children(c, 'SubjectConfirmationData'))
    .map((d) => ({ inResponseTo: d.$?.InResponseTo ?? null, recipient: d.$?.Recipient ?? null, notOnOrAfter: date(d.$?.NotOnOrAfter) }));
  const conditions = children(assertion, 'Conditions')[0];
  const authnContextClassRefs = children(assertion, 'AuthnStatement')
    .flatMap((s) => children(s, 'AuthnContext'))
    .flatMap((c) => children(c, 'AuthnContextClassRef'))
    .map((r) => text(r))
    .filter((r): r is string => r !== null);
  let email: string | null = null;
  for (const statement of children(assertion, 'AttributeStatement')) {
    for (const attribute of children(statement, 'Attribute')) {
      const name = (attribute.$?.Name ?? '').toLowerCase();
      const friendly = (attribute.$?.FriendlyName ?? '').toLowerCase();
      if (email === null && ['email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3'].some((n) => n === name || n === friendly)) {
        email = text(children(attribute, 'AttributeValue')[0]);
      }
    }
  }
  return {
    id,
    issuer: text(children(assertion, 'Issuer')[0]),
    nameId: text(nameIdNode),
    nameIdFormat: nameIdNode?.$?.Format ?? null,
    confirmations,
    notOnOrAfter: date(conditions?.$?.NotOnOrAfter),
    authnContextClassRefs,
    email,
  };
}

/** The subject of an assertion (F.9): the persistent NameID; any other format, or none, is `idp_error`. */
export function samlSubjectOf(facts: Pick<AssertionFacts, 'nameId' | 'nameIdFormat'>): string {
  if (facts.nameIdFormat !== PERSISTENT_NAMEID_FORMAT) throw new SsoFailure('idp_error', 'nameid_not_persistent');
  if (!facts.nameId || facts.nameId.length > SUBJECT_MAX_LENGTH) throw new SsoFailure('idp_error', 'nameid_invalid');
  return facts.nameId;
}

/**
 * The issuer of the assertion must be the provider's `saml_idp_issuer` when one is configured (the library checks
 * the signature against the configured certificates, not the issuer).
 */
export function checkIssuer(facts: Pick<AssertionFacts, 'issuer'>, expected: string | null): void {
  if (expected && facts.issuer !== expected) throw new SsoFailure('idp_error', 'issuer_mismatch');
}

/**
 * The bearer confirmation of the signed assertion must answer this transaction's AuthnRequest (`InResponseTo`, F.9),
 * be addressed to this ACS (`Recipient`, when given) and still be valid (60 seconds of skew). The `InResponseTo` of
 * the outer response, which the identity provider may leave unsigned, must match too when it is present.
 */
export function checkSubjectConfirmation(
  facts: Pick<AssertionFacts, 'confirmations'>,
  expected: { requestId: string; acsUrl: string; responseInResponseTo: string | null; now: Date },
): void {
  if (expected.responseInResponseTo !== null && expected.responseInResponseTo !== expected.requestId) {
    throw new SsoFailure('expired', 'in_response_to_mismatch');
  }
  if (facts.confirmations.length === 0) throw new SsoFailure('idp_error', 'bearer_confirmation_missing');
  const answering = facts.confirmations.filter((c) => c.inResponseTo === expected.requestId);
  if (answering.length === 0) throw new SsoFailure('expired', 'in_response_to_mismatch');
  const addressed = answering.filter((c) => c.recipient === null || c.recipient === expected.acsUrl);
  if (addressed.length === 0) throw new SsoFailure('idp_error', 'recipient_mismatch');
  const valid = addressed.some((c) => c.notOnOrAfter !== null && expected.now.getTime() - SAML_CLOCK_SKEW_MS < c.notOnOrAfter.getTime());
  if (!valid) throw new SsoFailure('idp_error', 'confirmation_expired');
}

/**
 * Until when the assertion id is kept in `platform.saml_assertion_seen` (F.9): the latest `NotOnOrAfter` of the
 * conditions and the bearer confirmations, plus the clock skew. An assertion without any `NotOnOrAfter` has no end of
 * validity and is refused (`idp_error`).
 */
export function replayCacheExpiry(facts: Pick<AssertionFacts, 'notOnOrAfter' | 'confirmations'>): Date {
  const times = [facts.notOnOrAfter, ...facts.confirmations.map((c) => c.notOnOrAfter)].filter((d): d is Date => d !== null).map((d) => d.getTime());
  if (times.length === 0) throw new SsoFailure('idp_error', 'assertion_validity_missing');
  return new Date(Math.max(...times) + SAML_CLOCK_SKEW_MS);
}

/** The provider settings the SAML MFA rule uses (`platform.identity_provider`). */
export interface SamlMfaSettings {
  require_mfa_claim: boolean;
  saml_mfa_authn_contexts: readonly string[];
  mfa_fallback: 'local_totp' | 'reject';
}

/** True when one of the assertion's authentication contexts is in `saml_mfa_authn_contexts` (F.5). */
export function authnContextProvesMfa(classRefs: readonly string[], accepted: readonly string[]): boolean {
  const set = new Set(accepted);
  return classRefs.some((ref) => set.has(ref));
}

/**
 * F.5 for SAML: with `require_mfa_claim` the `AuthnContextClassRef` proves MFA when it is one of the provider's
 * `saml_mfa_authn_contexts`; without it the context is ignored and the local TOTP step always follows. Without a
 * proof `mfa_fallback` decides.
 */
export function decideSamlMfa(classRefs: readonly string[], provider: SamlMfaSettings): SsoMfaDecision {
  if (provider.require_mfa_claim && authnContextProvesMfa(classRefs, provider.saml_mfa_authn_contexts)) return { kind: 'idp' };
  if (provider.mfa_fallback === 'reject') return { kind: 'reject' };
  return { kind: 'local_totp' };
}

/** The `InResponseTo` attribute of the outer `samlp:Response`, read from the posted XML (null when absent). */
export function responseInResponseTo(xml: string): string | null {
  const open = /<(?:[A-Za-z_][\w.-]*:)?Response\b([^>]*)>/.exec(xml);
  if (!open) return null;
  const match = /\sInResponseTo\s*=\s*("([^"]*)"|'([^']*)')/.exec(open[1] ?? '');
  return match ? (match[2] ?? match[3] ?? null) : null;
}

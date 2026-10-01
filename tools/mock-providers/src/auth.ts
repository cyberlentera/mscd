import type { FastifyRequest } from 'fastify';
import { graphError, googleError } from './errors.js';
import { bearerToken } from './http.js';
import {
  type AccessTokenState,
  type DriveState,
  type MockState,
  type Principal,
  type Provider,
  principalMayUse,
} from './state.js';

// Bearer token checks for the Graph and Drive APIs, and the drive-level access rules (forbid switch, tenant and
// allow-list). A token works only on the API of the endpoint that issued it.

/** Any Drive scope (drive, drive.file, drive.readonly, drive.metadata.readonly, ...). */
const DRIVE_SCOPE = /(^|\s)https:\/\/www\.googleapis\.com\/auth\/drive(\.[a-z.]+)?(\s|$)/;

const principalOfRequest = new WeakMap<FastifyRequest, string>();

export function requestPrincipal(request: FastifyRequest): string | null {
  return principalOfRequest.get(request) ?? null;
}

const GRAPH_CHALLENGE =
  'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="00000003-0000-0000-c000-000000000000"';
const GOOGLE_CHALLENGE = 'Bearer realm="https://accounts.google.com/", error="invalid_token"';

function unauthenticated(provider: Provider, missing: boolean): Error {
  if (provider === 'm365') {
    return graphError(401, 'InvalidAuthenticationToken', missing ? 'Access token is empty.' : 'Access token has expired or is not yet valid.', {
      headers: { 'WWW-Authenticate': GRAPH_CHALLENGE },
    });
  }
  return missing
    ? googleError(
        401,
        'required',
        'Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
        { location: 'Authorization', locationType: 'header', headers: { 'WWW-Authenticate': GOOGLE_CHALLENGE } },
      )
    : googleError(401, 'authError', 'Invalid Credentials', {
        location: 'Authorization',
        locationType: 'header',
        headers: { 'WWW-Authenticate': GOOGLE_CHALLENGE },
      });
}

export function authenticate(state: MockState, request: FastifyRequest, provider: Provider): Principal {
  const token = bearerToken(request);
  if (!token) throw unauthenticated(provider, true);
  const record: AccessTokenState | undefined = state.accessTokens.get(token);
  if (!record || record.revoked || record.principal.provider !== provider || record.expiresAt <= Date.now()) {
    throw unauthenticated(provider, false);
  }
  principalOfRequest.set(request, record.principal.id);
  if (provider === 'google' && !DRIVE_SCOPE.test(record.scope)) {
    throw googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
  }
  return record.principal;
}

/** Throws the provider's error when the principal may not use the drive. */
export function assertDriveAccess(drive: DriveState, principal: Principal, fileId?: string): void {
  if (drive.forbidden) {
    if (drive.provider === 'm365') throw graphError(403, 'accessDenied', 'Access denied');
    throw googleError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
  }
  if (!principalMayUse(drive, principal)) {
    if (drive.provider === 'm365') throw graphError(403, 'accessDenied', 'Access denied');
    throw googleError(404, 'notFound', `File not found: ${fileId ?? drive.id}.`, { location: 'fileId', locationType: 'parameter' });
  }
}

import { newRequestId } from './ids.js';

// Error envelopes of the emulated APIs. Handlers throw `MockHttpError`; the application error handler sends the
// prepared body, status and headers unchanged.
//
// - Microsoft Graph: {error: {code, message, innerError: {code?, date, request-id, client-request-id}}}
// - Google APIs:     {error: {code: <http status>, message, errors: [{message, domain, reason, location?, locationType?}], status?}}
// - OAuth token endpoints: {error, error_description} (Google) and the Entra ID form with error_codes, timestamp,
//   trace_id and correlation_id
// - Admin API:       {error: {code, message, details?}}

export class MockHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body));
    this.name = 'MockHttpError';
  }
}

export type Api = 'graph' | 'drive' | 'identity' | 'admin' | 'other';

export function graphError(
  statusCode: number,
  code: string,
  message: string,
  options: { innerCode?: string; headers?: Record<string, string> } = {},
): MockHttpError {
  const requestId = newRequestId();
  const innerError: Record<string, string> = {};
  if (options.innerCode) innerError.code = options.innerCode;
  innerError.date = new Date().toISOString().slice(0, 19);
  innerError['request-id'] = requestId;
  return new MockHttpError(statusCode, { error: { code, message, innerError } }, {
    'request-id': requestId,
    ...options.headers,
  });
}

export interface GoogleErrorOptions {
  domain?: string;
  location?: string;
  locationType?: string;
  status?: string;
  headers?: Record<string, string>;
}

export function googleError(
  statusCode: number,
  reason: string,
  message: string,
  options: GoogleErrorOptions = {},
): MockHttpError {
  const detail: Record<string, string> = { message, domain: options.domain ?? 'global', reason };
  if (options.location) detail.location = options.location;
  if (options.locationType) detail.locationType = options.locationType;
  const error: Record<string, unknown> = { code: statusCode, message, errors: [detail] };
  if (options.status) error.status = options.status;
  return new MockHttpError(statusCode, { error }, options.headers ?? {});
}

/** Google OAuth 2.0 token endpoint error (RFC 6749 section 5.2). */
export function googleOAuthError(statusCode: number, error: string, description: string): MockHttpError {
  return new MockHttpError(statusCode, { error, error_description: description });
}

/** Microsoft identity platform token endpoint error. */
export function entraError(statusCode: number, error: string, aadsts: number, description: string): MockHttpError {
  const traceId = newRequestId();
  const correlationId = newRequestId();
  const timestamp = `${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z`;
  return new MockHttpError(statusCode, {
    error,
    error_description: `AADSTS${aadsts}: ${description}\r\nTrace ID: ${traceId}\r\nCorrelation ID: ${correlationId}\r\nTimestamp: ${timestamp}`,
    error_codes: [aadsts],
    timestamp,
    trace_id: traceId,
    correlation_id: correlationId,
  });
}

export function adminError(statusCode: number, code: string, message: string, details?: string[]): MockHttpError {
  return new MockHttpError(statusCode, { error: details ? { code, message, details } : { code, message } });
}

/** Builds the error of a given API for a generic failure (unknown route, parser errors, unexpected errors). */
export function genericError(api: Api, statusCode: number, message: string): MockHttpError {
  switch (api) {
    case 'graph':
      return graphError(statusCode, statusCode === 404 ? 'itemNotFound' : statusCode >= 500 ? 'generalException' : 'invalidRequest', message);
    case 'drive':
      return googleError(statusCode, statusCode === 404 ? 'notFound' : statusCode >= 500 ? 'backendError' : 'badRequest', message);
    case 'identity':
      return googleOAuthError(statusCode, statusCode >= 500 ? 'server_error' : 'invalid_request', message);
    default:
      return adminError(statusCode, statusCode === 404 ? 'not_found' : statusCode >= 500 ? 'internal' : 'bad_request', message);
  }
}

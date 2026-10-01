import type { FastifyRequest } from 'fastify';
import { type Api, MockHttpError, genericError } from './errors.js';

// Request helpers. Every request body arrives as a Buffer (one catch-all content type parser), so upload routes
// see the exact bytes whatever Content-Type the client sends, and JSON or form bodies are parsed by the route
// that expects them, with the error envelope of its API.

export function rawPath(request: FastifyRequest): string {
  const url = request.url;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

export function queryOf(request: FastifyRequest): URLSearchParams {
  const url = request.url;
  const query = url.indexOf('?');
  return new URLSearchParams(query === -1 ? '' : url.slice(query + 1));
}

export function bodyBuffer(request: FastifyRequest): Buffer {
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Parses a JSON object body; an empty body gives `undefined`. */
export function jsonBody(request: FastifyRequest, api: Api): Record<string, unknown> | undefined {
  const body = bodyBuffer(request);
  if (body.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw genericError(api, 400, 'The request body is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw genericError(api, 400, 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** Parses a JSON body of any shape (admin API); an empty body gives `undefined`. */
export function anyJsonBody(request: FastifyRequest, api: Api): unknown {
  const body = bodyBuffer(request);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw genericError(api, 400, 'The request body is not valid JSON.');
  }
}

export function formBody(request: FastifyRequest): URLSearchParams {
  return new URLSearchParams(bodyBuffer(request).toString('utf8'));
}

/** Scheme, host and port the client used, or the configured public URL. */
export function originOf(request: FastifyRequest, publicUrl: string | undefined): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  const host = header(request, 'host') ?? 'localhost';
  return `${request.protocol}://${host}`;
}

export function bearerToken(request: FastifyRequest): string | null {
  const value = header(request, 'authorization');
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1] : '';
}

export function apiOf(path: string): Api {
  if (path === '/_admin' || path.startsWith('/_admin/')) return 'admin';
  if (path === '/v1.0' || path.startsWith('/v1.0/') || path.startsWith('/_upload/graph/') || path.startsWith('/_monitor/') || path.startsWith('/_download/')) {
    return 'graph';
  }
  if (path.startsWith('/drive/v3/') || path.startsWith('/upload/drive/v3/') || path === '/drive/v3' || path === '/upload/drive/v3') return 'drive';
  if (path === '/token' || path === '/revoke' || path.startsWith('/o/oauth2/') || /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(path)) return 'identity';
  return 'other';
}

/** Decodes one percent-encoded path segment; malformed escapes are a 400 of the given API. */
export function decodeSegment(segment: string, api: Api): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw genericError(api, 400, `Malformed percent-encoding in "${segment}".`);
  }
}

export function isMockHttpError(error: unknown): error is MockHttpError {
  return error instanceof MockHttpError;
}

/** Parses an integer query or header value within bounds; undefined when absent. */
export function intParam(value: string | null | undefined, min: number, max: number): number | undefined | null {
  if (value === null || value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed < min || parsed > max ? null : parsed;
}

export function truthy(value: string | null): boolean {
  return value === 'true' || value === '1';
}

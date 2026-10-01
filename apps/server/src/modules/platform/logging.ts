import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import type { MscdConfig } from '../../config/mscd-config';
import { VERSION } from '../../generated/build-info';
import { requestIdFrom } from './request-id';

export const REDACTED = '[redacted]';

/** F.12 redaction paths (pino syntax; `*` is one level) plus the response cookie. */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-mscd-put"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.clientSecret',
  '*.refreshToken',
  '*.sealedBlob',
  '*.privateKeyPem',
  '*.certificatePem',
  '*.token',
  '*.code',
  // The same keys at the top level of a log object (logger.warn({ password })): `*.x` matches one level down only.
  'password',
  'secret',
  'clientSecret',
  'refreshToken',
  'sealedBlob',
  'privateKeyPem',
  'certificatePem',
  'token',
  'code',
];

/** F.12: values of these query parameters never reach a log line. */
export const REDACTED_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  'token',
  'code',
  'state',
  't',
  'SAMLResponse',
  'RelayState',
  'invitation',
]);

/** Probe paths are not logged per request. */
const QUIET_PATHS = new Set(['/healthz', '/readyz']);

/** Replaces the values of the F.12 query parameters with `[redacted]`; the rest of the URL is unchanged. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  const redacted = query
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      const rawName = separator < 0 ? pair : pair.slice(0, separator);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // Keep the raw name when it is not valid percent-encoding.
      }
      return REDACTED_QUERY_PARAMETERS.has(name) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('&');
  return `${url.slice(0, queryStart)}?${redacted}`;
}

/** Keys ending in `_sealed` are redacted at any depth of plain objects (F.12 `*_sealed`). */
export function redactSealedFields<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactSealedFields(item, depth + 1)) as T;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = key.endsWith('_sealed') ? REDACTED : redactSealedFields(item, depth + 1);
  }
  return result as T;
}

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
  remotePort?: number;
  [key: string]: unknown;
}

/** Request serializer: the URL with redacted query values; no separate query or params objects. */
export function serializeRequest(req: SerializedRequest): SerializedRequest {
  return {
    id: req.id,
    method: req.method,
    url: typeof req.url === 'string' ? redactUrl(req.url) : req.url,
    headers: req.headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

/** nestjs-pino settings for every run mode: level, redaction, request ids and serializers (F.12). */
export function loggerParams(config: MscdConfig): Params {
  return {
    pinoHttp: {
      level: config.profile.observability.log_level,
      base: { service: 'mscd-server', mode: config.runMode, version: VERSION },
      timestamp: stdTimeFunctions.isoTime,
      redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
      formatters: { log: (object) => redactSealedFields(object) },
      // Fastify validates X-Request-Id and puts the id on the raw request (D.1); the fallback covers other callers.
      genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? requestIdFrom(req.headers['x-request-id']),
      serializers: { req: serializeRequest },
      // Probes are not logged per request, also when not ready: the probe response carries the detail.
      autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(pathOf(req.url)) },
      customLogLevel: (req, res, error) => {
        if (QUIET_PATHS.has(pathOf(req.url))) return 'silent';
        return error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      },
    },
  };
}

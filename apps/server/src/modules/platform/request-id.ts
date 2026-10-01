import { randomUUID } from 'node:crypto';

/** D.1 and F.12: a client or proxy request id is accepted only in this form. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** The `X-Request-Id` value when valid, otherwise a new UUID. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

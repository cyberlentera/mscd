import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MockState } from './state.js';

// Pre-authenticated download URLs (Graph `@microsoft.graph.downloadUrl`): the token names an item and version and
// expires after an hour, signed with the state's random secret, so the URL works without a bearer token and
// nothing has to be stored per URL.

const DOWNLOAD_LIFETIME_MS = 60 * 60 * 1000;

export function signDownload(state: MockState, itemId: string, versionId: string): string {
  const payload = Buffer.from(JSON.stringify({ i: itemId, v: versionId, e: Date.now() + DOWNLOAD_LIFETIME_MS })).toString('base64url');
  const signature = createHmac('sha256', state.secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyDownload(state: MockState, token: string): { itemId: string; versionId: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expected = createHmac('sha256', state.secret).update(payload).digest();
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { i: string; v: string; e: number };
    if (typeof decoded.e !== 'number' || decoded.e < Date.now()) return null;
    return { itemId: decoded.i, versionId: decoded.v };
  } catch {
    return null;
  }
}

/** Opaque, tamper-evident page token (Graph `$skiptoken`, Drive `pageToken`) bound to the listing it belongs to. */
export function signPageToken(state: MockState, scope: string, offset: number): string {
  const payload = Buffer.from(JSON.stringify({ s: scope, o: offset })).toString('base64url');
  const signature = createHmac('sha256', state.secret).update(payload).digest('base64url').slice(0, 16);
  return `${payload}.${signature}`;
}

export function verifyPageToken(state: MockState, scope: string, token: string): number | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = createHmac('sha256', state.secret).update(payload).digest('base64url').slice(0, 16);
  if (signature !== token.slice(dot + 1)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { s: string; o: number };
    return decoded.s === scope && Number.isInteger(decoded.o) && decoded.o >= 0 ? decoded.o : null;
  } catch {
    return null;
  }
}

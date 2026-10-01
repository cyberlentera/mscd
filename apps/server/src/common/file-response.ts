// File responses (build plan D-28, F.13). `FileResponder.send` is the only way a route returns file bytes: storage
// object content, export downloads, evidence pack manifests and archives, the calendar feed and the audit trail CSV.
// The content type comes from the server's stored value (the gateway's detection, never the client's declaration)
// and only from an allow-list; everything else is sent as `application/octet-stream`, always as an attachment
// unless the caller asks for inline display of a PDF or a raster image. Each response is audited.
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { AUDIT_WRITER, type AuditWriter } from './tokens';

/** Content types sent as stored (F.13); with the charset the server adds for text. */
const ALLOWED_TYPES: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'application/pdf'],
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['text/plain', 'text/plain; charset=utf-8'],
  ['text/csv', 'text/csv; charset=utf-8'],
  ['text/calendar', 'text/calendar; charset=utf-8'],
  ['application/msword', 'application/msword'],
  ['application/vnd.ms-excel', 'application/vnd.ms-excel'],
  ['application/vnd.ms-powerpoint', 'application/vnd.ms-powerpoint'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

/** Types that may be displayed inline when the request asks for it (F.13). */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const FILE_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";
const FALLBACK_TYPE = 'application/octet-stream';
const MAX_FILE_NAME = 150;

/** The media type without parameters, lower case (`Text/HTML; charset=x` gives `text/html`). */
function baseType(type: string | null | undefined): string {
  return (type ?? '').split(';')[0]!.trim().toLowerCase();
}

/** The `Content-Type` sent for a stored type: the allow-listed type, else `application/octet-stream` (F.13). */
export function responseContentType(storedType: string | null | undefined): string {
  return ALLOWED_TYPES.get(baseType(storedType)) ?? FALLBACK_TYPE;
}

/** True when the stored type may be shown inline (PDF and the four raster image types). */
export function inlineAllowed(storedType: string | null | undefined): boolean {
  return INLINE_TYPES.has(baseType(storedType));
}

/**
 * A file name safe for `Content-Disposition`: control characters, quotes, slashes and backslashes removed, white
 * space collapsed, cut to 150 characters (by code point); `download` when nothing is left.
 */
export function sanitiseFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f"'`/\\]/g, '').replace(/\s+/g, ' ').trim();
  const cut = [...cleaned].slice(0, MAX_FILE_NAME).join('').trim();
  return cut === '' || cut === '.' || cut === '..' ? 'download' : cut;
}

/** ASCII fallback of a file name: diacritics removed, other non-ASCII characters replaced by `_`. */
export function asciiFileName(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[%;]/g, '_');
  return ascii.trim() === '' ? 'download' : ascii;
}

/** RFC 5987 encoding of a value (`filename*`). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `Content-Disposition` value (F.13): `attachment` (or `inline`), ASCII `filename` and UTF-8 `filename*`. */
export function contentDisposition(fileName: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const safe = sanitiseFileName(fileName);
  return `${disposition}; filename="${asciiFileName(safe)}"; filename*=UTF-8''${rfc5987(safe)}`;
}

export interface FileResponseOptions {
  /** The stored content type (the gateway's detection or the server's own type for generated files). */
  storedType: string | null | undefined;
  fileName: string;
  /** Byte length when known (sets `Content-Length`). */
  size?: number | null;
  /** The request asked for inline display; honoured only for PDF and raster images. */
  inline?: boolean;
}

/** Every header of a file response (F.13). */
export function fileResponseHeaders(options: FileResponseOptions): Record<string, string> {
  const inline = options.inline === true && inlineAllowed(options.storedType);
  const headers: Record<string, string> = {
    'content-type': responseContentType(options.storedType),
    'content-disposition': contentDisposition(options.fileName, inline ? 'inline' : 'attachment'),
    'content-security-policy': FILE_CONTENT_SECURITY_POLICY,
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
  if (options.size !== undefined && options.size !== null && Number.isInteger(options.size) && options.size >= 0) {
    headers['content-length'] = String(options.size);
  }
  return headers;
}

/** The audit entry a file response writes (F.13): `file.downloaded`, or `file.opened` for open and redirect. */
export interface FileResponseAudit {
  action?: 'file.downloaded' | 'file.opened' | 'export.downloaded' | 'evidence_pack.downloaded';
  /** `management_system.id` of the system the file was read for. */
  msId?: string | null;
  entityType: string;
  entityId?: string | null;
  entityCode?: string | null;
  after?: Record<string, unknown> | null;
}

export interface SendFileOptions extends FileResponseOptions {
  /** The bytes: a stream, a buffer or a string (UTF-8). */
  body: Readable | Buffer | Uint8Array | string;
  /** Audit entry written to the tenant audit trail before the bytes are sent; omit only for public files. */
  audit?: FileResponseAudit;
}

/** Sends file bytes with the F.13 headers and writes the audit entry first. */
@Injectable()
export class FileResponder {
  constructor(@Optional() @Inject(AUDIT_WRITER) private readonly audit?: AuditWriter) {}

  async send(reply: FastifyReply, options: SendFileOptions): Promise<FastifyReply> {
    if (options.audit) {
      if (!this.audit) throw new Error('FileResponder: no audit writer is registered');
      const { action, ...entry } = options.audit;
      await this.audit.recordDetached({ action: action ?? 'file.downloaded', ...entry, after: entry.after ?? { fileName: sanitiseFileName(options.fileName) } });
    }
    const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body;
    const size = options.size ?? (Buffer.isBuffer(body) || body instanceof Uint8Array ? body.byteLength : undefined);
    reply.headers(fileResponseHeaders({ ...options, size }));
    return reply.status(200).send(body);
  }
}

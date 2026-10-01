import { createHash } from 'node:crypto';
import { QuickXorHash } from './quickxor.js';

export interface ContentHashes {
  /** Base64, Graph `file.hashes.quickXorHash`. */
  quickXorHash: string;
  /** Lower-case hex, Drive `sha256Checksum`. */
  sha256: string;
  /** Lower-case hex, Drive `md5Checksum`. */
  md5: string;
}

export function hashContent(content: Uint8Array): ContentHashes {
  return {
    quickXorHash: new QuickXorHash().update(content).digestBase64(),
    sha256: createHash('sha256').update(content).digest('hex'),
    md5: createHash('md5').update(content).digest('hex'),
  };
}

/** Deterministic bytes for fixture versions that declare no content (same seed, same bytes). */
export function synthesizeContent(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash('sha256').update(`mock-providers:${seed}`).digest();
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(out, offset, 0, Math.min(block.length, size - offset));
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
export const OCTET_STREAM = 'application/octet-stream';

/** Google Workspace editor files (Docs, Sheets, ...) have no binary content in Drive. */
export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_NATIVE_PREFIX) && mimeType !== GOOGLE_FOLDER_MIME;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gdoc: 'application/vnd.google-apps.document',
  gif: 'image/gif',
  gsheet: 'application/vnd.google-apps.spreadsheet',
  gslides: 'application/vnd.google-apps.presentation',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  vsdx: 'application/vnd.ms-visio.drawing',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  zip: 'application/zip',
};

/** The MIME type a provider would infer from a file name. */
export function mimeTypeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return OCTET_STREAM;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? OCTET_STREAM;
}

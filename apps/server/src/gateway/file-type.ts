// File type detection of the storage gateway (build plan D.5, F.13). The type is decided from the first 4 KiB of the
// content only, never from a name or a type a client declared: PDF, PNG, JPEG, GIF, WebP, the ZIP-based Office
// formats (DOCX, XLSX, PPTX), other ZIP archives, and plain text. Everything else, HTML and SVG included, is
// `application/octet-stream`, so the api serves it only as a download.

/** Bytes the detection reads (D.5). */
export const DETECTION_BYTES = 4096;

export const OCTET_STREAM = 'application/octet-stream';

const OFFICE_TYPES: readonly [prefix: string, type: string][] = [
  ['word/', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xl/', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt/', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
];

function startsWith(head: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

/** The Office type of a ZIP archive, from the names of the local file headers within the first 4 KiB. */
function zipType(head: Buffer): string {
  let offset = 0;
  let sawContentTypes = false;
  // Local file header: signature PK\x03\x04, name length at 26, extra length at 28, name at 30.
  for (let entries = 0; entries < 32 && offset + 30 <= head.length; entries += 1) {
    if (!startsWith(head, [0x50, 0x4b, 0x03, 0x04], offset)) break;
    const compressedSize = head.readUInt32LE(offset + 18);
    const nameLength = head.readUInt16LE(offset + 26);
    const extraLength = head.readUInt16LE(offset + 28);
    const flags = head.readUInt16LE(offset + 6);
    if (offset + 30 + nameLength > head.length) break;
    const name = head.subarray(offset + 30, offset + 30 + nameLength).toString('latin1');
    if (name === '[Content_Types].xml') sawContentTypes = true;
    for (const [prefix, type] of OFFICE_TYPES) {
      if (name.startsWith(prefix) && sawContentTypes) return type;
    }
    // A data descriptor (flag bit 3) leaves the size unknown here: stop walking.
    if ((flags & 0x08) !== 0) break;
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return 'application/zip';
}

/** True when the bytes are text: valid UTF-8 (a character cut at the end is allowed) without control characters. */
function isPlainText(head: Buffer): boolean {
  if (head.length === 0) return false;
  let text = head;
  if (startsWith(text, [0xef, 0xbb, 0xbf])) text = text.subarray(3);
  // A multi-byte character may be cut at the 4 KiB boundary: drop an incomplete sequence at the end.
  let end = text.length;
  for (let back = 1; back <= 3 && back <= text.length; back += 1) {
    const byte = text[text.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (needed > back) end = text.length - back;
    break;
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(text.subarray(0, end));
  if (decoded.includes('\uFFFD')) return false;
  for (const char of decoded) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) return false;
    if (code === 0x7f) return false;
  }
  return true;
}

/** Markup that browsers would render as active content even when sent as text. */
function looksLikeMarkup(head: Buffer): boolean {
  const start = head.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return /^<(?:!doctype|html|head|body|script|svg|\?xml|iframe|object|embed|div|a\s|img|style|meta|link|xml|xsl|!--)/.test(start);
}

/**
 * The content type of a file from its first bytes (at most 4 KiB are read). HTML, SVG, XML and anything not listed
 * in D.5 is `application/octet-stream`.
 */
export function detectFileType(first: Buffer): string {
  const head = first.length > DETECTION_BYTES ? first.subarray(0, DETECTION_BYTES) : first;
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return zipType(head);
  if (isPlainText(head) && !looksLikeMarkup(head)) return 'text/plain';
  return OCTET_STREAM;
}

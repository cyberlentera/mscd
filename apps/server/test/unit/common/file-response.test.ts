import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  contentDisposition,
  FILE_CONTENT_SECURITY_POLICY,
  FileResponder,
  fileResponseHeaders,
  responseContentType,
  sanitiseFileName,
} from '../../../src/common/file-response';
import type { AuditEntryInput, AuditWriter } from '../../../src/common/tokens';

describe('FileResponder headers (F.13, D-28)', () => {
  it('sends text/html, image/svg+xml and XML as application/octet-stream attachments with the sandbox CSP', () => {
    for (const storedType of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xml', 'application/javascript', null, undefined]) {
      const headers = fileResponseHeaders({ storedType, fileName: 'evidence.html', inline: true });
      expect(headers['content-type'], String(storedType)).toBe('application/octet-stream');
      expect(headers['content-disposition']).toMatch(/^attachment; /);
      expect(headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['cache-control']).toBe('no-store');
    }
    expect(FILE_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; sandbox");
  });

  it('keeps allow-listed types, adds the charset to text, and allows inline only for PDF and raster images', () => {
    expect(responseContentType('application/pdf')).toBe('application/pdf');
    expect(responseContentType('TEXT/PLAIN')).toBe('text/plain; charset=utf-8');
    expect(responseContentType('text/csv')).toBe('text/csv; charset=utf-8');
    expect(responseContentType('text/calendar')).toBe('text/calendar; charset=utf-8');
    expect(responseContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(fileResponseHeaders({ storedType: 'application/pdf', fileName: 'a.pdf', inline: true })['content-disposition']).toMatch(/^inline; /);
    expect(fileResponseHeaders({ storedType: 'image/png', fileName: 'a.png', inline: true })['content-disposition']).toMatch(/^inline; /);
    expect(fileResponseHeaders({ storedType: 'image/png', fileName: 'a.png' })['content-disposition']).toMatch(/^attachment; /);
    expect(fileResponseHeaders({ storedType: 'text/plain', fileName: 'a.txt', inline: true })['content-disposition']).toMatch(/^attachment; /);
    expect(fileResponseHeaders({ storedType: 'text/plain', fileName: 'a.txt', size: 12 })['content-length']).toBe('12');
  });

  it('cleans file names and writes an ASCII fallback with an RFC 5987 UTF-8 name', () => {
    expect(sanitiseFileName('../../etc/"passwd"\r\n')).toBe('....etcpasswd');
    expect(sanitiseFileName('a\\b/c')).toBe('abc');
    expect(sanitiseFileName('   ')).toBe('download');
    expect(sanitiseFileName('x'.repeat(400))).toHaveLength(150);
    const value = contentDisposition('Laporan Audit ISO 27001 – Ringkasan.pdf');
    expect(value).toBe(
      `attachment; filename="Laporan Audit ISO 27001 _ Ringkasan.pdf"; filename*=UTF-8''Laporan%20Audit%20ISO%2027001%20%E2%80%93%20Ringkasan.pdf`,
    );
    expect(contentDisposition('Café;100%.txt')).toBe(`attachment; filename="Cafe_100_.txt"; filename*=UTF-8''Caf%C3%A9%3B100%25.txt`);
    expect(contentDisposition("it's (draft).csv")).toBe(`attachment; filename="its (draft).csv"; filename*=UTF-8''its%20%28draft%29.csv`);
  });

  it('sends the bytes with the headers and writes the audit entry first', async () => {
    const entries: AuditEntryInput[] = [];
    const audit: AuditWriter = {
      record: vi.fn(),
      recordDetached: vi.fn(async (entry: AuditEntryInput) => {
        entries.push(entry);
        return { chain: 'tenant' as const, id: 'id', seq: '1' };
      }),
    };
    const responder = new FileResponder(audit);
    const app = Fastify();
    app.get('/svg', async (_request, reply) =>
      responder.send(reply, {
        body: Readable.from([Buffer.from('<svg onload="alert(1)"/>')]),
        storedType: 'image/svg+xml',
        fileName: 'logo.svg',
        inline: true,
        audit: { entityType: 'evidence', entityCode: 'EV-1' },
      }),
    );
    app.get('/text', async (_request, reply) => responder.send(reply, { body: 'hello', storedType: 'text/plain', fileName: 'note.txt' }));
    try {
      const svg = await app.inject({ method: 'GET', url: '/svg' });
      expect(svg.statusCode).toBe(200);
      expect(svg.headers['content-type']).toBe('application/octet-stream');
      expect(svg.headers['content-disposition']).toMatch(/^attachment; filename="logo.svg"/);
      expect(svg.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(svg.body).toBe('<svg onload="alert(1)"/>');
      expect(entries).toEqual([{ action: 'file.downloaded', entityType: 'evidence', entityCode: 'EV-1', after: { fileName: 'logo.svg' } }]);
      const text = await app.inject({ method: 'GET', url: '/text' });
      expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(text.headers['content-length']).toBe('5');
      expect(text.body).toBe('hello');
    } finally {
      await app.close();
    }
  });
});

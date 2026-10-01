// Gateway crypto and helpers without containers (D-08, D-10, F.11, D.5): chunked vault encryption with change,
// truncation and extension detection; file type detection from the first 4 KiB; credential sealing bound to the
// organisation, repository and configuration; tenant data keys with the five-minute cache and rotation; gateway
// tokens with current and previous files.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { GatewayTokens } from '../../../src/gateway/auth';
import {
  CHUNK_SIZE,
  ChunkDecryptor,
  ChunkEncryptor,
  DecryptionError,
  TAG_SIZE,
  ciphertextLength,
  decryptBuffer,
  encryptBuffer,
  newNoncePrefix,
  parseHeader,
  plaintextLength,
  serializeHeader,
} from '../../../src/gateway/crypto/chunked';
import { configSha256, openCredential, sealCredential } from '../../../src/gateway/crypto/credentials';
import { DATA_KEY_CACHE_MS, DataKeyService } from '../../../src/gateway/crypto/data-keys';
import { detectFileType } from '../../../src/gateway/file-type';
import { GatewayError } from '../../../src/gateway/problems';
import { FileKeyProvider, kekIdOf, openWithKek } from '../../../src/modules/keys/file-key-provider';
import { repositoryConfigSha256 } from '../../../src/modules/storage/gateway-context';
import { TestDataKeyIssuer } from '../../setup/global-db';
import { SECRETS_DIR, tempDir } from './helpers';

const ORG = '00000000-0000-4000-8000-00000000a001';
const OTHER_ORG = '00000000-0000-4000-8000-00000000a002';
const REPO = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';

function keys() {
  return { contentKey: randomBytes(32), noncePrefix: newNoncePrefix(), cid: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f' };
}

async function streamThrough(transform: ChunkEncryptor | ChunkDecryptor, input: Buffer, pieceSize: number): Promise<Buffer> {
  const source = new PassThrough();
  const parts: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (part: Buffer) => parts.push(part));
  const done = pipeline(source, transform, sink);
  for (let offset = 0; offset < input.length; offset += pieceSize) source.write(input.subarray(offset, offset + pieceSize));
  source.end();
  await done;
  return Buffer.concat(parts);
}

describe('vault chunk encryption (D-10, F.11)', () => {
  const sizes = [0, 1, 100, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE, 3 * CHUNK_SIZE + 17];

  it.each(sizes)('round-trips %i bytes and the lengths are consistent', async (size) => {
    const k = keys();
    const plain = randomBytes(size);
    const sealed = encryptBuffer(plain, k);
    expect(sealed.length).toBe(ciphertextLength(size));
    expect(plaintextLength(sealed.length)).toBe(size);
    expect(decryptBuffer(sealed, k).equals(plain)).toBe(true);
    // The streaming transforms produce and accept the same bytes, whatever the piece sizes.
    const streamed = await streamThrough(new ChunkEncryptor(k), plain, 7_777);
    expect(streamed.length).toBe(sealed.length);
    expect((await streamThrough(new ChunkDecryptor(k), streamed, 10_000)).equals(plain)).toBe(true);
    expect(decryptBuffer(streamed, k).equals(plain)).toBe(true);
  });

  it('never writes the plaintext: every chunk is ciphertext plus a 16-byte tag', () => {
    const k = keys();
    const plain = Buffer.alloc(CHUNK_SIZE * 2, 0x41);
    const sealed = encryptBuffer(plain, k);
    expect(sealed.length).toBe(plain.length + 2 * TAG_SIZE);
    expect(sealed.includes(Buffer.alloc(64, 0x41))).toBe(false);
  });

  it('detects a changed byte in any chunk', async () => {
    const k = keys();
    const sealed = encryptBuffer(randomBytes(2 * CHUNK_SIZE + 5), k);
    for (const offset of [0, CHUNK_SIZE + TAG_SIZE + 3, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[offset] ^= 0x01;
      expect(() => decryptBuffer(tampered, k)).toThrow(DecryptionError);
      await expect(streamThrough(new ChunkDecryptor(k), tampered, 4096)).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it('detects truncation at a chunk boundary, inside a chunk, and appended bytes', async () => {
    const k = keys();
    const sealed = encryptBuffer(randomBytes(2 * CHUNK_SIZE + 5), k);
    const atBoundary = sealed.subarray(0, 2 * (CHUNK_SIZE + TAG_SIZE));
    // A cut at a boundary leaves a well-formed length; the missing final flag still fails.
    expect(plaintextLength(atBoundary.length)).toBe(2 * CHUNK_SIZE);
    for (const broken of [atBoundary, sealed.subarray(0, sealed.length - 3), Buffer.concat([sealed, Buffer.from([1, 2, 3])]), Buffer.alloc(0)]) {
      await expect(streamThrough(new ChunkDecryptor(k), broken, 5000)).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it('refuses another content id, another key, swapped chunks or another nonce prefix', () => {
    const k = keys();
    const sealed = encryptBuffer(randomBytes(2 * CHUNK_SIZE + 1), k);
    expect(() => decryptBuffer(sealed, { ...k, cid: 'other' })).toThrow(DecryptionError);
    expect(() => decryptBuffer(sealed, { ...k, contentKey: randomBytes(32) })).toThrow(DecryptionError);
    expect(() => decryptBuffer(sealed, { ...k, noncePrefix: newNoncePrefix() })).toThrow(DecryptionError);
    const step = CHUNK_SIZE + TAG_SIZE;
    const swapped = Buffer.concat([sealed.subarray(step, 2 * step), sealed.subarray(0, step), sealed.subarray(2 * step)]);
    expect(() => decryptBuffer(swapped, k)).toThrow(DecryptionError);
  });

  it('writes and reads the encryption header of F.11 with the content id', () => {
    const header = { v: 1 as const, alg: 'A256GCM-CHUNK64K' as const, ck: 'v1.12345678.aXY.Y2s', np: newNoncePrefix().toString('base64url'), cid: 'x' };
    const text = serializeHeader(header);
    expect(JSON.parse(text)).toEqual(header);
    expect(parseHeader(text)).toEqual(header);
    expect(parseHeader('{"v":2}')).toBeNull();
    expect(parseHeader(JSON.stringify({ ...header, np: 'AAAA' }))).toBeNull();
    expect(parseHeader('not json')).toBeNull();
  });
});

describe('file type detection (D.5, F.13)', () => {
  const zip = (names: string[]) => {
    const parts: Buffer[] = [];
    for (const name of names) {
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(0, 6);
      header.writeUInt32LE(4, 18);
      header.writeUInt16LE(Buffer.byteLength(name), 26);
      header.writeUInt16LE(0, 28);
      parts.push(header, Buffer.from(name), Buffer.from('abcd'));
    }
    return Buffer.concat(parts);
  };

  it.each([
    ['PDF', Buffer.from('%PDF-1.7\n%...'), 'application/pdf'],
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'image/png'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a....'), 'image/gif'],
    ['WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    ['DOCX', zip(['[Content_Types].xml', 'word/document.xml']), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['XLSX', zip(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['PPTX', zip(['[Content_Types].xml', 'ppt/presentation.xml']), 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['ZIP', zip(['notes.txt']), 'application/zip'],
    ['text', Buffer.from('Backup job log\r\nAll jobs completed. Tanggal: 29 Sep 2026\n'), 'text/plain'],
    ['UTF-8 text', Buffer.from('Laporan audit – ringkasan été\n', 'utf8'), 'text/plain'],
    ['HTML', Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>'), 'application/octet-stream'],
    ['HTML without doctype', Buffer.from('  <html><body>x</body></html>'), 'application/octet-stream'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), 'application/octet-stream'],
    ['XML', Buffer.from('<?xml version="1.0"?><a/>'), 'application/octet-stream'],
    ['binary', Buffer.from([0, 1, 2, 3, 4, 5, 0xff, 0xfe]), 'application/octet-stream'],
    ['empty', Buffer.alloc(0), 'application/octet-stream'],
  ])('%s', (_name, bytes, type) => {
    expect(detectFileType(bytes)).toBe(type);
  });

  it('reads only the first 4 KiB and accepts a character cut at the boundary', () => {
    const text = Buffer.from('é'.repeat(3000), 'utf8');
    expect(detectFileType(text.subarray(0, 4095))).toBe('text/plain');
    const tail = Buffer.concat([Buffer.from('a'.repeat(4096)), Buffer.from([0, 0, 0])]);
    expect(detectFileType(tail)).toBe('text/plain');
  });
});

describe('credential sealing and binding (D-08)', () => {
  const kek = Buffer.from(readFileSync(path.join(SECRETS_DIR, 'storage.key'), 'utf8').trim(), 'base64');
  const service = new DataKeyService(new FileKeyProvider(kek));
  const config = {
    driveId: 'drive-gd-bcms',
    rootFolderId: 'root-compliance',
    oauthClientId: 'client-1',
    roots: { bcms: { folderId: 'f-bcms', path: 'Compliance/BCMS' } },
  };
  const secret = { clientEmail: 'mscd@project.iam.gserviceaccount.com', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n' };

  it('opens only for the organisation, repository and binding configuration it was sealed for', async () => {
    const issued = await service.issue(ORG);
    const dataKey = await service.unwrap(ORG, issued.wrappedDek);
    const sealed = sealCredential(dataKey, { id: REPO, config }, 'google_service_account', secret);
    expect(sealed.keyId).toBe(dataKey.id);
    expect(sealed.configSha256).toBe(configSha256(config));
    // The api computes the same hash for its credentialSet flag.
    expect(repositoryConfigSha256(config)).toBe(sealed.configSha256);
    expect(sealed.sealedBlob).not.toContain('PRIVATE');
    const credential = { ref: 'cred-gd', sealedBlob: sealed.sealedBlob, kind: 'google_service_account' as const };
    expect(openCredential(dataKey, { id: REPO, config }, credential).secret).toEqual(secret);
    // A new label of a root folder is a display field and does not unbind the credential.
    const relabelled = { ...config, roots: { bcms: { folderId: 'f-bcms', path: 'Compliance/Continuity' } } };
    expect(openCredential(dataKey, { id: REPO, config: relabelled }, credential).secret).toEqual(secret);

    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayError);
        expect((error as GatewayError).slug).toBe('forbidden');
        expect((error as GatewayError).extras.reason).toBe('credential-binding');
        return;
      }
      throw new Error('expected a credential-binding refusal');
    };
    refused(() => openCredential(dataKey, { id: REPO, config: { ...config, driveId: 'drive-other' } }, credential));
    refused(() => openCredential(dataKey, { id: REPO, config: { ...config, rootFolderId: 'root-other' } }, credential));
    refused(() => openCredential(dataKey, { id: REPO, config: { ...config, roots: { bcms: { folderId: 'f-other', path: 'Compliance/BCMS' } } } }, credential));
    refused(() => openCredential(dataKey, { id: '4c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', config }, credential));
    const otherKey = await service.unwrap(OTHER_ORG, (await service.issue(OTHER_ORG)).wrappedDek);
    refused(() => openCredential(otherKey, { id: REPO, config }, credential));
    const tampered = sealed.sealedBlob.slice(0, -2) + (sealed.sealedBlob.endsWith('A') ? 'BB' : 'AA');
    refused(() => openCredential(dataKey, { id: REPO, config }, { ...credential, sealedBlob: tampered }));
  });

  it('refuses a credential whose stored kind differs from the call', async () => {
    const dataKey = await service.unwrap(ORG, (await service.issue(ORG)).wrappedDek);
    const sealed = sealCredential(dataKey, { id: REPO, config }, 'google_service_account', secret);
    expect(() => openCredential(dataKey, { id: REPO, config }, { ref: 'r', sealedBlob: sealed.sealedBlob, kind: 'oauth_refresh_token' })).toThrow(/kind/);
  });
});

describe('tenant data keys (F.11, D.5)', () => {
  it('issues keys the TestDataKeyIssuer format matches, caches them five minutes and refuses another organisation', async () => {
    let now = 1_000_000;
    const kekFile = path.join(SECRETS_DIR, 'storage.key');
    const provider = FileKeyProvider.fromFiles(kekFile);
    const service = new DataKeyService(provider, () => now);
    const issued = await service.issue(ORG);
    expect(issued.kekId).toBe(provider.kekId);
    expect(issued.wrappedDek.startsWith(`v1.${provider.kekId}.`)).toBe(true);
    expect(openWithKek(Buffer.from(readFileSync(kekFile, 'utf8').trim(), 'base64'), issued.wrappedDek, `dek:${ORG}`)).toHaveLength(32);
    // Keys of tenants provisioned in tests (TestDataKeyIssuer) open in the gateway.
    const fromTests = await new TestDataKeyIssuer().issue(ORG);
    const opened = await service.unwrap(ORG, fromTests.wrappedDek);
    expect(opened.key).toHaveLength(32);
    expect(opened.id).toBe(kekIdOf(opened.key));
    expect(await service.unwrap(ORG, fromTests.wrappedDek)).toBe(opened);
    now += DATA_KEY_CACHE_MS + 1;
    expect(await service.unwrap(ORG, fromTests.wrappedDek)).not.toBe(opened);
    await expect(service.unwrap(OTHER_ORG, fromTests.wrappedDek)).rejects.toMatchObject({ slug: 'bad-request' });
    await expect(service.unwrap(ORG, 'v1.00000000.AAAA.AAAA')).rejects.toMatchObject({ slug: 'bad-request' });
  });

  it('re-wraps a data key under a new storage.key and still opens it during the rotation', async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = new DataKeyService(new FileKeyProvider(oldKey));
    const wrapped = await before.issue(ORG);
    const rotating = new DataKeyService(new FileKeyProvider(newKey, [oldKey]));
    const plain = (await rotating.unwrap(ORG, wrapped.wrappedDek)).key;
    const rewrapped = await rotating.rewrap(ORG, wrapped.wrappedDek);
    expect(rewrapped?.kekId).toBe(kekIdOf(newKey));
    expect(await rotating.rewrap(ORG, rewrapped!.wrappedDek)).toBeNull();
    const after = new DataKeyService(new FileKeyProvider(newKey));
    expect((await after.unwrap(ORG, rewrapped!.wrappedDek)).key.equals(plain)).toBe(true);
  });
});

describe('gateway tokens (D.5)', () => {
  it('accepts the current and previous token and follows changes of the files', () => {
    const dir = tempDir();
    const current = path.join(dir, 'gateway.token');
    const previous = path.join(dir, 'gateway.token.previous');
    const a = randomBytes(32).toString('base64url');
    const b = randomBytes(32).toString('base64url');
    writeFileSync(current, `${a}\n`);
    const tokens = new GatewayTokens([current, previous]);
    tokens.assertCurrentReadable();
    expect(tokens.match(a)).toBe('current');
    expect(tokens.match(b)).toBeNull();
    writeFileSync(previous, `${a}\n`);
    writeFileSync(current, `${b}\n`);
    expect(tokens.match(b)).toBe('current');
    expect(tokens.match(a)).toBe('previous');
    writeFileSync(current, 'short\n');
    expect(() => tokens.assertCurrentReadable()).toThrow(/shorter/);
    expect(tokens.match('short')).toBeNull();
  });
});

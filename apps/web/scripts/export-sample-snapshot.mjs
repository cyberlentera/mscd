#!/usr/bin/env node
// Exports the sample data of the web app (apps/web/src/data) for the demo seed (BUILD-PLAN G.1, G.2, G.8):
//
//   apps/server/src/seed/demo/sample-snapshot.json   what `mscd-server seed demo` writes into the database
//   tools/mock-providers/fixtures/demo.json          the mock Graph and Drive state that matches the seeded
//                                                    storage objects and the picker files
//
// Both files come from one in-memory computation, so the storage objects the seed writes and the provider items the
// mock serves always agree (ids, versions, hashes, folders, dates, creators). The output is deterministic, including
// the development certificate of the demo Microsoft 365 app registration, whose RSA key is derived from a fixed label
// (the seed derives the same private key, so no key file is stored anywhere). `--check` regenerates both files in
// memory and exits 1 when either differs from the committed file (CI guard against drift between sample and seed).
import { createHash, createHmac, createPrivateKey, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SAMPLE from '../src/data/mscd-data.js';
import { ORGS } from '../src/data/sample-orgs.js';
import { createSampleDataSource } from '../src/data/SampleDataSource.js';
import { TERA } from '../src/data/static.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(WEB_DIR, '..', '..');
export const SNAPSHOT_FILE = path.join(ROOT, 'apps', 'server', 'src', 'seed', 'demo', 'sample-snapshot.json');
export const FIXTURE_FILE = path.join(ROOT, 'tools', 'mock-providers', 'fixtures', 'demo.json');

const USAGE = `Usage: node apps/web/scripts/export-sample-snapshot.mjs [--check]

Writes the demo seed snapshot and the mock provider fixture from the web sample data:
  apps/server/src/seed/demo/sample-snapshot.json
  tools/mock-providers/fixtures/demo.json

  --check   regenerate both files in memory and exit 1 when either differs from the file on disk
            (nothing is written)
  --help    show this text
`;

// ---------------------------------------------------------------------------------------------------------------
// Storage layout of the demo (G.6, G.8). The repository configurations of the seed and the drives of the mock
// fixture are both built from these constants.
// ---------------------------------------------------------------------------------------------------------------

/** Label the RSA key of the demo app certificate is derived from (see `deriveRsaKey`). The seed uses the same label. */
export const M365_KEY_LABEL = 'mscd-demo-m365-app-certificate-v1';
const M365 = {
  tenantId: '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
  clientId: '2f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f',
  displayName: 'MSCD Demo Compliance Connector',
  tenantAliases: ['nusantaradigital.onmicrosoft.com'],
  certificateCommonName: 'MSCD Demo Compliance Connector',
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2035-12-31T23:59:59Z',
};
const GOOGLE = {
  clientId: 'mscd-demo-bcms.apps.googleusercontent.com',
  clientSecret: 'mscd-demo-google-client-secret',
  refreshToken: '1//mscd-demo-expired-delegated-token',
  scope: 'https://www.googleapis.com/auth/drive.file',
  account: { handle: 'tono' },
  // The repository consent callback of the api (WP-13) on the development and demo addresses.
  redirectUris: ['http://localhost:18080', 'https://localhost:18443', 'http://localhost:4174', 'http://localhost:3000'].map(
    (origin) => `${origin}/api/v1/admin/storage/repositories/oauth/callback`,
  ),
};
const DRIVES = {
  sp: {
    adapter: 'm365',
    driveId: 'drive-sp-compliance',
    siteId: 'nusantaradigital.sharepoint.com,demo-site-compliance,demo-web-compliance',
    name: 'Compliance',
    webUrl: 'https://nusantaradigital.sharepoint.com/sites/compliance/Shared%20Documents',
    root: { id: 'demo-sp-compliance', path: 'Compliance' },
    roots: {
      isms: { folderId: 'demo-sp-isms', path: 'Compliance/ISMS' },
      qms: { folderId: 'demo-sp-qms', path: 'Compliance/QMS' },
      bcms: { folderId: 'demo-sp-bcms', path: 'Compliance/BCMS' },
      abms: { folderId: 'demo-sp-abms', path: 'Compliance/ABMS' },
    },
  },
  od: {
    adapter: 'm365',
    driveId: 'drive-od-fnugroho',
    siteId: 'nusantaradigital-my.sharepoint.com,demo-site-fnugroho,demo-web-fnugroho',
    name: 'OneDrive',
    owner: { displayName: 'F. Nugroho', email: 'f.nugroho@nusantaradigital.co.id' },
    root: { id: 'demo-od-personal', path: 'Personal' },
    roots: { isms: { folderId: 'demo-od-personal', path: 'Personal' } },
  },
  gd: {
    adapter: 'google_drive',
    driveId: 'drive-gd-bcms',
    name: 'Compliance BCMS',
    root: { id: 'demo-gd-compliance-bcms', path: 'Compliance BCMS' },
    roots: { bcms: { folderId: 'demo-gd-compliance-bcms', path: 'Compliance BCMS' } },
  },
};
/** Documents of a system live in its default repository; Google Drive keeps them inside the BCMS root folder. */
const DOCUMENT_FOLDERS = { sp: (short) => `Compliance / ${short} / Documents`, gd: () => 'Compliance BCMS / Documents', vault: (short) => `/vault/${short}/Documents` };
const TIME_ZONE_OFFSET = '+07:00'; // Asia/Jakarta, the time zone of every demo organisation
const FILE_SIZE = 1024; // the mock's default size of a version without content
const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  gdoc: 'application/vnd.google-apps.document',
};
const PICKER_IDS = { sp: 'demo-sp-pick-', gd: 'demo-gd-pick-' };

// ---------------------------------------------------------------------------------------------------------------
// Deterministic RSA key and self-signed certificate of the demo app registration
// ---------------------------------------------------------------------------------------------------------------

/**
 * Byte stream of a label: block i (i = 0, 1, ...) is HMAC-SHA256(key = label, data = i as a 4-byte big-endian
 * integer). The seed (`apps/server/src/seed/demo-key.ts`) implements the same derivation.
 */
function byteStream(label) {
  let counter = 0;
  let buffer = Buffer.alloc(0);
  return (length) => {
    while (buffer.length < length) {
      const block = Buffer.alloc(4);
      block.writeUInt32BE(counter++);
      buffer = Buffer.concat([buffer, createHmac('sha256', label).update(block).digest()]);
    }
    const out = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return Buffer.from(out);
  };
}

const SMALL_PRIMES = (() => {
  const primes = [];
  for (let n = 3; primes.length < 300; n += 2) if (primes.every((p) => n % p !== 0)) primes.push(n);
  return primes.map(BigInt);
})();
const MILLER_RABIN_BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
const RSA_E = 65537n;

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function modInverse(a, m) {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

function isProbablePrime(n) {
  for (const p of SMALL_PRIMES) if (n % p === 0n) return n === p;
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1;
  }
  witness: for (const a of MILLER_RABIN_BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witness;
    }
    return false;
  }
  return true;
}

/** RSA-2048 key derived from a label: two 1024-bit primes read from `byteStream(label)` (top two bits and low bit set). */
export function deriveRsaKey(label) {
  const read = byteStream(label);
  const prime = () => {
    for (;;) {
      const bytes = read(128);
      bytes[0] |= 0xc0;
      bytes[127] |= 0x01;
      const candidate = BigInt(`0x${bytes.toString('hex')}`);
      if ((candidate - 1n) % RSA_E !== 0n && isProbablePrime(candidate)) return candidate;
    }
  };
  const p = prime();
  let q = prime();
  while (q === p) q = prime();
  const n = p * q;
  const d = modInverse(RSA_E, (p - 1n) * (q - 1n));
  const b64 = (value) => {
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return Buffer.from(hex, 'hex').toString('base64url');
  };
  return createPrivateKey({
    key: { kty: 'RSA', n: b64(n), e: b64(RSA_E), d: b64(d), p: b64(p), q: b64(q), dp: b64(d % (p - 1n)), dq: b64(d % (q - 1n)), qi: b64(modInverse(q, p)) },
    format: 'jwk',
  });
}

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const derSequence = (...parts) => der(0x30, ...parts);
function derInteger(bytes) {
  let value = Buffer.from(bytes);
  while (value.length > 1 && value[0] === 0 && value[1] < 0x80) value = value.subarray(1);
  if (value[0] >= 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return der(0x02, value);
}
function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
function derUtcTime(iso) {
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, '0');
  const text = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

/**
 * Self-signed X.509 v3 certificate (sha256WithRSAEncryption) for the demo app registration. Every field is fixed and
 * the PKCS #1 v1.5 signature is deterministic, so the certificate is the same on every run.
 */
function demoCertificate() {
  const privateKey = deriveRsaKey(M365_KEY_LABEL);
  const publicKey = createPublicKey(privateKey);
  const algorithm = derSequence(derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = derSequence(der(0x31, derSequence(derOid('2.5.4.3'), der(0x0c, Buffer.from(M365.certificateCommonName, 'utf8')))));
  const serial = createHash('sha256').update(`${M365_KEY_LABEL}:serial`).digest().subarray(0, 16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const basicConstraints = derSequence(derOid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, derSequence()));
  const tbs = derSequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(serial),
    algorithm,
    name,
    derSequence(derUtcTime(M365.notBefore), derUtcTime(M365.notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, derSequence(basicConstraints)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = derSequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  const parsed = new X509Certificate(certificatePem);
  if (!parsed.verify(publicKey)) throw new Error('The demo certificate does not verify with its own key');
  return {
    certificatePem,
    thumbprintSha256: createHash('sha256').update(parsed.raw).digest('base64url'),
    notAfter: new Date(parsed.validTo).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** A quickXorHash is 20 bytes: the first 20 bytes of the SHA-256, in base64 (28 characters). */
const quickXorOf = (text) => createHash('sha256').update(text, 'utf8').digest().subarray(0, 20).toString('base64');
/** An instant at a local time of a date in the demo time zone, as ISO UTC. */
const localInstant = (date, time = '09:00') => new Date(`${date}T${time}:00${TIME_ZONE_OFFSET}`).toISOString();
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** `29 Sep 2026` (sample display date) to `2026-09-29`. */
function isoOfDisplayDate(text) {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text);
  if (!match || !MONTHS[match[2]]) throw new Error(`Not a sample display date: ${text}`);
  return `${match[3]}-${MONTHS[match[2]]}-${match[1]}`;
}
/** `29 Sep 2026 06:00` (sample display date and time, demo time zone) to an ISO instant. */
function instantOfDisplayDateTime(text) {
  const match = /^(\d{2} [A-Z][a-z]{2} \d{4}) (\d{2}:\d{2})$/.exec(text);
  if (!match) throw new Error(`Not a sample display date and time: ${text}`);
  return localInstant(isoOfDisplayDate(match[1]), match[2]);
}
const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Email of a sample person: `<first>.<last>@nusantaradigital.co.id` from the display name (G.3). */
function emailOf(handle) {
  const person = SAMPLE.PEOPLE[handle];
  if (!person || handle === 'none') throw new Error(`Unknown sample person ${handle}`);
  return `${person[0].toLowerCase().split(/\s+/).join('.')}@nusantaradigital.co.id`;
}
function handleOfName(displayName) {
  const handle = Object.keys(SAMPLE.PEOPLE).find((h) => h !== 'none' && SAMPLE.PEOPLE[h][0] === displayName);
  if (!handle) throw new Error(`No sample person is called ${displayName}`);
  return handle;
}
const person = (handle) => ({ displayName: SAMPLE.PEOPLE[handle][0], email: emailOf(handle) });
/** Folder path in the sample's display form (`A / B / C`) to the provider form (`A/B/C`). */
const providerPath = (display) => display.split('/').map((s) => s.trim()).filter(Boolean).join('/');

/** Sample `hashAlg` text to the stored algorithm and source (C.12). */
function hashOf(hashAlg) {
  switch (hashAlg) {
    case 'quickXorHash':
      return { hashAlgorithm: 'quickxor', hashSource: 'provider' };
    case 'SHA-256':
      return { hashAlgorithm: 'sha256', hashSource: 'computed' };
    case 'SHA-256 (provider)':
      return { hashAlgorithm: 'sha256', hashSource: 'provider' };
    case 'none':
      return { hashAlgorithm: 'none', hashSource: 'none' };
    default:
      throw new Error(`Unknown sample hash algorithm ${hashAlg}`);
  }
}
/**
 * Deterministic stored hash of a record (G.6): SHA-256 of the code in hex, or for quickXorHash its first 20 bytes in
 * base64 (a quickXorHash is 20 bytes, which the mock and the m365 adapter check).
 */
function hashValueOf(algorithm, text) {
  if (algorithm === 'none') return null;
  return algorithm === 'quickxor' ? quickXorOf(text) : sha256Hex(text);
}
/** Sample `integ` to the stored link status (C.12 reverse mapping), with the reason and since (`intactSince` when intact). */
function linkStatusOf(integ, intactSince) {
  switch (integ) {
    case 'ok':
    case 'nohash':
      return { linkStatus: 'intact', linkStatusReason: null, linkStatusSince: intactSince };
    case 'pending':
      // The delegated Google token expired on 27 Sep 2026 (REPOS gd): checks fail with credential_invalid (E.4).
      return { linkStatus: 'verification_pending', linkStatusReason: 'credential_invalid', linkStatusSince: localInstant('2026-09-27', '06:00') };
    case 'changed':
      return { linkStatus: 'version_changed', linkStatusReason: null, linkStatusSince: localInstant('2026-09-29', '06:00') };
    case 'moved':
      return { linkStatus: 'moved', linkStatusReason: null, linkStatusSince: localInstant('2026-09-29', '06:00') };
    case 'missing':
      return { linkStatus: 'missing', linkStatusReason: null, linkStatusSince: localInstant('2026-09-29', '06:00') };
    case 'revoked':
      // The OneDrive account was disabled on 15 Aug 2026 (REPOS od).
      return { linkStatus: 'access_denied', linkStatusReason: null, linkStatusSince: localInstant('2026-08-15', '06:00') };
    default:
      throw new Error(`Unknown sample integrity ${integ}`);
  }
}

const DAY_MS = 86_400_000;
/** Versions of a provider item are 30 days apart, the pinned one last; the item was created an hour before the first. */
const VERSION_SPACING_MS = 30 * DAY_MS;
const createdBefore = (pinnedModifiedAt, versionCount) =>
  new Date(Date.parse(pinnedModifiedAt) - (versionCount - 1) * VERSION_SPACING_MS - 3_600_000).toISOString();

/** Version history of a provider item: ids, labels and the pinned (stored) version. */
function versionsOf(repo, code, ver, nativeGoogle) {
  if (repo === 'gd') {
    const match = /^rev (\d+)$/.exec(ver) ?? /^(\d+)(?:\.\d+)?$/.exec(ver);
    const count = match ? Math.max(1, Number(match[1])) : 1;
    const ids = Array.from({ length: count }, (_, i) => (nativeGoogle ? String(i + 1) : `demo-${code}-r${i + 1}`));
    return { ids, pinned: ids[ids.length - 1], label: `rev ${count}` };
  }
  // Microsoft Graph: ids 1.0, 2.0, ... up to the stored version (label v<id>, as the m365 adapter shows it).
  const id = ver.replace(/^v/, '');
  const major = Number.parseInt(id, 10);
  const ids = [];
  for (let i = 1; i < major; i++) ids.push(`${i}.0`);
  if (!ids.includes(id)) ids.push(id);
  return { ids, pinned: id, label: `v${id}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Storage objects of the seed and items of the mock fixture
// ---------------------------------------------------------------------------------------------------------------

/**
 * The storage objects of every evidence record and document version of the sample (keys `ev:<code>` and
 * `doc:<code>`), computed once from the snapshot of `ndt`, which runs all four systems. The other organisations reuse
 * the same records, so their storage objects point at the same provider items. Managed Vault objects have no
 * provider item; the seed names them `<vault prefix>demo-vault-<code>` per organisation.
 */
function storageObjects(snapshot) {
  const objects = {};
  const systems = snapshot.MS;
  for (const ms of systems) {
    const bundle = snapshot.bundles[ms.id];
    for (const e of bundle.evs) {
      const repo = e.loc;
      const { hashAlgorithm, hashSource } = hashOf(e.hashAlg);
      const native = repo === 'gd' && hashAlgorithm === 'none';
      const name = native ? e.code : `${e.code}.pdf`;
      const versions = repo === 'vault' ? null : versionsOf(repo, e.code, e.ver, native);
      const lastCheck = instantOfDisplayDateTime(e.lastCheck);
      const modifiedAt = localInstant(e.prod, '09:00');
      objects[`ev:${e.code}`] = {
        code: e.code,
        system: ms.id,
        repo,
        externalItemId: repo === 'vault' ? null : `demo-${repo}-${e.code}`,
        externalVersionId: versions ? versions.pinned : null,
        versionLabel: repo === 'vault' ? e.ver : versions.label,
        displayName: name,
        mimeType: native ? MIME.gdoc : MIME.pdf,
        sizeBytes: native ? null : FILE_SIZE,
        hashAlgorithm,
        hashSource,
        hashValue: hashValueOf(hashAlgorithm, e.code),
        folderPath: e.path,
        providerCreatedAt: createdBefore(modifiedAt, versions ? versions.ids.length : 1),
        providerModifiedAt: modifiedAt,
        providerModifiedBy: SAMPLE.PEOPLE[e.owner][0],
        createdBy: e.owner,
        ...linkStatusOf(e.integ, modifiedAt),
        lastVerifiedAt: lastCheck,
        lastGoodCheckAt: e.lastGoodCheck ? instantOfDisplayDateTime(e.lastGoodCheck) : null,
        mock: versions ? { integ: e.integ, versionIds: versions.ids } : null,
      };
    }
    for (const doc of bundle.docs) {
      if (doc.ver === '-') continue;
      const key = `doc:${doc.id}`;
      if (objects[key]) continue; // a shared document has one version object, in the primary system's repository
      const primary = doc.shared ? systems.find((m) => m.id === 'isms') : ms;
      const repo = primary.loc;
      const { hashAlgorithm, hashSource } = hashOf(repo === 'vault' ? 'SHA-256' : repo === 'gd' ? 'SHA-256 (provider)' : 'quickXorHash');
      const versions = repo === 'vault' ? null : versionsOf(repo, doc.id, repo === 'gd' ? 'rev 1' : doc.ver, false);
      const modified = doc.appr || addDays(doc.rev, -30);
      const modifiedAt = localInstant(modified, '09:00');
      objects[key] = {
        code: doc.id,
        system: primary.id,
        repo,
        externalItemId: repo === 'vault' ? null : `demo-${repo}-${doc.id}`,
        externalVersionId: versions ? versions.pinned : null,
        versionLabel: versions ? versions.label : `v${doc.ver}`,
        displayName: `${doc.id}.docx`,
        mimeType: MIME.docx,
        sizeBytes: FILE_SIZE,
        hashAlgorithm,
        hashSource,
        hashValue: hashValueOf(hashAlgorithm, doc.id),
        folderPath: DOCUMENT_FOLDERS[repo](primary.short),
        providerCreatedAt: createdBefore(modifiedAt, versions ? versions.ids.length : 1),
        providerModifiedAt: modifiedAt,
        providerModifiedBy: SAMPLE.PEOPLE[doc.owner][0],
        createdBy: doc.owner,
        linkStatus: 'intact',
        linkStatusReason: null,
        linkStatusSince: modifiedAt,
        lastVerifiedAt: localInstant('2026-09-29', '06:00'),
        lastGoodCheckAt: localInstant('2026-09-29', '06:00'),
        mock: versions ? { integ: 'ok', versionIds: versions.ids } : null,
      };
    }
  }
  return objects;
}

/** One mock fixture item for a storage object (G.8). Null for items the provider no longer has. */
function mockItem(object) {
  if (!object.mock || object.mock.integ === 'missing') return null;
  const { versionIds } = object.mock;
  const pinnedIndex = versionIds.indexOf(object.externalVersionId);
  const ids = [...versionIds];
  // A changed item has a newer current version; the pinned version is still listed (G.8).
  if (object.mock.integ === 'changed') ids.push(object.repo === 'gd' ? `demo-${object.code}-r${ids.length + 1}` : `${ids.length + 1}.0`);
  const creator = person(object.createdBy);
  const pinnedAt = Date.parse(object.providerModifiedAt);
  const versions = ids.map((id, index) => {
    const modifiedAt = new Date(index > pinnedIndex ? pinnedAt + DAY_MS : pinnedAt - (pinnedIndex - index) * VERSION_SPACING_MS).toISOString();
    const version = { id, modifiedAt, modifiedBy: { displayName: creator.displayName } };
    if (object.hashAlgorithm === 'none') return version;
    const hash = index === pinnedIndex ? object.hashValue : hashValueOf(object.hashAlgorithm, `${object.externalItemId}:${id}`);
    return { ...version, size: FILE_SIZE, ...(object.hashAlgorithm === 'quickxor' ? { quickXorHash: hash } : { sha256: hash }) };
  });
  return {
    id: object.externalItemId,
    path: providerPath(object.folderPath),
    name: object.displayName,
    mimeType: object.mimeType,
    createdAt: object.providerCreatedAt,
    createdBy: creator,
    versions,
  };
}

/** Picker files of a repository (PICKER_FILES), with content so the mock computes their hashes. */
function pickerItems(repo) {
  const listing = SAMPLE.PICKER_FILES[repo];
  return listing.files.map(([name, date, ver, hashAlg, creatorName], index) => {
    const creator = person(handleOfName(creatorName));
    const id = `${PICKER_IDS[repo]}${index + 1}`;
    const native = hashAlg === 'none';
    const versions = versionsOf(repo, id, ver, native);
    const iso = isoOfDisplayDate(date);
    return {
      id,
      path: providerPath(listing.path),
      name,
      ...(native ? { mimeType: MIME.gdoc } : {}),
      createdAt: localInstant(addDays(iso, -7 * (versions.ids.length - 1)), '08:00'),
      createdBy: creator,
      versions: versions.ids.map((versionId, i) => ({
        id: versionId,
        modifiedAt: localInstant(addDays(iso, -7 * (versions.ids.length - 1 - i)), '09:00'),
        modifiedBy: { displayName: creator.displayName },
        ...(native ? {} : { content: `${name}, version ${i + 1} (MSCD demo file)` }),
      })),
    };
  });
}

function mockFixture(objects, certificate) {
  const itemsOf = (repo) =>
    Object.keys(objects)
      .filter((key) => objects[key].repo === repo)
      .map((key) => mockItem(objects[key]))
      .filter((item) => item !== null);
  const folders = (drive) => [drive.root, ...Object.values(drive.roots).map((root) => ({ id: root.folderId, path: root.path }))]
    .filter((folder, i, all) => all.findIndex((f) => f.id === folder.id) === i)
    .map((folder) => ({ id: folder.id, path: folder.path }));
  const account = person(GOOGLE.account.handle);
  return {
    version: 1,
    description:
      'Demo fixture of the MSCD seed (BUILD-PLAN G.8), written by apps/web/scripts/export-sample-snapshot.mjs: the SharePoint ' +
      'library with the ISMS evidence and documents and the picker files, the disabled OneDrive of F. Nugroho, and the BCMS Shared ' +
      'Drive whose delegated token has expired. Do not edit by hand.',
    credentials: [
      {
        kind: 'm365_certificate',
        tenantId: M365.tenantId,
        clientId: M365.clientId,
        certificatePem: certificate.certificatePem,
        displayName: M365.displayName,
        tenantAliases: M365.tenantAliases,
      },
      { kind: 'google_oauth_client', clientId: GOOGLE.clientId, clientSecret: GOOGLE.clientSecret, redirectUris: GOOGLE.redirectUris, defaultAccount: account },
      { kind: 'google_refresh_token', clientId: GOOGLE.clientId, refreshToken: GOOGLE.refreshToken, account, scope: GOOGLE.scope, revoked: true },
    ],
    m365: {
      drives: [
        {
          id: DRIVES.sp.driveId,
          name: DRIVES.sp.name,
          driveType: 'documentLibrary',
          tenantId: M365.tenantId,
          webUrl: DRIVES.sp.webUrl,
          folders: folders(DRIVES.sp),
          items: [...itemsOf('sp'), ...pickerItems('sp')],
        },
        {
          id: DRIVES.od.driveId,
          name: DRIVES.od.name,
          driveType: 'personal',
          tenantId: M365.tenantId,
          owner: DRIVES.od.owner,
          forbidden: true,
          folders: folders(DRIVES.od),
          items: itemsOf('od'),
        },
      ],
    },
    google: {
      drives: [
        {
          id: DRIVES.gd.driveId,
          name: DRIVES.gd.name,
          kind: 'shared_drive',
          folders: folders(DRIVES.gd),
          items: [...itemsOf('gd'), ...pickerItems('gd')],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot (G.2)
// ---------------------------------------------------------------------------------------------------------------

/** A sample snapshot with the record objects of `ChainItem.ref` and `Activity.doc` replaced by record keys. */
function plainSnapshot(snapshot) {
  const bundles = {};
  for (const [ms, bundle] of Object.entries(snapshot.bundles)) {
    bundles[ms] = {
      ...bundle,
      chain: { ...bundle.chain, items: bundle.chain.items.map((item) => ({ ...item, ref: item.ref ? item.key : undefined })) },
      phases: bundle.phases.map((phase) => ({
        ...phase,
        acts: phase.acts.map((act) => ({ ...act, doc: act.doc ? `${ms}:doc:${act.doc.id}` : null })),
      })),
    };
  }
  return { ...snapshot, bundles };
}

async function build() {
  const snapshots = {};
  for (const org of ORGS) {
    const source = createSampleDataSource({ org: org.id });
    snapshots[org.id] = plainSnapshot(await source.load(org.id));
  }
  // The first organisation runs every system of the sample; the others reuse the same records.
  const full = snapshots[ORGS[0].id];
  if (full.MS.length !== SAMPLE.MS.length) throw new Error(`Organisation ${ORGS[0].id} does not run every sample system`);
  const certificate = demoCertificate();
  const objects = storageObjects(full);
  const byMs = (pick) => Object.fromEntries(SAMPLE.MS.map((ms) => [ms.id, pick(ms)]).filter(([, value]) => value !== undefined));
  const sampleSnapshot = {
    today: SAMPLE.TODAY_S,
    orgs: ORGS,
    snapshots,
    raw: {
      PHASES: SAMPLE.PHASES,
      PHASE_STATE: SAMPLE.PHASE_STATE,
      OUTPUT_MAP: SAMPLE.OUTPUT_MAP,
      PICKER_FILES: SAMPLE.PICKER_FILES,
      FREQ: SAMPLE.FREQ,
      TERA_KEYS: Object.keys(TERA),
    },
    literals: {
      gateName: byMs((ms) => ms.gateName),
      gtSuggestions: byMs((ms) => ms.gtSuggestions),
      docApprover: byMs((ms) => ms.approver),
    },
    storage: {
      m365: { tenantId: M365.tenantId, clientId: M365.clientId, keyLabel: M365_KEY_LABEL, certificatePem: certificate.certificatePem, thumbprintSha256: certificate.thumbprintSha256, notAfter: certificate.notAfter },
      google: { clientId: GOOGLE.clientId, clientSecret: GOOGLE.clientSecret, refreshToken: GOOGLE.refreshToken, account: person(GOOGLE.account.handle) },
      drives: Object.fromEntries(
        Object.entries(DRIVES).map(([slug, drive]) => [
          slug,
          {
            adapter: drive.adapter,
            driveId: drive.driveId,
            ...(drive.siteId ? { siteId: drive.siteId } : {}),
            rootFolderId: drive.root.id,
            roots: drive.roots,
          },
        ]),
      ),
      objects,
    },
  };
  return {
    [SNAPSHOT_FILE]: `${JSON.stringify(sampleSnapshot, null, 1)}\n`,
    [FIXTURE_FILE]: `${JSON.stringify(mockFixture(objects, certificate), null, 2)}\n`,
  };
}

async function main(args) {
  let check = false;
  for (const arg of args) {
    if (arg === '--check') check = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`export-sample-snapshot: unknown option ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  const files = await build();
  const relative = (file) => path.relative(ROOT, file);
  if (check) {
    const different = Object.entries(files)
      .filter(([file, text]) => !existsSync(file) || readFileSync(file, 'utf8') !== text)
      .map(([file]) => relative(file));
    if (different.length > 0) {
      process.stderr.write(
        `export-sample-snapshot: out of date: ${different.join(', ')}\n` +
          'Run node apps/web/scripts/export-sample-snapshot.mjs and commit the result.\n',
      );
      return 1;
    }
    process.stdout.write(`export-sample-snapshot: ${Object.keys(files).map(relative).join(' and ')} match the sample\n`);
    return 0;
  }
  for (const [file, text] of Object.entries(files)) {
    if (existsSync(file) && readFileSync(file, 'utf8') === text) {
      process.stdout.write(`export-sample-snapshot: ${relative(file)} unchanged\n`);
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, text);
    renameSync(temporary, file);
    process.stdout.write(`export-sample-snapshot: wrote ${relative(file)} (${Buffer.byteLength(text)} bytes)\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`export-sample-snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

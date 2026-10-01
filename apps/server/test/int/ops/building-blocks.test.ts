// Building blocks of WP-34 without a database: the log ring buffer and its pino tap, the secret scrubber of the
// diagnostics archive, and collected and derived metrics on a registry.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { Counter, Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { MscdConfig } from '../../../src/config/mscd-config';
import { LogRing, tapPinoLogger } from '../../../src/modules/observability/log-ring';
import { CollectedMetric, ensureCounter, ensureGauge, registerCollected, registerDerived } from '../../../src/modules/observability/metric-catalogue';
import { LOG_REDACT_PATHS, REDACTED, serializeRequest } from '../../../src/modules/platform/logging';
import { SecretScrubber, redactQueryValues, secretFilesOf } from '../../../src/modules/ops/secret-scrubber';
import { TEST_PROFILE_FILE } from '../../setup/test-db';

describe('log ring buffer', () => {
  it('keeps the newest lines up to its capacity, oldest first, and cuts long lines', () => {
    const ring = new LogRing(3, 10);
    ring.push('a\nb\n');
    ring.push(Buffer.from('c\n'));
    ring.push('d\n\n');
    expect(ring.lines()).toEqual(['b', 'c', 'd']);
    ring.push('x'.repeat(25));
    expect(ring.lines().at(-1)).toBe(`${'x'.repeat(10)}...[cut]`);
    expect(ring.size).toBe(3);
    ring.clear();
    expect(ring.lines()).toEqual([]);
  });

  it('copies the redacted lines a pino logger writes, once per stream', () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        written.push(chunk.toString('utf8'));
        done();
      },
    });
    const logger = pino({ redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED }, serializers: { req: serializeRequest } }, sink);
    const ring = new LogRing(1000);
    expect(tapPinoLogger(logger, ring)).toBe(true);
    expect(tapPinoLogger(logger, ring)).toBe(true);
    logger.child({ requestId: 'r1' }).warn({ req: { method: 'GET', url: '/cb?code=oidc-123456&state=s-987654' }, user: { password: 'hunter2-secret' } }, 'callback');
    expect(ring.lines()).toHaveLength(1);
    expect(written).toHaveLength(1);
    const line = ring.lines()[0]!;
    expect(line).toContain('/cb?code=[redacted]&state=[redacted]');
    expect(line).not.toContain('hunter2-secret');
    expect(line).not.toContain('oidc-123456');
    expect(tapPinoLogger(undefined, ring)).toBe(false);
  });

  it('holds at most 1,000 lines by default', () => {
    const ring = new LogRing();
    for (let i = 0; i < 1500; i += 1) ring.push(`{"n":${i}}\n`);
    expect(ring.lines()).toHaveLength(1000);
    expect(ring.lines()[0]).toBe('{"n":500}');
  });
});

describe('secret scrubber', () => {
  it('lists every secret file of the test profile', () => {
    const config = MscdConfig.load({ runMode: 'api', env: { MSCD_PROFILE_FILE: TEST_PROFILE_FILE } });
    const files = secretFilesOf(config.profile, config.profileFile).map((f) => path.basename(f));
    for (const name of ['platform.key', 'gateway.token', 'db-app.url', 'db-migrator.url', 'db-pack.url', 'db-admin.url', 'audit-anchor.key', 'storage.key', 's3.access', 's3.secret']) {
      expect(files, name).toContain(name);
    }
  });

  it('removes secret file contents, secret variables, URL passwords, token query values and secret JSON members', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp34-'));
    const keyFile = path.join(dir, 'k.pem');
    writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAbcdefghijklmnop\n-----END PRIVATE KEY-----\n');
    const tokenFile = path.join(dir, 'gw.token');
    writeFileSync(tokenFile, 'gateway-token-value-123\n');
    const config = MscdConfig.load({
      runMode: 'api',
      env: {
        MSCD_PROFILE_FILE: TEST_PROFILE_FILE,
        MSCD__AUDIT__ANCHOR_KEY_FILE: keyFile,
        MSCD__STORAGE__GATEWAY__TOKEN_FILE: tokenFile,
        MSCD_DATABASE_URL: 'postgres://mscd_app:p%40ss-word-42@db:5432/mscd',
        MSCD_SMTP_PASSWORD: 'smtp-password-77',
      },
    });
    const scrubber = SecretScrubber.forConfig(config);
    const text = [
      'key MC4CAQAwBQYDK2VwBCIEIAbcdefghijklmnop',
      'token gateway-token-value-123',
      'url postgres://mscd_app:p%40ss-word-42@db:5432/mscd and decoded p@ss-word-42',
      'smtp smtp-password-77',
      'other redis://:valkey-pass-1@valkey:6379',
      'cb https://x/callback?state=abcdef&code=zyxwvu&keep=1',
      '{"password":"pw-1234567","name":"ok","clientSecret":"cs-123456"}',
      '-----BEGIN PRIVATE KEY-----',
    ].join('\n');
    const out = scrubber.scrub(text);
    for (const secret of ['MC4CAQAwBQYDK2VwBCIEIAbcdefghijklmnop', 'gateway-token-value-123', 'p%40ss-word-42', 'p@ss-word-42', 'smtp-password-77', 'valkey-pass-1', 'abcdef', 'zyxwvu', 'pw-1234567', 'cs-123456']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('keep=1');
    expect(out).toContain('"name":"ok"');
    expect(out).toContain('-----BEGIN PRIVATE KEY-----');
    expect(redactQueryValues('/x?t=abc&invitation=def&page=2')).toBe('/x?t=[redacted]&invitation=[redacted]&page=2');
  });
});

describe('collected and derived metrics', () => {
  it('renders collected samples, survives a failing source and replaces an earlier registration', async () => {
    const registry = new Registry();
    const def = { name: 'mscd_test_gauge', help: 'test', type: 'gauge', labelNames: ['k'] } as const;
    registerCollected(registry, def, () => [{ labels: { k: 'a' }, value: 2 }]);
    expect(await registry.metrics()).toContain('mscd_test_gauge{k="a"} 2');
    registerCollected(registry, def, () => {
      throw new Error('source down');
    });
    const text = await registry.metrics();
    expect(text).toContain('# TYPE mscd_test_gauge gauge');
    expect(text).not.toContain('mscd_test_gauge{');
    expect(registry.getSingleMetric('mscd_test_gauge')).toBeInstanceOf(CollectedMetric);
    new Counter({ name: 'mscd_plain_total', help: 'x', registers: [registry] });
    expect(() => registerCollected(registry, { name: 'mscd_plain_total', help: 'x', type: 'counter', labelNames: [] }, () => [])).toThrow(/not a collected metric/);
  });

  it('derives a filtered slice, sums samples that become equal and returns the same instrumented metric twice', async () => {
    const registry = new Registry();
    registry.setDefaultLabels({ mode: 'api' });
    const source = new Counter({ name: 'src_total', help: 's', labelNames: ['job', 'outcome', 'try'], registers: [registry] });
    registerDerived(registry, { name: 'derived_total', help: 'd', type: 'counter', labelNames: ['job'] }, { name: 'src_total', where: { outcome: 'failed' }, dropLabels: ['outcome', 'try'] });
    source.inc({ job: 'a', outcome: 'failed', try: '1' });
    source.inc({ job: 'a', outcome: 'failed', try: '2' }, 2);
    source.inc({ job: 'a', outcome: 'succeeded', try: '1' });
    const text = await registry.metrics();
    expect(text).toContain('derived_total{job="a",mode="api"} 3');
    const def = { name: 'mscd_same_total', help: 'h', type: 'counter', labelNames: ['x'] } as const;
    expect(ensureCounter(registry, def)).toBe(ensureCounter(registry, def));
    expect(() => ensureGauge(registry, { ...def, type: 'gauge' })).toThrow(/another type/);
  });
});

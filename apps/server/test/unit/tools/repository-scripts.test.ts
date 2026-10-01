// Tests of the repository scripts in tools/scripts (WP-03), run with the server unit tests because tools/scripts
// is not a workspace of its own.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const TOOLS = path.resolve(__dirname, '../../../../../tools/scripts');
const node = (script: string, args: string[]) => run(process.execPath, [path.join(TOOLS, script), ...args]);

describe('demo-totp.mjs (G.3)', () => {
  it('passes the RFC 6238 SHA-1 vectors', async () => {
    const { stdout } = await node('demo-totp.mjs', ['--self-test']);
    expect(stdout).toMatch(/pass/);
  });

  it('prints a 32 character base32 secret and a 6 digit code for a handle', async () => {
    const secret = (await node('demo-totp.mjs', ['rina', '--secret'])).stdout.trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const code = (await node('demo-totp.mjs', ['rina'])).stdout.trim();
    expect(code).toMatch(/^[0-9]{6}$/);
  });

  it('gives the same code within one 30 second step and per handle', async () => {
    const at = async (handle: string, time: number) => (await node('demo-totp.mjs', [handle, '--time', String(time)])).stdout.trim();
    expect(await at('rina', 1_790_000_010)).toBe(await at('rina', 1_790_000_019));
    expect(await at('rina', 1_790_000_010)).not.toBe(await at('bagus', 1_790_000_010));
  });

  it('refuses a missing or malformed handle', async () => {
    await expect(node('demo-totp.mjs', [])).rejects.toMatchObject({ code: 2 });
    await expect(node('demo-totp.mjs', ['Not A Handle'])).rejects.toMatchObject({ code: 2 });
  });
});

describe('check-text.mjs (R-08)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-check-text-'));
    await mkdir(path.join(dir, 'clean'));
    await writeFile(path.join(dir, 'clean', 'a.md'), 'Plain text - with a hyphen.\n');
    await mkdir(path.join(dir, 'dirty', 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'dirty', 'sub', 'b.md'), 'line one\nan em dash \u2014 here\nand a centre dot \u00b7 there\n');
    await writeFile(path.join(dir, 'dirty', 'image.bin'), Buffer.from([0, 0xe2, 0x80, 0x94]));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('passes a folder without the two characters', async () => {
    const { stdout } = await node('check-text.mjs', [path.join(dir, 'clean')]);
    expect(stdout).toMatch(/1 file\(s\) checked/);
  });

  it('fails and prints file, line and column of every occurrence, skipping binary files', async () => {
    const failure = await node('check-text.mjs', [path.join(dir, 'dirty')]).catch((error: { code: number; stdout: string }) => error);
    expect(failure).toMatchObject({ code: 1 });
    const file = path.join(dir, 'dirty', 'sub', 'b.md');
    expect((failure as { stdout: string }).stdout).toBe(`${file}:2:12: U+2014 (em dash)\n${file}:3:18: U+00B7 (centre dot)\n`);
  });

  it('needs at least one existing folder or file', async () => {
    await expect(node('check-text.mjs', [])).rejects.toMatchObject({ code: 2 });
    await expect(node('check-text.mjs', [path.join(dir, 'missing')])).rejects.toMatchObject({ code: 2 });
  });
});

// C.3 step 5 (`migrate` installs the packs of `packs.dir` as mscd_pack_installer) and `mscd-server packs install`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { packsInstall } from '../../../src/cli/packs';
import { runMigrate } from '../../../src/cli/migrate';
import { MscdConfig } from '../../../src/config/mscd-config';
import { buildProgram } from '../../../src/program';
import { TEST_PROFILE_FILE } from '../../setup/test-db';
import { connect, createBareDatabase, type BareDatabase } from '../db/helpers';
import { DEV_PACK_IDS, archiveEntries, archiveOf, changedPack, devPack } from './fixtures';

describe('migrate step 5 and packs install (C.3, D-17)', () => {
  let bare: BareDatabase;
  let dir: string;
  const configFor = (env: Record<string, string> = {}) =>
    MscdConfig.load({
      runMode: 'migrate',
      env: {
        PATH: process.env.PATH,
        MSCD_PROFILE_FILE: TEST_PROFILE_FILE,
        MSCD_DATABASE_MIGRATOR_URL: bare.urls.migrator,
        MSCD_DATABASE_PACK_URL: bare.urls.packInstaller,
        MSCD__PACKS__DIR: dir,
        MSCD__OBSERVABILITY__METRICS_PORT: 'null',
        ...env,
      },
    });

  beforeAll(async () => {
    bare = await createBareDatabase();
    dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-packs-'));
    for (const id of DEV_PACK_IDS) await writeFile(path.join(dir, devPack(id).fileName), devPack(id).bytes);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await bare?.drop();
  });

  it('installs every pack of packs.dir after the migrations, and nothing on the next run', async () => {
    const out: string[] = [];
    expect(await runMigrate(configFor(), { out: (t) => out.push(t) })).toBe(0);
    const text = out.join('');
    for (const id of DEV_PACK_IDS) expect(text).toContain(`migrate: packs: ${id} ${devPack(id).manifest.pack_version}: installed`);
    expect(text).toContain('migrate: packs 6 installed, 0 already installed, 0 older than installed, 0 rejected, 0 failed');

    const db = connect(bare.urls.migrator);
    try {
      const { rows } = await sql<{ n: string }>`select count(*) as n from platform.pack_install where status = 'installed'`.execute(db);
      expect(rows[0]!.n).toBe('6');
    } finally {
      await db.destroy();
    }

    const again: string[] = [];
    expect(await runMigrate(configFor(), { out: (t) => again.push(t) })).toBe(0);
    expect(again.join('')).toContain('migrate: packs 0 installed, 6 already installed, 0 older than installed, 0 rejected, 0 failed');
  });

  it('skips a pack older than the installed version without an audit entry, and exits 0', async () => {
    // After an update imported through POST /admin/packs/import, the image's packs.dir still ships the older version.
    const older = changedPack('ISO27001-2022', (s) => {
      s.manifest.pack_version = '1.0.0';
    });
    await writeFile(path.join(dir, older.fileName), older.bytes);
    const db = connect(bare.urls.migrator);
    const rejections = async () =>
      (await sql<{ n: string }>`select count(*) as n from platform.audit_log where action = 'pack.rejected'`.execute(db)).rows[0]!.n;
    const out: string[] = [];
    try {
      const before = await rejections();
      expect(await runMigrate(configFor(), { out: (t) => out.push(t) })).toBe(0);
      expect(await rejections()).toBe(before);
    } finally {
      await rm(path.join(dir, older.fileName));
      await db.destroy();
    }
    const text = out.join('');
    expect(text).toContain('migrate: packs: ISO27001-2022 1.0.0: skipped (older than the installed version 1.2.0)');
    expect(text).toContain('migrate: packs 0 installed, 6 already installed, 1 older than installed, 0 rejected, 0 failed');
    expect(text).not.toContain('not installed');
  });

  it('reports a pack it refuses and exits 1, after installing the others', async () => {
    const newer = changedPack('ISO37001-2016', (s) => {
      s.manifest.pack_version = '1.0.1';
    });
    const tampered = archiveOf(archiveEntries(newer.bytes).map((e) => (e.path === 'chain.csv' ? { ...e, data: Buffer.concat([e.data!, Buffer.from('x')]) } : e)));
    await writeFile(path.join(dir, 'AAA-tampered.pack'), tampered);
    await writeFile(path.join(dir, newer.fileName), newer.bytes);
    const out: string[] = [];
    try {
      expect(await runMigrate(configFor(), { out: (t) => out.push(t) })).toBe(1);
    } finally {
      await rm(path.join(dir, 'AAA-tampered.pack'));
      await rm(path.join(dir, newer.fileName));
    }
    const text = out.join('');
    expect(text).toMatch(/migrate: packs: AAA-tampered\.pack: rejected \(pack ISO37001-2016 1\.0\.1: datasets do not match their checksums/);
    expect(text).toContain('migrate: packs: ISO37001-2016 1.0.1: installed');
    expect(text).toContain('migrate: packs 1 installed, 6 already installed, 0 older than installed, 1 rejected, 0 failed');
    expect(text).toContain('migrate: 1 pack(s) not installed: AAA-tampered.pack');
  });

  it('refuses a pack installer URL of another database, and does nothing for a missing packs folder', async () => {
    await expect(
      runMigrate(configFor({ MSCD_DATABASE_PACK_URL: bare.urls.packInstaller.replace(`/${bare.name}`, '/postgres') }), { out: () => undefined }),
    ).rejects.toThrow(/both roles must connect to the same database/);
    const out: string[] = [];
    expect(await runMigrate(configFor({ MSCD__PACKS__DIR: path.join(dir, 'missing'), MSCD_DATABASE_PACK_URL: 'postgres://nobody@127.0.0.1:1/none' }), { out: (t) => out.push(t) })).toBe(0);
    expect(out.join('')).not.toContain('packs');
  });

  it('installs one pack file with `packs install` and refuses a tampered one', async () => {
    const newer = changedPack('ISO22301-2019', (s) => {
      s.manifest.pack_version = '1.0.1';
    });
    const file = path.join(dir, 'newer', newer.fileName);
    await rm(path.dirname(file), { recursive: true, force: true });
    await mkdir(path.dirname(file));
    await writeFile(file, newer.bytes);
    const config = configFor();
    const out: string[] = [];
    expect(await packsInstall(config, file, (t) => out.push(t))).toMatchObject({ status: 'installed', packId: 'ISO22301-2019', version: '1.0.1' });
    expect(await packsInstall(config, file, (t) => out.push(t))).toMatchObject({ status: 'unchanged' });
    expect(out).toEqual(['packs install: ISO22301-2019 1.0.1: installed\n', 'packs install: ISO22301-2019 1.0.1: unchanged\n']);

    const tampered = path.join(dir, 'newer', 'tampered.pack');
    await writeFile(
      tampered,
      archiveOf(archiveEntries(newer.bytes).map((e) => (e.path === 'chain.csv' ? { ...e, data: Buffer.concat([e.data!, Buffer.from('x')]) } : e))),
    );
    expect(await packsInstall(config, tampered, () => undefined)).toMatchObject({ status: 'rejected' });

    // The command line exits 1 for a refused pack.
    vi.stubEnv('MSCD_PROFILE_FILE', TEST_PROFILE_FILE);
    vi.stubEnv('MSCD_DATABASE_PACK_URL', bare.urls.packInstaller);
    vi.stubEnv('MSCD_DATABASE_PACK_URL_FILE', '');
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(buildProgram().parseAsync(['node', 'mscd-server', 'packs', 'install', tampered])).rejects.toThrow('exit 1');
      await buildProgram().parseAsync(['node', 'mscd-server', 'packs', 'install', file]);
      expect(write).toHaveBeenCalledWith('packs install: ISO22301-2019 1.0.1: unchanged\n');
    } finally {
      exit.mockRestore();
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

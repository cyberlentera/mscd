// Commands of the CLI `mscd-pack` (build plan WP-09). `runCli` takes the arguments after the program name and
// returns the exit code: 0 success, 1 a build, signing or verification failure, 2 a usage error.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { DEFAULT_SOURCES_DIR, buildAllPacks, writeFileAtomic } from './build-all.js';
import { datasetCounts } from './datasets.js';
import { DEV_KEY_IDS } from './dev-key-ids.js';
import { LicenceError, PackError } from './errors.js';
import { generateSigningKeyPair, loadPublicKey, loadSigningKey, type SigningKey } from './keys.js';
import { signLicence, verifyLicence } from './licence.js';
import { buildPack, verifyPack } from './pack.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** A failure that the CLI reports as one message with exit code 1. */
class CliFailure extends Error {}

const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readInput(file: string, what: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new CliFailure(`cannot read ${what} ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
}

function readSigningKey(file: string): SigningKey {
  try {
    return loadSigningKey(readInput(file, 'key file'));
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new CliFailure(`${file}: ${(error as Error).message}`);
  }
}

function readTrustedKeys(files: readonly string[]) {
  return files.map((file) => {
    try {
      return loadPublicKey(readInput(file, 'trusted key'));
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      throw new CliFailure(`${file}: ${(error as Error).message}`);
    }
  });
}

function devMark(keyId: string): string {
  return DEV_KEY_IDS.includes(keyId) ? ' (development key)' : '';
}

/** Key ids refused by `--reject-dev-keys`; refuses to run when the list is unavailable (fail closed). */
function rejectedIds(rejectDevKeys: boolean | undefined): readonly string[] {
  if (!rejectDevKeys) return [];
  if (DEV_KEY_IDS.length === 0) {
    throw new CliFailure('--reject-dev-keys needs packages/pack-tools/dev-keys/dev-key-ids.json, which is missing; development keys cannot be refused without it');
  }
  return DEV_KEY_IDS;
}

const rejectDevKeysOption = () =>
  new Option('--reject-dev-keys', 'refuse development keys (the ids in dev-keys/dev-key-ids.json), as a release build does');

function buildProgram(io: CliIo): Command {
  const program = new Command('mscd-pack')
    .description('Build, sign and verify MSCD framework packs and licences')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .showHelpAfterError(false);

  program
    .command('keygen')
    .description('Generate an Ed25519 key pair: <name>.key (PKCS#8 PEM, mode 0600) and <name>.pub (SPKI PEM)')
    .requiredOption('--out <dir>', 'output directory (created when missing)')
    .requiredOption('--name <name>', 'file name without extension, for example pack-signing')
    .option('--force', 'overwrite existing files')
    .action((opts: { out: string; name: string; force?: boolean }) => {
      if (!KEY_NAME_RE.test(opts.name)) throw new CliFailure(`--name ${JSON.stringify(opts.name)} must be letters, digits, ".", "_" or "-"`);
      const keyFile = path.join(opts.out, `${opts.name}.key`);
      const pubFile = path.join(opts.out, `${opts.name}.pub`);
      if (!opts.force) {
        for (const file of [keyFile, pubFile]) if (existsSync(file)) throw new CliFailure(`${file} exists; pass --force to replace it`);
      }
      mkdirSync(opts.out, { recursive: true });
      const pair = generateSigningKeyPair();
      writeFileAtomic(keyFile, pair.privateKeyPem, 0o600);
      writeFileAtomic(pubFile, pair.publicKeyPem, 0o644);
      io.stdout(`key ${pair.keyId}\n  private ${keyFile}\n  public  ${pubFile}\n`);
    });

  program
    .command('build')
    .description('Build and sign one pack from a source folder')
    .argument('<sourceDir>', 'pack source folder (packs/sources/<pack-id>)')
    .requiredOption('--sign-key-file <pem>', 'Ed25519 private key (PEM)')
    .requiredOption('--out <dir>', 'output directory')
    .addOption(rejectDevKeysOption())
    .action((sourceDir: string, opts: { signKeyFile: string; out: string; rejectDevKeys?: boolean }) => {
      const key = readSigningKey(opts.signKeyFile);
      const pack = buildPack(sourceDir, key.privateKey, { rejectKeyIds: rejectedIds(opts.rejectDevKeys) });
      mkdirSync(opts.out, { recursive: true });
      const file = path.join(opts.out, pack.fileName);
      writeFileAtomic(file, pack.bytes);
      io.stdout(`${file} sha256 ${pack.sha256} key ${pack.keyId}${devMark(pack.keyId)}\n`);
    });

  program
    .command('build-all')
    .description('Build and sign every pack under packs/sources; other .pack files in the output directory are removed')
    .requiredOption('--sign-key-file <pem>', 'Ed25519 private key (PEM)')
    .requiredOption('--out <dir>', 'output directory, for example packs/dist')
    .option('--sources <dir>', 'pack sources folder', DEFAULT_SOURCES_DIR)
    .addOption(rejectDevKeysOption())
    .action((opts: { signKeyFile: string; out: string; sources: string; rejectDevKeys?: boolean }) => {
      const key = readSigningKey(opts.signKeyFile);
      const result = buildAllPacks(opts.sources, key.privateKey, opts.out, { rejectKeyIds: rejectedIds(opts.rejectDevKeys) });
      for (const pack of result.packs) io.stdout(`${pack.file} sha256 ${pack.sha256}\n`);
      for (const file of result.removed) io.stdout(`removed ${file}\n`);
      io.stdout(`${result.packs.length} packs signed with key ${key.keyId}${devMark(key.keyId)}\n`);
    });

  program
    .command('verify')
    .description('Verify a pack archive: archive rules, signature, checksums and datasets')
    .argument('<file>', 'pack file')
    .requiredOption('--trusted <pub...>', 'trusted Ed25519 public keys (PEM)')
    .addOption(rejectDevKeysOption())
    .action((file: string, opts: { trusted: string[]; rejectDevKeys?: boolean }) => {
      const trusted = readTrustedKeys(opts.trusted);
      const pack = verifyPack(readInput(file, 'pack'), trusted, { rejectKeyIds: rejectedIds(opts.rejectDevKeys) });
      const m = pack.manifest;
      const flags = [m.status, ...(m.pre_release ? ['pre-release'] : [])].join(', ');
      const counts = Object.entries(datasetCounts(pack.datasets)).map(([name, n]) => `${name} ${n}`).join(', ');
      io.stdout(`OK ${file}: ${m.pack_id} ${m.pack_version} (${flags}) signed with key ${pack.keyId}${devMark(pack.keyId)}\n  ${counts}\n`);
    });

  const licence = program.command('licence').description('Sign and verify licence documents');
  licence
    .command('sign')
    .description('Sign a licence document (sets key_id, replaces signature); prints the signed JSON unless --out is given')
    .argument('<json>', 'licence JSON file')
    .requiredOption('--key-file <pem>', 'Ed25519 private key (PEM)')
    .option('--out <file>', 'write the signed licence to this file')
    .addOption(rejectDevKeysOption())
    .action((file: string, opts: { keyFile: string; out?: string; rejectDevKeys?: boolean }) => {
      const key = readSigningKey(opts.keyFile);
      const signed = signLicence(readInput(file, 'licence'), key.privateKey, { rejectKeyIds: rejectedIds(opts.rejectDevKeys) });
      const text = `${JSON.stringify(signed, null, 2)}\n`;
      if (opts.out) {
        writeFileAtomic(opts.out, text);
        io.stdout(`${opts.out}: ${signed.license_id} signed with key ${key.keyId}${devMark(key.keyId)}\n`);
      } else {
        io.stdout(text);
      }
    });
  licence
    .command('verify')
    .description('Verify a signed licence document: schema, key, signature and binding')
    .argument('<json>', 'licence JSON file')
    .requiredOption('--trusted <pub...>', 'trusted Ed25519 public keys (PEM)')
    .addOption(rejectDevKeysOption())
    .action((file: string, opts: { trusted: string[]; rejectDevKeys?: boolean }) => {
      const trusted = readTrustedKeys(opts.trusted);
      const result = verifyLicence(readInput(file, 'licence'), trusted, { rejectKeyIds: rejectedIds(opts.rejectDevKeys) });
      const d = result.document;
      const binding = result.binding.kind === 'trial' ? 'unbound trial' : `bound to ${result.binding.kind} ${result.binding.id}`;
      io.stdout(`OK ${file}: ${d.license_id} for ${d.organization}, ${binding}, valid ${d.valid_from} to ${d.valid_until} (grace ${d.grace_days} days), signed with key ${result.keyId}${devMark(result.keyId)}\n`);
    });

  return program;
}

/** Runs `mscd-pack` with the arguments after the program name and returns the exit code. */
export function runCli(argv: readonly string[], io: CliIo = processIo): number {
  const program = buildProgram(io);
  try {
    program.parse([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version output exit 0; every other commander error is a usage error.
      return error.exitCode === 0 ? 0 : 2;
    }
    const command = argv.filter((a) => !a.startsWith('-')).slice(0, argv[0] === 'licence' ? 2 : 1).join(' ');
    if (error instanceof PackError || error instanceof LicenceError || error instanceof CliFailure) {
      io.stderr(`mscd-pack ${command}: ${error.message}\n`);
      return 1;
    }
    // System errors (a folder that cannot be written, for example) need no stack; anything else is a defect.
    const systemError = typeof (error as NodeJS.ErrnoException).code === 'string';
    io.stderr(`mscd-pack ${command}: ${systemError ? (error as Error).message : ((error as Error).stack ?? String(error))}\n`);
    return 1;
  }
}

#!/usr/bin/env node
// CLI `mscd-pack` (build plan WP-09). The commands exist so their help is stable; each prints "not implemented"
// and exits 2 until WP-09 implements it.
import { Command } from 'commander';

function notImplemented(name: string): () => never {
  return () => {
    process.stderr.write(`mscd-pack ${name}: not implemented in this build yet (WP-09)\n`);
    process.exit(2);
  };
}

const program = new Command('mscd-pack').description('Build, sign and verify MSCD framework packs and licences');

program
  .command('keygen')
  .description('Generate an Ed25519 key pair (<name>.key and <name>.pub)')
  .requiredOption('--out <dir>', 'output directory')
  .requiredOption('--name <name>', 'file name without extension')
  .action(notImplemented('keygen'));

program
  .command('build')
  .description('Build and sign one pack from a source folder')
  .argument('<sourceDir>', 'pack source folder (packs/sources/<pack-id>)')
  .requiredOption('--sign-key-file <pem>', 'Ed25519 private key (PEM)')
  .requiredOption('--out <dir>', 'output directory')
  .action(notImplemented('build'));

program
  .command('build-all')
  .description('Build and sign every pack under packs/sources')
  .requiredOption('--sign-key-file <pem>', 'Ed25519 private key (PEM)')
  .requiredOption('--out <dir>', 'output directory, for example packs/dist')
  .action(notImplemented('build-all'));

program
  .command('verify')
  .description('Verify a pack archive against trusted public keys')
  .argument('<file>', 'pack file')
  .requiredOption('--trusted <pub...>', 'trusted Ed25519 public keys (PEM)')
  .action(notImplemented('verify'));

const licence = program.command('licence').description('Sign and verify licence documents');
licence
  .command('sign')
  .description('Sign a licence document')
  .argument('<json>', 'licence JSON file')
  .requiredOption('--key-file <pem>', 'Ed25519 private key (PEM)')
  .action(notImplemented('licence sign'));
licence
  .command('verify')
  .description('Verify a signed licence document')
  .argument('<json>', 'licence JSON file')
  .requiredOption('--trusted <pub...>', 'trusted Ed25519 public keys (PEM)')
  .action(notImplemented('licence verify'));

await program.parseAsync(process.argv);

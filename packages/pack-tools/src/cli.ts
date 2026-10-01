#!/usr/bin/env node
// CLI `mscd-pack` (build plan WP-09): keygen, build, build-all, verify, licence sign, licence verify.
// Run `mscd-pack --help` or `mscd-pack <command> --help` for the options.
import { runCli } from './commands.js';

process.exitCode = runCli(process.argv.slice(2));

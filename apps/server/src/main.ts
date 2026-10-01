#!/usr/bin/env node
// Entry point of the mscd-server image and of `node apps/server/dist/main.js`.
import 'reflect-metadata';
import { buildProgram } from './program';

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    process.stderr.write(`mscd-server: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });

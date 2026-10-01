/**
 * Action of a command whose work package has not landed yet: prints "not implemented" and exits 2, so scripts
 * fail clearly instead of silently doing nothing (WP-03 brief).
 */
export function notImplemented(command: string, workPackage: string): () => never {
  return () => {
    process.stderr.write(`mscd-server ${command}: not implemented in this build yet (${workPackage})\n`);
    process.exit(2);
  };
}

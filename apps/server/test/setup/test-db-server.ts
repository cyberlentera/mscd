// Shared between the global setup (main process) and the per-file helper (test workers).

/** Passwords of the login roles in test databases: the development values of deploy/compose/dev (R-11). */
export const TEST_ROLE_PASSWORDS = {
  migrator: 'migrator-dev',
  app: 'app-dev',
  packInstaller: 'pack-dev',
} as const;

/** Template databases built by the global setup: `mscd_tpl_<kind>` (J.2). */
export type TemplateKind = 'empty' | 'demo';

/** What the global setup hands to every test file (`inject('mscdTestDb')`). */
export interface TestDbServer {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  /** Maintenance database the administrator connects to for CREATE and DROP DATABASE. */
  adminDatabase: string;
  /** Template kinds that exist for this run. */
  templates: TemplateKind[];
}

declare module 'vitest' {
  export interface ProvidedContext {
    mscdTestDb: TestDbServer;
  }
}

export function templateName(kind: TemplateKind): string {
  return `mscd_tpl_${kind}`;
}

/** PostgreSQL URL for a user on the test server. */
export function serverUrl(server: TestDbServer, database: string, user = server.adminUser, password = server.adminPassword): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${server.host}:${server.port}/${encodeURIComponent(database)}`;
}

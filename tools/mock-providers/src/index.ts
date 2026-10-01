import Fastify, { type FastifyInstance } from 'fastify';

// Mock servers for the provider APIs MSCD calls (build plan J.7 and D.5). This skeleton answers only the admin
// health and reset routes; WP-10 adds the Microsoft identity, Graph and Google Drive endpoints, the fixtures and
// the fault switches.

export interface MockProvidersOptions {
  /** Fixture document loaded at start and after every reset (WP-10 defines the format). */
  fixtures?: unknown;
}

export interface StartOptions extends MockProvidersOptions {
  /** TCP port; 0 picks a free port. */
  port?: number;
  host?: string;
}

export interface RunningMockProviders {
  app: FastifyInstance;
  /** Base URL, for example http://127.0.0.1:4310 */
  url: string;
  close(): Promise<void>;
}

export function buildMockProviders(options: MockProvidersOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  let fixtures = options.fixtures;

  app.get('/_admin/health', async () => ({ status: 'ok' }));
  app.post('/_admin/reset', async () => {
    fixtures = options.fixtures;
    return { ok: true, fixtures: fixtures === undefined ? 'none' : 'loaded' };
  });

  return app;
}

export async function startMockProviders(options: StartOptions = {}): Promise<RunningMockProviders> {
  const app = buildMockProviders(options);
  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return { app, url: `http://${host}:${port}`, close: () => app.close() };
}

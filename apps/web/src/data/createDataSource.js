// Chooses the data source at build time (ARCHITECTURE 14.1, BUILD-PLAN H.1). Each source module is loaded with a
// dynamic import, so a bundle holds only the source it uses: `VITE_DATA_SOURCE=api` builds never contain the sample
// records of SampleDataSource.js (checked by the WP-25 acceptance), and sample builds never contain the API source.
//
// API mode: options are `{client, me, profile}` from the boot router (src/auth/boot.tsx); the source shares the boot's
// ApiClient, so a 401, a `reauth-required` and a sign-out reach the router. A call without that client is refused:
// a source with a client of its own would hide session ends and organisation switches from the router.
// Sample mode: every other value, and no value; options go to the sample source (org, persona).
// `import.meta.env.VITE_DATA_SOURCE` is written out in full so Vite replaces it with the build's value and the bundler
// drops the branch the build does not use (with it, the dynamic import of the other source).
export async function createDataSource(options) {
  if (import.meta.env.VITE_DATA_SOURCE === 'api') {
    const opts = options || {};
    if (!opts.client) {
      throw new Error("createDataSource: VITE_DATA_SOURCE=api is not available without the boot router's ApiClient (options.client)");
    }
    const { createApiDataSource } = await import('./api/ApiDataSource.ts');
    return createApiDataSource(opts);
  } else {
    const { createSampleDataSource } = await import('./SampleDataSource.js');
    return createSampleDataSource(options);
  }
}

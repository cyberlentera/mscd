// Chooses the data source at build time (ARCHITECTURE 14.1, BUILD-PLAN H.1). The source module is loaded with a
// dynamic import, so a bundle holds only the source it uses: the sample records of SampleDataSource.js never enter
// an API build. `VITE_DATA_SOURCE=api` selects the API source, which WP-25 adds here (./api/ApiDataSource.ts);
// every other value, and no value, selects the sample source.
// Resolves to a DataSource of types.ts; options go to the sample source (org, persona).
export async function createDataSource(options) {
  const env = (import.meta && import.meta.env) || {};
  if (env.VITE_DATA_SOURCE === 'api') {
    throw new Error('createDataSource: VITE_DATA_SOURCE=api is not available in this build (WP-25 adds the API source)');
  }
  const { createSampleDataSource } = await import('./SampleDataSource.js');
  return createSampleDataSource(options);
}

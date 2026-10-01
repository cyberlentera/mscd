import React from 'react';
import { createRoot } from 'react-dom/client';
import MscdApp from './MscdApp.jsx';
import { createDataSource } from './data/createDataSource.js';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import './hover.css';

// Display preferences. Each can be overridden from the URL, e.g. ?density=dense&drill=page
const q = new URLSearchParams(location.search);
const pick = (key, options, fallback) => (options.includes(q.get(key)) ? q.get(key) : fallback);
const settings = {
  drillPattern: pick('drill', ['panel', 'page', 'inline'], 'panel'),
  density: pick('density', ['dense', 'comfortable', 'airy'], 'comfortable'),
  overviewLayout: pick('layout', ['cards', 'rows'], 'cards'),
  font: pick('font', ['plex', 'source', 'public', 'instrument'], 'plex'),
  lang: pick('lang', ['en', 'id'], 'en'),
  theme: pick('theme', ['light', 'dark'], 'light'),
  deploy: pick('deploy', ['saas', 'onprem'], 'saas'),
};

const container = document.getElementById('root');

// BUILD-PLAN H.7. The API build (VITE_DATA_SOURCE=api) boots through src/auth/boot.tsx: system profile, session,
// then the sign-in pages or the app with the API data source. The sample build renders the app at once, as before;
// the auth pages are a separate chunk it never loads.
if (import.meta.env.VITE_DATA_SOURCE === 'api') {
  import('./auth/boot.tsx').then(({ boot }) => boot({ container, settings, App: MscdApp, createDataSource }));
} else {
  createRoot(container).render(
    <React.StrictMode>
      <MscdApp {...settings} />
    </React.StrictMode>,
  );
}

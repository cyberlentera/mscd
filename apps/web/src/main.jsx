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

// Shown when the chunk of the API build's boot does not load (a lost connection, or an index.html older than the
// deployed assets), instead of a blank page. Inline styles, because auth.css belongs to that chunk; the colours are
// the app's text and accent tokens (WCAG AA in both themes). Language as the sign-in pages: ?lang=, else the browser.
function LoadFailure({ dark }) {
  const asked = q.get('lang');
  const browser = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  const id = asked === 'id' || (asked !== 'en' && /^(id|in)\b/i.test(browser));
  const [title, hint, reload] = id
    ? ['MSCD tidak dapat dimuat.', 'Periksa koneksi Anda, lalu muat ulang halaman.', 'Muat ulang']
    : ['MSCD could not load.', 'Check your connection, then reload the page.', 'Reload'];
  const accent = dark ? '#e8731a' : '#ad4f0b';
  return (
    <div
      role="alert"
      lang={id ? 'id' : 'en'}
      style={{
        minHeight: '100vh', boxSizing: 'border-box', padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 14, fontFamily: "'IBM Plex Sans',system-ui,sans-serif", fontSize: 14,
        background: dark ? '#131210' : '#f4f2ee', color: dark ? '#cfc7b8' : '#4a453d',
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: dark ? '#f2eee7' : '#1c1a17' }}>{title}</h1>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{hint}</p>
      <button
        type="button"
        onClick={() => location.reload()}
        style={{
          height: 40, padding: '0 16px', borderRadius: 10, font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          border: `1px solid ${accent}`, background: accent, color: dark ? '#131210' : '#ffffff',
        }}
      >
        {reload}
      </button>
    </div>
  );
}

// BUILD-PLAN H.7. The API build (VITE_DATA_SOURCE=api) boots through src/auth/boot.tsx: system profile, session,
// then the sign-in pages or the app with the API data source. The sample build renders the app at once, as before;
// the auth pages are a separate chunk it never loads.
if (import.meta.env.VITE_DATA_SOURCE === 'api') {
  import('./auth/boot.tsx').then(
    ({ boot }) => boot({ container, settings, App: MscdApp, createDataSource }),
    (error) => {
      console.error(error);
      createRoot(container).render(<LoadFailure dark={settings.theme === 'dark'} />);
    },
  );
} else {
  createRoot(container).render(
    <React.StrictMode>
      <MscdApp {...settings} />
    </React.StrictMode>,
  );
}

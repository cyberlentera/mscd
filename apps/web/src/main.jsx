import React from 'react';
import { createRoot } from 'react-dom/client';
import MscdApp from './MscdApp.jsx';
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

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MscdApp {...settings} />
  </React.StrictMode>,
);

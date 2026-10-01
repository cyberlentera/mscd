# MSCD web app

Management System Compliance Dashboard by CyberLentera. React 18 + Vite.

The app runs fully in the browser on a fictional sample organisation (`src/data/mscd-data.js`), so it works without a backend.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static files in dist/
npm run preview    # serve dist/ on http://localhost:4173
npm run test:e2e   # Playwright end-to-end suite
```

## Display settings

Set from the URL query string, for example `/?lang=id&theme=dark`.

| Key | Values | Default |
| --- | --- | --- |
| `drill` | `panel`, `page`, `inline` | `panel` |
| `density` | `dense`, `comfortable`, `airy` | `comfortable` |
| `layout` | `cards`, `rows` (portfolio) | `cards` |
| `font` | `plex`, `source`, `public`, `instrument` | `plex` |
| `lang` | `en`, `id` | `en` |
| `theme` | `light`, `dark` | `light` |
| `deploy` | `saas`, `onprem` | `saas` |

## Code layout

| Path | What it holds |
| --- | --- |
| `src/MscdApp.jsx` | Controller: state, derived data, actions. `renderVals()` builds the view-model every screen renders from. |
| `src/views/*.jsx` | Screen and shell components, generated from the design template. |
| `src/data/mscd-data.js` | Sample organisation, translations, framework packs, Tera guidance. |
| `scripts/convert-template.mjs` | Regenerates `src/views` from `../project/MSCD Mockup.dc.html` (`npm run gen:views`). |
| `e2e/` | Playwright tests. |

To change a screen's markup, edit the design template and run `npm run gen:views`, or move the component out of the generated set and edit it by hand.

# MSCD web app

Management System Compliance Dashboard by CyberLentera. React 18 + Vite. Workspace package `@mscd/web` of the MSCD repository.

The app runs fully in the browser on a fictional sample organisation (`src/data/mscd-data.js`), so it works without a backend.

## Run

Install once from the repository root with `npm ci` (there is no lockfile in this folder), then, from the repository root:

```bash
npm run dev -w @mscd/web              # http://localhost:5173
npm run build -w @mscd/web            # static files in apps/web/dist/
npm run preview -w @mscd/web          # serve dist/ on http://localhost:4173
CI=1 npm run test:e2e -w @mscd/web    # Playwright end-to-end suite
npm run gen:views -w @mscd/web        # regenerate src/views and src/hover.css
npm run gen:views:check -w @mscd/web  # fail when the generated files differ from the template
```

The same scripts work with `npm run <script>` inside `apps/web`. [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) covers prerequisites, the E2E suite and image builds.

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
| `src/views/*.jsx` | Screen and shell components, generated from the design template. Never edited by hand. |
| `src/views/util.js` | Hand-written helpers the generated views import. |
| `src/hover.css` | Hover rules, generated with the views. |
| `src/data/mscd-data.js` | Sample organisation, translations, framework packs, Tera guidance. |
| `scripts/convert-template.mjs` | Regenerates `src/views` and `src/hover.css` from `../../project/MSCD Mockup.dc.html` (`npm run gen:views`). `--out <dir>` writes them to `<dir>/views/` and `<dir>/hover.css` instead. |
| `scripts/check-views.mjs` | Regenerates into a temporary folder and compares with `src` (`npm run gen:views:check`). |
| `e2e/` | Playwright tests. |

To change a screen's markup, edit the design template (or the patch list at the top of the converter) and run `npm run gen:views`. The container image is built from `deploy/docker/web.Dockerfile` at the repository root.

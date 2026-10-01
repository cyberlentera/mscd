// Checks that the generated views and hover rules match the design template (rule R-04).
//
//   npm run gen:views:check -w @mscd/web
//
// Regenerates src/views/*.jsx and src/hover.css into a temporary folder with
// scripts/convert-template.mjs --out, then compares the result with the committed files.
// Any missing, extra or different file is listed and the script exits 1. The hand-written
// src/views/util.js is not generated, so it is excluded from the comparison but must exist.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const converter = path.join(root, 'scripts', 'convert-template.mjs');
const srcDir = path.join(root, 'src');
const repoRoot = path.resolve(root, '..', '..');
const rel = (file) => path.relative(repoRoot, file).split(path.sep).join('/');

const jsxIn = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsx')).sort() : [];

function check(tmp) {
  const run = spawnSync(process.execPath, [converter, '--out', tmp], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) {
    process.stderr.write(run.stdout + run.stderr);
    console.error('gen:views:check: the converter failed (see above)');
    return 1;
  }

  const problems = [];
  const genViews = path.join(tmp, 'views');
  const srcViews = path.join(srcDir, 'views');
  const generated = jsxIn(genViews);
  const committed = new Set(jsxIn(srcViews));

  if (generated.length === 0) problems.push('the converter wrote no views');
  for (const name of generated) {
    const file = path.join(srcViews, name);
    if (!committed.has(name)) problems.push(`missing: ${rel(file)}`);
    else if (!fs.readFileSync(file).equals(fs.readFileSync(path.join(genViews, name)))) {
      problems.push(`different: ${rel(file)}`);
    }
    committed.delete(name);
  }
  for (const name of committed) problems.push(`extra (not generated): ${rel(path.join(srcViews, name))}`);

  const util = path.join(srcViews, 'util.js');
  if (!fs.existsSync(util)) problems.push(`missing: ${rel(util)} (hand-written helpers the views import)`);

  const hover = path.join(srcDir, 'hover.css');
  if (!fs.existsSync(hover)) problems.push(`missing: ${rel(hover)}`);
  else if (!fs.readFileSync(hover).equals(fs.readFileSync(path.join(tmp, 'hover.css')))) {
    problems.push(`different: ${rel(hover)}`);
  }

  if (problems.length) {
    console.error('gen:views:check: the generated files do not match project/MSCD Mockup.dc.html:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('Change the design template or scripts/convert-template.mjs, then run "npm run gen:views -w @mscd/web".');
    console.error('Never edit src/views/*.jsx or src/hover.css by hand.');
    return 1;
  }
  console.log(`gen:views:check: ${generated.length} views and hover.css match the design template`);
  return 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mscd-views-'));
let status;
try {
  status = check(tmp);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(status);

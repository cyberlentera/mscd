import { test, expect, SCREENS, openApp, go, ui } from './helpers.js';

// Design rules of the platform: no box shadows (selection rings are outlines, overlays have a 1px border), and no
// coloured accent on one side of a card or row, neither a border nor a narrow bar. A one-sided border in a neutral
// colour is fine: the table column lines, the sidebar and drawer edges and the dividers of the dark hero cards.
async function designProblems(page) {
  return page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map(Number); return { r, g, b, a }; };
    // Neutral borders (--bd, white or black with alpha, the text greys) have almost no chroma; status and system colours do.
    const coloured = (c) => { const p = parse(c); return !!p && p.a > 0 && Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) > 40; };
    const side = (cs, s) => ({ w: parseFloat(cs.getPropertyValue(`border-${s}-width`)), st: cs.getPropertyValue(`border-${s}-style`), c: cs.getPropertyValue(`border-${s}-color`) });
    const label = (el) => `${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 40)}"`;
    const bad = [];
    for (const el of document.querySelectorAll('.mscd, .mscd *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.boxShadow !== 'none') bad.push(`box-shadow ${cs.boxShadow}: ${label(el)}`);
      // a narrow coloured bar in the flow of a card or row (the connector lines of charts are positioned absolutely)
      if (r.width <= 6 && r.height >= 16 && r.height >= 3 * r.width && cs.position !== 'absolute' && coloured(cs.backgroundColor)) bad.push(`side bar ${Math.round(r.width)}px ${cs.backgroundColor}: ${label(el.parentElement)}`);
      if (r.width <= 4) continue; // a line drawn with a border (the today marker of the timeline), not an edge
      const sides = Object.fromEntries(['top', 'right', 'bottom', 'left'].map((s) => [s, side(cs, s)]));
      const full = Object.values(sides).every((x) => x.w === sides.left.w && x.c === sides.left.c && x.st === sides.left.st);
      if (full) continue; // a border all round (chips, rings, selected cards) is not a side accent
      for (const s of ['left', 'right']) {
        const b = sides[s];
        if (b.w > 0 && b.st !== 'none' && coloured(b.c)) bad.push(`border-${s} ${b.w}px ${b.c}: ${label(el)}`);
      }
    }
    return [...new Set(bad)];
  });
}

for (const theme of ['light', 'dark']) {
  test(`no box shadows and no coloured side borders on any screen, ${theme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, `?theme=${theme}`);
    const failures = {};
    for (const label of SCREENS) {
      await go(page, label);
      const bad = await designProblems(page);
      if (bad.length) failures[label] = bad;
    }
    // the Tera panel is an overlay: a border separates it from the page
    await ui.tera(page).click({ force: true });
    await expect(ui.teraCard(page)).toBeVisible();
    await expect(ui.teraCard(page)).toHaveCSS('border-top-width', '1px');
    const bad = await designProblems(page);
    if (bad.length) failures.Tera = bad;
    expect(failures).toEqual({});
  });
}

test('the Home rows layout and My Tasks have no coloured side accents', async ({ page }) => {
  await openApp(page, '?layout=rows');
  expect(await designProblems(page)).toEqual([]);
  await go(page, 'My Tasks');
  expect(await designProblems(page)).toEqual([]);
});

import { test, expect, SCREENS, openApp, go } from './helpers.js';

// WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text (24px, or 18.66px bold).
// Every visible text element is measured against the first opaque background behind it.
async function lowContrast(page) {
  return page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const bgOf = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage !== 'none') return null; // gradients and images are judged by eye
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let out = { r: 255, g: 255, b: 255, a: 1 };
      for (const l of layers.reverse()) out = blend(l, out);
      return out;
    };
    const bad = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!walker.currentNode.nodeValue.trim() || !el || seen.has(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || cs.visibility === 'hidden' || el.closest('svg')) continue;
      let op = 1; for (let n = el; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
      if (op < 0.99) continue; // fading in or decorative; animations end at full opacity
      const fg = parse(cs.color); const bg = bgOf(el);
      if (!fg || !bg) continue;
      const c = blend(fg, bg);
      const L1 = lum(c), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
      const min = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < min) bad.push(`${ratio.toFixed(2)} < ${min}: "${walker.currentNode.nodeValue.trim().slice(0, 40)}" ${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`);
    }
    return [...new Set(bad)];
  });
}

for (const theme of ['light', 'dark']) {
  test(`text contrast meets WCAG AA on every screen, ${theme} theme`, async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, `?theme=${theme}`);
    const failures = {};
    for (const label of SCREENS) {
      await go(page, label);
      await page.waitForTimeout(1200); // let entry animations finish
      const bad = await lowContrast(page);
      if (bad.length) failures[label] = bad;
    }
    expect(failures).toEqual({});
  });
}

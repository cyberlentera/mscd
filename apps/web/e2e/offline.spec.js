import { test, expect, SCREENS, SCREENS_ID, openApp, go, switchMs } from './helpers.js';

// The on-premise image deletes every line of dist/index.html that mentions Google Fonts (app/Dockerfile:
// sed -i -E '/fonts\.(googleapis|gstatic)\.com/d'), so an air-gapped site never calls out. The same edit is
// applied to the page served here, and every request that leaves the app's own origin is blocked and recorded.
const asOnPremImage = (html) => html.split('\n').filter((line) => !/fonts\.(googleapis|gstatic)\.com/.test(line)).join('\n');

test.describe('On-premise build', () => {
  test('makes no request outside its own origin and still renders with IBM Plex', async ({ page, baseURL }) => {
    const origin = new URL(baseURL).origin;
    const external = [];
    let served = null;
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (!req.url().startsWith(origin)) {
        external.push(req.url());
        return route.abort('blockedbyclient');
      }
      if (req.resourceType() === 'document') {
        const res = await route.fetch();
        served = asOnPremImage(await res.text());
        return route.fulfill({ response: res, body: served });
      }
      return route.continue();
    });

    await openApp(page);
    expect(served).not.toMatch(/googleapis|gstatic/);
    expect(served).toContain('<div id="root"></div>');
    for (const label of SCREENS) await go(page, label);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('600 16px "IBM Plex Sans"'))).toBe(true);
    await expect(page.locator('main h1')).toHaveCSS('font-family', /IBM Plex Sans/);

    // the alternative pairings fall back to system fonts instead of fetching them
    await openApp(page, '?font=source&lang=id&theme=dark');
    await switchMs(page, 'BCMS');
    for (const label of SCREENS_ID) await go(page, label);
    expect(external).toEqual([]);
  });

  test('the built page links Google Fonts only on lines the image build removes', async ({ page, baseURL }) => {
    const html = await (await page.request.get(baseURL + '/')).text();
    const external = html.split('\n').filter((line) => /https?:\/\/(?!localhost)/.test(line));
    expect(external.length).toBeGreaterThan(0);
    // each line that points outside the app is a Google Fonts line, so the Dockerfile edit removes all of them
    for (const line of external) expect(line).toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(asOnPremImage(html)).not.toMatch(/https?:\/\/(?!localhost)/);
  });
});

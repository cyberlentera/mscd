// Per-test state of the API end-to-end project (build plan J.6). `e2e/helpers.js` calls `prepareApiTest` before every
// test when the project sets `use: { dataSource: 'api' }` (playwright.api.config.js): the api recreates its database
// from the seeded template and resets the mock providers (`POST /api/v1/test/reset`), then a session of `rina` (or the
// handle of the `apiSession` option; `null` for none) is minted in the test's browser context
// (`POST /api/v1/test/session`). Every test therefore starts from the seed state with its own session, also with
// `--repeat-each`. The helpers below give the specs the Mailpit API of the stack, the demo passwords and TOTP codes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoSecretBytes, totp } from '../../../tools/scripts/demo-totp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(HERE, '../../../node_modules/.cache/mscd/e2e-api-stack.json');

/** The password of every demo user that signs in with one (G.3). */
export const DEMO_PASSWORD = 'Mscd-Demo-2026!';

/** Email addresses of the demo users the sign-in specs use (G.3: sample people at nusantaradigital.co.id). */
export const EMAILS = {
  rina: 'rina.kusuma@nusantaradigital.co.id',
  maya: 'maya.putri@nusantaradigital.co.id',
  hendra: 'hendra.wijaya@nusantaradigital.co.id',
  sari: 'sari.wulandari@nusantaradigital.co.id',
  'mfa.tester': 'mfa.tester@mscd.test',
};

/** Addresses of the running stack, written by `e2e-api/stack.mjs`. */
export function stackState() {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

/** The current TOTP code of a demo user (tools/scripts/demo-totp.mjs), `offsetSteps` 30-second steps away. */
export function demoCode(handle, offsetSteps = 0) {
  return totp(demoSecretBytes(handle), Math.floor(Date.now() / 1000) + offsetSteps * 30);
}

/** RFC 4648 base32 (no padding) to bytes. */
function base32Bytes(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text.replace(/[\s=]+/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`Not a base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The current TOTP code of a base32 secret shown at enrolment. */
export function totpOf(secret) {
  return totp(base32Bytes(secret), Math.floor(Date.now() / 1000));
}

/** Waits until the next 30-second TOTP step starts when fewer than `marginSeconds` remain of the current one. */
export async function freshTotpStep(marginSeconds = 5) {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < marginSeconds) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 200));
}

async function post(request, baseURL, url, data) {
  const response = await request.post(baseURL + url, { data, headers: { origin: baseURL }, timeout: 60_000 });
  if (!response.ok()) throw new Error(`${url} answered ${response.status()}: ${await response.text()}`);
  return response.json();
}

/**
 * Before each test of the API project: reset the api to the seed state, then mint a session of `handle` in the
 * browser context of `page` (the cookie jar of `page.request` is the context's).
 */
export async function prepareApiTest(page, { baseURL, handle }) {
  await post(page.request, baseURL, '/api/v1/test/reset', undefined);
  await clearMail();
  await page.context().clearCookies();
  if (handle) await post(page.request, baseURL, '/api/v1/test/session', { handle });
}

/** Messages in Mailpit to `to`, newest last, with their plain text. */
export async function mailTo(to) {
  const { mailApi } = stackState();
  const list = await (await fetch(`${mailApi}/messages?limit=200`)).json();
  const wanted = list.messages.filter((m) => m.To.some((a) => a.Address.toLowerCase() === to.toLowerCase())).reverse();
  return Promise.all(
    wanted.map(async (m) => {
      const full = await (await fetch(`${mailApi}/message/${m.ID}`)).json();
      return { id: m.ID, subject: m.Subject, text: full.Text, created: m.Created };
    }),
  );
}

/** Waits for a message to `to` whose text matches `pattern` and returns the first match. */
export async function waitForMail(to, pattern, { timeoutMs = 15_000, after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = (await mailTo(to)).filter((m) => Date.parse(m.created) >= after);
    for (const m of messages.reverse()) {
      const match = pattern.exec(m.text);
      if (match) return match;
    }
    if (Date.now() > deadline) throw new Error(`No email to ${to} matching ${pattern} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Removes every message from Mailpit. */
export async function clearMail() {
  const { mailApi } = stackState();
  await fetch(`${mailApi}/messages`, { method: 'DELETE' });
}

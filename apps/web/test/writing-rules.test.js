// Writing rules of the platform texts: the interface strings (T, TERA and the other static content) and the sample
// records hold no en or em dash, centre dot, curly quote or arrow character, no typed arrow and no "s.d.".
import { describe, expect, it } from 'vitest';
import * as SAMPLE from '../src/data/mscd-data.js';
import * as STATIC from '../src/data/static.js';
import { ORGS } from '../src/data/sample-orgs.js';

const FORBIDDEN = /[–—·‘’“”←→]|->|\bs\.d\./;

/** Every string value under `value`, with its path; functions are skipped. */
function strings(value, at, out = []) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

describe('writing rules', () => {
  it.each([
    ['static.js', STATIC],
    ['mscd-data.js', SAMPLE],
    ['sample-orgs.js', { ORGS }],
  ])('%s holds no forbidden character or typed arrow', (_name, module) => {
    const all = strings(module, 'export');
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(([, text]) => FORBIDDEN.test(text))).toEqual([]);
  });
});

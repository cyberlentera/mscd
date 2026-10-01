// Every exported schema carries its export name as schema id, accepts its hand-written valid examples and rejects
// its invalid ones. Enumerations are checked option by option.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../src/index.js';

const INVALID = shared.INVALID_EXAMPLES_KEY;

const schemas = Object.entries(shared).filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType);

function describeIssues(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? 'parsed' : result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

describe('exported schemas', () => {
  it('are found in the package entry point', () => {
    expect(schemas.length).toBeGreaterThan(250);
  });

  it('have unique schema ids', () => {
    const ids = schemas.map(([, s]) => (s.meta() as { id?: string } | undefined)?.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const [name, schema] of schemas) {
    describe(name, () => {
      const meta = (schema.meta() ?? {}) as Record<string, unknown>;

      it('is registered under its export name', () => {
        expect(meta.id).toBe(name);
      });

      if (schema instanceof z.ZodEnum) {
        it('accepts every option and rejects other values', () => {
          const options = schema.options as readonly string[];
          expect(options.length).toBeGreaterThan(0);
          for (const option of options) expect(schema.safeParse(option).success).toBe(true);
          for (const bad of ['__not_an_option__', '', null, 1, ` ${options[0]}`, String(options[0]).toUpperCase() === options[0] ? `${options[0]}x` : String(options[0]).toUpperCase()]) {
            expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
          }
        });
        return;
      }

      const valid = meta.examples as unknown[] | undefined;
      const invalid = meta[INVALID] as unknown[] | undefined;

      it('has hand-written valid and invalid examples', () => {
        expect(Array.isArray(valid) && valid.length > 0, `${name} needs valid examples (named(...) in its source file)`).toBe(true);
        expect(Array.isArray(invalid) && invalid.length > 0, `${name} needs invalid examples`).toBe(true);
      });

      it('accepts every valid example', () => {
        for (const [i, example] of (valid ?? []).entries()) {
          const result = schema.safeParse(example);
          expect(result.success, `valid example ${i}: ${describeIssues(result)}`).toBe(true);
        }
      });

      it('rejects every invalid example', () => {
        for (const [i, example] of (invalid ?? []).entries()) {
          expect(schema.safeParse(example).success, `invalid example ${i} was accepted: ${JSON.stringify(example)}`).toBe(false);
        }
      });
    });
  }
});

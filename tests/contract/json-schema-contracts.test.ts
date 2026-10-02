import { describe, expect, it } from 'vitest';

import { schemaFixtures } from './schema-fixtures.js';
import { createSchemaValidator } from './schema-validator.js';

describe('public JSON Schema contracts', () => {
  it('compiles every schema and accepts or rejects the declared fixtures', async () => {
    const validator = await createSchemaValidator();

    expect(validator.schemas).toBeDefined();
    expect(schemaFixtures).toHaveLength(12);

    for (const fixture of schemaFixtures) {
      const validate = validator.getSchema(fixture.schemaId);
      expect(validate, fixture.schemaId).toBeDefined();

      for (const validExample of fixture.valid) {
        expect(validate?.(validExample), JSON.stringify(validate?.errors)).toBe(true);
      }

      for (const invalidExample of fixture.invalid) {
        expect(validate?.(invalidExample), fixture.schemaId).toBe(false);
      }
    }
  });
});

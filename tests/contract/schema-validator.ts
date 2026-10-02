import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function isFormatsPlugin(value: unknown): value is (validator: Ajv2020) => Ajv2020 {
  return typeof value === 'function';
}

export async function createSchemaValidator(): Promise<Ajv2020> {
  const validator = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  const addFormats: unknown = formatsModule.default;
  if (!isFormatsPlugin(addFormats)) {
    throw new TypeError('Ajv formats plugin is unavailable.');
  }
  addFormats(validator);

  for (const filePath of await listJsonFiles(path.resolve('schemas'))) {
    validator.addSchema(parseJsonObject(await readFile(filePath, 'utf8')));
  }

  return validator;
}

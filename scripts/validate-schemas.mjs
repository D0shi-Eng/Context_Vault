import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = path.join(projectRoot, 'schemas');

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

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

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);

const schemas = [];
for (const filePath of await listJsonFiles(schemaRoot)) {
  const schema = JSON.parse(await readFile(filePath, 'utf8'));
  schemas.push({ filePath, schema });
  ajv.addSchema(schema);
}

for (const { filePath, schema } of schemas) {
  const schemaId = schema.$id;
  if (typeof schemaId !== 'string' || ajv.getSchema(schemaId) === undefined) {
    throw new Error(`Schema did not compile: ${path.relative(projectRoot, filePath)}`);
  }
}

process.stdout.write(`Validated ${schemas.length} JSON Schema 2020-12 documents.\n`);

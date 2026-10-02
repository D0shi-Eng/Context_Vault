import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectories = [
  '.stryker-tmp',
  '.verification',
  'artifacts',
  'coverage',
  'dist',
  'reports',
];

for (const directory of generatedDirectories) {
  const target = path.resolve(projectRoot, directory);

  if (path.dirname(target) !== projectRoot) {
    throw new Error('Refusing to clean a path outside the project root.');
  }

  await rm(target, { force: true, recursive: true });
}

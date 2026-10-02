import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set([
  '.git',
  '.pnpm-store',
  '.stryker-tmp',
  '.verification',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'reports',
]);
const ignoredFiles = new Set(['pnpm-lock.yaml']);
const prohibitedEnvironmentNames = /^\.env(?:\..+)?$/u;

const signatures = [
  {
    name: 'private key material',
    pattern: new RegExp(
      ['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join(''),
      'u',
    ),
  },
  {
    name: 'GitHub access token',
    pattern: new RegExp(['gh', '[pousr]_', '[A-Za-z0-9_]{36,255}'].join(''), 'u'),
  },
  {
    name: 'AWS access key identifier',
    pattern: new RegExp(['AK', 'IA', '[0-9A-Z]{16}'].join(''), 'u'),
  },
  {
    name: 'Slack token',
    pattern: new RegExp(['xox', '[abprs]-', '[A-Za-z0-9-]{20,255}'].join(''), 'u'),
  },
];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile() && !ignoredFiles.has(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

const findings = [];

for (const filePath of await listFiles(projectRoot)) {
  const fileName = path.basename(filePath);
  if (prohibitedEnvironmentNames.test(fileName) && fileName !== '.env.example') {
    findings.push(`${path.relative(projectRoot, filePath)}: prohibited environment file`);
    continue;
  }

  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    continue;
  }

  for (const signature of signatures) {
    if (signature.pattern.test(content)) {
      findings.push(`${path.relative(projectRoot, filePath)}: ${signature.name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Potential secrets detected:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('No high-confidence secret signatures detected.\n');
}

import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');
const violations = [];

const layerRank = new Map([
  ['domain', 0],
  ['application', 1],
  ['adapters', 2],
  ['infrastructure', 3],
]);

const prohibitedRuntimeImports = new Set([
  'dns',
  'http',
  'https',
  'net',
  'node:dns',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'tls',
  'undici',
]);
const nodeBuiltinImports = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
);

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function layerOf(filePath) {
  const relative = path.relative(sourceRoot, filePath).replaceAll('\\', '/');
  const firstSegment = relative.split('/')[0];
  return layerRank.has(firstSegment) ? firstSegment : 'entrypoint';
}

function resolveRelativeImport(importer, specifier) {
  const candidate = path.resolve(path.dirname(importer), specifier);
  return candidate.endsWith('.js') ? `${candidate.slice(0, -3)}.ts` : candidate;
}

function recordViolation(filePath, message) {
  violations.push(`${path.relative(projectRoot, filePath)}: ${message}`);
}

for (const filePath of await listTypeScriptFiles(sourceRoot)) {
  const source = await readFile(filePath, 'utf8');
  const imports = ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => fileName);
  const sourceLayer = layerOf(filePath);

  for (const specifier of imports) {
    if (prohibitedRuntimeImports.has(specifier)) {
      recordViolation(filePath, `prohibited network-capable import '${specifier}'`);
      continue;
    }

    if (nodeBuiltinImports.has(specifier) && sourceLayer !== 'infrastructure') {
      recordViolation(filePath, `Node.js built-in import '${specifier}' is outside infrastructure`);
      continue;
    }

    if (specifier.startsWith('@modelcontextprotocol/sdk')) {
      const normalized = path.relative(sourceRoot, filePath).replaceAll('\\', '/');
      const allowed =
        normalized.startsWith('adapters/inbound/mcp/') ||
        normalized === 'infrastructure/composition-root.ts' ||
        normalized === 'infrastructure/run-stdio-server.ts';
      if (!allowed) {
        recordViolation(
          filePath,
          'MCP SDK import is outside the MCP adapter or composition boundary',
        );
      }
      continue;
    }

    if (!specifier.startsWith('.') && sourceLayer === 'domain') {
      recordViolation(filePath, `domain imports external package '${specifier}'`);
      continue;
    }

    if (!specifier.startsWith('.') && sourceLayer === 'application') {
      recordViolation(filePath, `application imports external package '${specifier}'`);
      continue;
    }

    if (!specifier.startsWith('.') && sourceLayer === 'adapters' && specifier !== 'zod/v4') {
      recordViolation(filePath, `adapter imports unapproved package '${specifier}'`);
      continue;
    }

    if (!specifier.startsWith('.')) {
      continue;
    }

    const targetPath = resolveRelativeImport(filePath, specifier);
    const targetLayer = layerOf(targetPath);
    const sourceRank = layerRank.get(sourceLayer);
    const targetRank = layerRank.get(targetLayer);

    if (sourceLayer === 'entrypoint' && targetLayer !== 'infrastructure') {
      recordViolation(filePath, `entrypoint imports forbidden layer '${targetLayer}'`);
    } else if (sourceRank !== undefined && targetRank !== undefined && targetRank > sourceRank) {
      recordViolation(filePath, `'${sourceLayer}' depends outward on '${targetLayer}'`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary check failed:\n${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Architecture boundary check passed.\n');
}

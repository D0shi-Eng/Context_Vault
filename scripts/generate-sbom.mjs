import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const pnpmScript = process.env.npm_execpath;
const executable =
  pnpmScript === undefined
    ? process.platform === 'win32'
      ? 'pnpm.cmd'
      : 'pnpm'
    : process.execPath;
const argumentsList = [
  ...(pnpmScript === undefined ? [] : [pnpmScript]),
  'list',
  '--depth',
  'Infinity',
  '--json',
];
const { stdout } = await executeFile(executable, argumentsList, {
  cwd: projectRoot,
  encoding: 'utf8',
  windowsHide: true,
});
const dependencyTree = JSON.parse(stdout)[0];
const componentsByReference = new Map();
const dependenciesByReference = new Map();
const expandedReferences = new Set();

function encodePackageName(name) {
  return name.startsWith('@') ? `%40${name.slice(1)}` : name;
}

function visitDependencies(dependencies, parentReference) {
  if (dependencies === undefined || typeof dependencies !== 'object') {
    return;
  }

  for (const [name, dependency] of Object.entries(dependencies)) {
    const reference = `pkg:npm/${encodePackageName(name)}@${dependency.version}`;
    const parentDependencies = dependenciesByReference.get(parentReference) ?? new Set();
    parentDependencies.add(reference);
    dependenciesByReference.set(parentReference, parentDependencies);

    if (!componentsByReference.has(reference)) {
      componentsByReference.set(reference, {
        type: 'library',
        'bom-ref': reference,
        name,
        version: dependency.version,
        purl: reference,
      });
    }

    const hasChildren =
      (dependency.dependencies !== undefined && typeof dependency.dependencies === 'object') ||
      (dependency.devDependencies !== undefined && typeof dependency.devDependencies === 'object');
    if (hasChildren && !expandedReferences.has(reference)) {
      expandedReferences.add(reference);
      visitDependencies(dependency.dependencies, reference);
      visitDependencies(dependency.devDependencies, reference);
    }
  }
}

const rootReference = `pkg:npm/${packageJson.name}@${packageJson.version}`;
visitDependencies(dependencyTree.dependencies, rootReference);
visitDependencies(dependencyTree.devDependencies, rootReference);

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': rootReference,
      name: packageJson.name,
      version: packageJson.version,
      licenses: [{ license: { id: packageJson.license } }],
      purl: rootReference,
    },
  },
  components: [...componentsByReference.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  ),
  dependencies: [rootReference, ...componentsByReference.keys()].sort().map((reference) => ({
    ref: reference,
    dependsOn: [...(dependenciesByReference.get(reference) ?? [])].sort(),
  })),
};

const outputDirectory = path.join(projectRoot, 'artifacts', 'sbom');
const outputPath = path.join(outputDirectory, 'contextvault.cdx.json');
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
process.stdout.write(`Generated ${path.relative(projectRoot, outputPath)}.\n`);

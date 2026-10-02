import { describe, expect, it } from 'vitest';

import { detectMediaPolicy } from '../../src/domain/inspection/media-policy.js';
import { supportedSelectorTypes } from '../../src/domain/retrieval/retrieval-grant-policy.js';

describe('media policy', () => {
  it.each([
    ['data.json', 'application/json', ['json_node', 'line_range']],
    ['README.md', 'text/markdown', ['chunk', 'line_range']],
    ['guide.markdown', 'text/markdown', ['chunk', 'line_range']],
    ['notes.txt', 'text/plain', ['chunk', 'line_range']],
    ['trace.log', 'text/plain', ['chunk', 'line_range']],
    ['config.yaml', 'application/yaml', []],
    ['config.yml', 'application/yaml', []],
    ['events.JSONL', 'application/x-ndjson', []],
    ['events.ndjson', 'application/x-ndjson', []],
    ['table.csv', 'text/csv', []],
    ['table.tsv', 'text/tab-separated-values', []],
    ['src/main.ts', 'text/typescript', []],
    ['native.c', 'text/x-c', []],
    ['.env', 'text/plain', ['chunk', 'line_range']],
    ['unknown', 'text/plain', ['chunk', 'line_range']],
  ] as const)('maps %s deterministically', (path, mediaType, selectors) => {
    expect(detectMediaPolicy(path, true)).toEqual({
      mediaType,
      supportedSelectors: selectors,
    });
  });

  it('announces only selectors the retrieval grant policy can honor', () => {
    // Every announced selector must come from the same source of truth
    // that grants and retrieval enforce, so inspect can never advertise
    // a selector a v1 grant cannot narrow or honor exactly.
    const honorableView = new Set<string>([
      ...supportedSelectorTypes('text_chunks'),
      ...supportedSelectorTypes('json_structure'),
      ...supportedSelectorTypes('minimal'),
    ]);
    for (const supportedSelectors of collectAnnouncedSelectors()) {
      for (const kind of supportedSelectors) {
        expect(honorableView.has(kind)).toBe(true);
      }
    }
  });

  it.each([
    ['program.cc', 'text/x-c++'],
    ['program.cpp', 'text/x-c++'],
    ['Program.CS', 'text/x-csharp'],
    ['main.go', 'text/x-go'],
    ['Main.java', 'text/x-java-source'],
    ['widget.js', 'text/javascript'],
    ['widget.jsx', 'text/jsx'],
    ['widget.mjs', 'text/javascript'],
    ['script.py', 'text/x-python'],
    ['lib.rs', 'text/x-rust'],
    ['widget.tsx', 'text/tsx'],
  ] as const)('maps source extension %s to %s', (path, mediaType) => {
    expect(detectMediaPolicy(path, true).mediaType).toBe(mediaType);
  });

  it.each([
    ['README.TS', 'text/typescript'],
    ['TRACE.LOG', 'text/plain'],
    ['DATA.JSONL', 'application/x-ndjson'],
  ] as const)('normalizes %s case to %s', (path, mediaType) => {
    expect(detectMediaPolicy(path, true).mediaType).toBe(mediaType);
  });

  it.each([
    ['my.dir/notes', 'a dotted directory with an extensionless file'],
    ['my.md/notes', 'an extension-like directory with an extensionless file'],
    ['docs/.md', 'a hidden extension-like file beneath a directory'],
    ['a.b/c.d/e', 'nested dotted directories with an extensionless file'],
  ])('ignores directory dots when deriving the extension for %s (%s)', (path) => {
    expect(detectMediaPolicy(path, true).mediaType).toBe('text/plain');
  });

  it.each([
    ['nested/deep/data.json', 'application/json'],
    ['nested/deep/table.csv', 'text/csv'],
    ['archive.tar.ts', 'text/typescript'],
  ] as const)('derives the extension from %s after the last separator', (path, mediaType) => {
    expect(detectMediaPolicy(path, true).mediaType).toBe(mediaType);
  });

  it.each([
    ['.env', 'text/plain'],
    ['.gitignore', 'text/plain'],
  ] as const)('treats the leading-dot file %s as having no extension', (path, mediaType) => {
    expect(detectMediaPolicy(path, true).mediaType).toBe(mediaType);
  });

  it.each([
    ['.ts', 'text/plain'],
    ['.py', 'text/plain'],
    ['.JSON', 'text/plain'],
  ] as const)(
    'does not treat a leading dot before a known source extension as an extension for %s',
    (path, mediaType) => {
      // A file named exactly `.ts` has an empty base name, so the dot is not a
      // separator between a name and an extension. Reading it as `ts` would
      // misclassify a dotfile as source and expose source selectors for it.
      expect(detectMediaPolicy(path, true)).toEqual({
        mediaType,
        supportedSelectors: ['chunk', 'line_range'],
      });
    },
  );

  it.each([['file'], ['nested/file']] as const)('maps %s to text/plain', (path) => {
    expect(detectMediaPolicy(path, true).mediaType).toBe('text/plain');
  });

  it('does not expose text selectors for binary content', () => {
    expect(detectMediaPolicy('data.json', false)).toEqual({
      mediaType: 'application/octet-stream',
      supportedSelectors: [],
    });
  });

  it('differs the announcement between JSON and text media with distinct grants', () => {
    // The per-media difference is contract-visible: JSON prepares as a
    // structure (json_node), text prepares as chunks; only line_range is
    // common to both, and unpreparable media announce nothing.
    expect(detectMediaPolicy('data.json', true).supportedSelectors).toEqual([
      'json_node',
      'line_range',
    ]);
    expect(detectMediaPolicy('notes.txt', true).supportedSelectors).toEqual([
      'chunk',
      'line_range',
    ]);
    expect(detectMediaPolicy('table.csv', true).supportedSelectors).toEqual([]);
  });
});

function collectAnnouncedSelectors(): readonly (readonly string[])[] {
  const paths = [
    'data.json',
    'events.ndjson',
    'table.csv',
    'table.tsv',
    'trace.log',
    'README.md',
    'config.yaml',
    'src/main.ts',
    'notes.txt',
    'unknown',
  ];
  return paths.map((path) => detectMediaPolicy(path, true).supportedSelectors);
}

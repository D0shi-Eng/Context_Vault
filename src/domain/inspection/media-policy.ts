import type { SelectorKind } from './source-inspection.js';
import { supportedSelectorTypes } from '../retrieval/retrieval-grant-policy.js';

export interface MediaPolicy {
  readonly mediaType: string;
  readonly supportedSelectors: readonly SelectorKind[];
}

/**
 * Preparation kinds version 1 can derive for a prepared source.
 * Shared by preparation and disclosure so both layers resolve one kind.
 */
export type PreparationKind = 'text_chunks' | 'json_structure' | 'minimal';

const SOURCE_MEDIA_TYPES = new Map<string, string>([
  ['c', 'text/x-c'],
  ['cc', 'text/x-c++'],
  ['cpp', 'text/x-c++'],
  ['cs', 'text/x-csharp'],
  ['go', 'text/x-go'],
  ['java', 'text/x-java-source'],
  ['js', 'text/javascript'],
  ['jsx', 'text/jsx'],
  ['mjs', 'text/javascript'],
  ['py', 'text/x-python'],
  ['rs', 'text/x-rust'],
  ['ts', 'text/typescript'],
  ['tsx', 'text/tsx'],
]);

/**
 * Resolves the preparation kind version 1 derives for a media type, or
 * `null` when the media type cannot be prepared at all. This mapping is
 * the single media-to-kind authority; the announced selectors always
 * come from the retrieval grant policy for the resolved kind, so inspect
 * can never advertise a selector a grant could not honor.
 */
export function preparationKindForMediaType(mediaType: string): PreparationKind | null {
  switch (mediaType) {
    case 'application/json':
      return 'json_structure';
    case 'text/plain':
    case 'text/markdown':
      return 'text_chunks';
    default:
      return null;
  }
}

export function detectMediaPolicy(normalizedRelativePath: string, isText: boolean): MediaPolicy {
  if (!isText) {
    return policy('application/octet-stream');
  }

  const extension = getExtension(normalizedRelativePath);
  const sourceMediaType = SOURCE_MEDIA_TYPES.get(extension);
  if (sourceMediaType) {
    return policy(sourceMediaType);
  }

  switch (extension) {
    case 'json':
      return policy('application/json');
    case 'jsonl':
    case 'ndjson':
      return policy('application/x-ndjson');
    case 'csv':
      return policy('text/csv');
    case 'tsv':
      return policy('text/tab-separated-values');
    case 'log':
      return policy('text/plain');
    case 'md':
    case 'markdown':
      return policy('text/markdown');
    case 'yaml':
    case 'yml':
      return policy('application/yaml');
    default:
      return policy('text/plain');
  }
}

/**
 * Builds the policy for one media type: media types outside the version
 * 1 preparation set carry no usable selectors, so nothing is advertised.
 */
function policy(mediaType: string): MediaPolicy {
  const preparationKind = preparationKindForMediaType(mediaType);
  return Object.freeze({
    mediaType,
    supportedSelectors: supportedSelectorTypes(preparationKind ?? 'minimal'),
  });
}

function getExtension(normalizedRelativePath: string): string {
  const fileName = normalizedRelativePath.slice(normalizedRelativePath.lastIndexOf('/') + 1);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex <= 0 ? '' : fileName.slice(dotIndex + 1).toLowerCase();
}

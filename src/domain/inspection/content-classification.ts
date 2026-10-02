import type { SecretRisk, Sensitivity } from './source-inspection.js';

const PRIVATE_KEY_PATTERN = new RegExp(
  ['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join(''),
  'u',
);
const AWS_ACCESS_KEY_PATTERN = new RegExp(['AK', 'IA', '[0-9A-Z]{16}'].join(''), 'u');
const GITHUB_TOKEN_PATTERN = new RegExp(['gh', '[pousr]_', '[A-Za-z0-9_]{36,255}'].join(''), 'u');
const SLACK_TOKEN_PATTERN = new RegExp(['xox', '[abprs]-', '[A-Za-z0-9-]{20,255}'].join(''), 'u');
const SUSPECTED_ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/iu;
const SENSITIVE_FILE_NAME_PATTERN =
  /(?:^|\/)(?:\.env(?:\..+)?|credentials?|id_(?:rsa|dsa|ecdsa|ed25519)|secrets?)(?:\.[^/]*)?$/iu;
const NUL_BYTE = 0;

export interface ContentClassification {
  readonly isText: boolean;
  readonly secretRisk: SecretRisk;
  readonly sensitivity: Sensitivity;
}

export function classifyContent(
  normalizedRelativePath: string,
  bytes: Uint8Array,
): ContentClassification {
  if (bytes.includes(NUL_BYTE)) {
    return Object.freeze({
      isText: false,
      secretRisk: 'unknown',
      sensitivity: 'restricted',
    });
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Object.freeze({
      isText: false,
      secretRisk: 'unknown',
      sensitivity: 'restricted',
    });
  }

  if (
    PRIVATE_KEY_PATTERN.test(text) ||
    AWS_ACCESS_KEY_PATTERN.test(text) ||
    GITHUB_TOKEN_PATTERN.test(text) ||
    SLACK_TOKEN_PATTERN.test(text)
  ) {
    return Object.freeze({
      isText: true,
      secretRisk: 'confirmed',
      sensitivity: 'prohibited',
    });
  }

  if (
    SENSITIVE_FILE_NAME_PATTERN.test(normalizedRelativePath) ||
    SUSPECTED_ASSIGNMENT_PATTERN.test(text)
  ) {
    return Object.freeze({
      isText: true,
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  }

  return Object.freeze({
    isText: true,
    secretRisk: 'none',
    sensitivity: 'internal',
  });
}

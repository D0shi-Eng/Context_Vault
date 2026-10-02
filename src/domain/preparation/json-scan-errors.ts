/**
 * Fail-closed error factories for bounded JSON structural scanning.
 *
 * The scanner reports malformed syntax, excessive depth, and excessive
 * item counts through distinct machine-readable codes while never
 * including any source text or parser internals in the messages.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';

export function malformedJsonError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_JSON_MALFORMED',
    message: 'The source is not valid JSON.',
  });
}

export function depthExceededError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PARSE_DEPTH_EXCEEDED',
    message: 'The source exceeds the supported structural depth.',
  });
}

export function itemLimitError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PARSE_ITEM_LIMIT_EXCEEDED',
    message: 'The source exceeds the supported structural item count.',
  });
}

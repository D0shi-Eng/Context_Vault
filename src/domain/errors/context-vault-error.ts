export type ContextVaultErrorCode =
  | 'CV_AUTHORIZATION_DENIED'
  | 'CV_CAPABILITY_INVALID'
  | 'CV_CONFIGURATION_INVALID'
  | 'CV_DEADLINE_EXCEEDED'
  | 'CV_ENVELOPE_NOT_FOUND'
  | 'CV_INPUT_INVALID'
  | 'CV_INPUT_UTF8_INVALID'
  | 'CV_INTERNAL_ERROR'
  | 'CV_JSON_MALFORMED'
  | 'CV_OPERATION_CANCELLED'
  | 'CV_PARSE_DEPTH_EXCEEDED'
  | 'CV_PARSE_ITEM_LIMIT_EXCEEDED'
  | 'CV_PARSE_LINE_LIMIT_EXCEEDED'
  | 'CV_PATH_ABSOLUTE_DENIED'
  | 'CV_PATH_INVALID'
  | 'CV_PATH_OUTSIDE_WORKSPACE'
  | 'CV_PATH_REPARSE_POINT_DENIED'
  | 'CV_PATH_SPECIAL_FILE_DENIED'
  | 'CV_PREPARE_MEDIA_UNSUPPORTED'
  | 'CV_PURGE_INTENT_EXPIRED'
  | 'CV_PURGE_INTENT_INVALID'
  | 'CV_PURGE_INTENT_STALE'
  | 'CV_RESOURCE_CONCURRENCY_LIMIT'
  | 'CV_RESOURCE_DERIVED_STATE_LIMIT'
  | 'CV_RESOURCE_ENVELOPE_LIMIT'
  | 'CV_RESOURCE_ENVELOPE_TOO_LARGE'
  | 'CV_RESOURCE_SOURCE_TOO_LARGE'
  | 'CV_RETRIEVAL_POLICY_DENIED'
  | 'CV_SELECTOR_UNSUPPORTED'
  | 'CV_SOURCE_CHANGED'
  | 'CV_SOURCE_NOT_FOUND';

export type SafeDetailValue = boolean | null | number | string;
export type SafeDetails = Readonly<Record<string, SafeDetailValue>>;

export interface ContextVaultErrorOptions {
  readonly code: ContextVaultErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly safeDetails?: SafeDetails;
}

export class ContextVaultError extends Error {
  readonly code: ContextVaultErrorCode;
  readonly retryable: boolean;
  readonly safeDetails: SafeDetails | undefined;

  constructor(options: ContextVaultErrorOptions) {
    super(options.message);
    this.name = 'ContextVaultError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.safeDetails = options.safeDetails ? Object.freeze({ ...options.safeDetails }) : undefined;
  }
}

export function isContextVaultError(value: unknown): value is ContextVaultError {
  return value instanceof ContextVaultError;
}

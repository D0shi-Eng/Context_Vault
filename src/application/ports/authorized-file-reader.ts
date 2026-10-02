export interface AuthorizedFileReadRequest {
  readonly rootId: string;
  readonly normalizedRelativePath: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}

export interface AuthorizedFile {
  readonly bytes: Uint8Array;
  readonly normalizedRelativePath: string;
}

export interface AuthorizedFileReader {
  /** Number of workspace roots authorized at process startup. */
  readonly authorizedRootCount: number;
  read(request: AuthorizedFileReadRequest): Promise<AuthorizedFile>;
}

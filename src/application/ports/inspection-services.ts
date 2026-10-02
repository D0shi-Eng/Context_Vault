export interface InspectionClock {
  now(): Date;
}

export interface InspectionCryptography {
  sha256(bytes: Uint8Array): string;
  sourceId(rootId: string, normalizedRelativePath: string, sourceDigest: string): string;
}

export interface CorrelationIdFactory {
  create(): string;
}

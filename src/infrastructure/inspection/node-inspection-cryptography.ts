import { createHash, randomBytes } from 'node:crypto';

import type {
  CorrelationIdFactory,
  InspectionCryptography,
} from '../../application/ports/inspection-services.js';

export class NodeInspectionCryptography implements InspectionCryptography, CorrelationIdFactory {
  sha256(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }

  sourceId(rootId: string, normalizedRelativePath: string, sourceDigest: string): string {
    const identity = createHash('sha256')
      .update(rootId)
      .update('\0')
      .update(normalizedRelativePath)
      .update('\0')
      .update(sourceDigest)
      .digest('base64url');
    return `cv_src_${identity}`;
  }

  create(): string {
    return `cv_corr_${randomBytes(18).toString('base64url')}`;
  }
}

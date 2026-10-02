import { randomBytes } from 'node:crypto';

import type { OpaqueIdentifierFactory } from '../../application/ports/preparation-services.js';

/**
 * Generates opaque identifiers from cryptographically secure randomness.
 * Identifiers never encode source paths, digests, or any source content.
 */
export class NodeOpaqueIdentifiers implements OpaqueIdentifierFactory {
  createSessionId(): string {
    return `cv_ses_${randomBytes(18).toString('base64url')}`;
  }

  createEnvelopeId(): string {
    return `cv_env_${randomBytes(18).toString('base64url')}`;
  }

  createPurgeIntentId(): string {
    return `cv_pur_${randomBytes(18).toString('base64url')}`;
  }
}

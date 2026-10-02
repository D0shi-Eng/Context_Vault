import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  CapabilityDigestComparator,
  CapabilityTokenDigester,
  CapabilityTokenFactory,
} from '../../application/ports/retrieval-services.js';

const TOKEN_PREFIX = 'cv1_';
const TOKEN_IDENTITY_BYTES = 32;

/**
 * The digest compared against when a presented capability matches no
 * stored grant. Running the same constant-time comparison on the miss
 * path keeps the observable work of a lookup from acting as a
 * capability-validity oracle.
 */
export const ABSENT_CAPABILITY_DIGEST = createHash('sha256')
  .update('contextvault-absent-capability')
  .digest('hex');

/**
 * Node.js implementation of the capability token lifecycle.
 *
 * Tokens carry 256 bits of platform cryptographic randomness encoded as
 * base64url. Only the SHA-256 digest of a token is ever stored or
 * compared; the raw token exists exactly once, in the issuance response.
 */
export class NodeCapabilityTokens
  implements CapabilityTokenFactory, CapabilityTokenDigester, CapabilityDigestComparator
{
  readonly absentCapabilityDigest = ABSENT_CAPABILITY_DIGEST;

  createCapabilityToken(): string {
    return `${TOKEN_PREFIX}${randomBytes(TOKEN_IDENTITY_BYTES).toString('base64url')}`;
  }

  digestCapabilityToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  compareCapabilityDigests(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    if (leftBytes.length !== rightBytes.length) {
      return false;
    }
    return timingSafeEqual(leftBytes, rightBytes);
  }
}

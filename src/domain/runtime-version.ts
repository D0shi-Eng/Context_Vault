const NODE_VERSION_PATTERN = /^v?(\d+)(?:\.|$)/u;

export function parseNodeMajorVersion(version: string): number | undefined {
  const match = NODE_VERSION_PATTERN.exec(version);
  const major = Number(match?.[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

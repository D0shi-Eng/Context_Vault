export const SERVER_NAME = 'contextvault' as const;
export const SERVER_VERSION = '0.0.0' as const;
export const MINIMUM_NODE_MAJOR = 24 as const;

export interface ServerIdentity {
  readonly name: typeof SERVER_NAME;
  readonly version: typeof SERVER_VERSION;
}

export const SERVER_IDENTITY: ServerIdentity = Object.freeze({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

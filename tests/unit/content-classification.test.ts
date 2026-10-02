import { describe, expect, it } from 'vitest';

import { classifyContent } from '../../src/domain/inspection/content-classification.js';

const encoder = new TextEncoder();

describe('content classification', () => {
  it('classifies ordinary UTF-8 content as internal with no detected secret risk', () => {
    expect(classifyContent('docs/guide.md', encoder.encode('Safe documentation. آمن'))).toEqual({
      isText: true,
      secretRisk: 'none',
      sensitivity: 'internal',
    });
  });

  it('classifies heuristic assignments as suspected without returning the match', () => {
    const result = classifyContent(
      'config/settings.txt',
      encoder.encode(['pass', 'word=', 'synthetic-value-only'].join('')),
    );

    expect(result).toEqual({
      isText: true,
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-value-only');
  });

  it('treats sensitive filenames as suspected even without a value', () => {
    expect(classifyContent('.env.example', encoder.encode('SAFE_PLACEHOLDER'))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it('classifies recognized private-key structure as prohibited', () => {
    const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const result = classifyContent('keys/sample.txt', encoder.encode(marker));

    expect(result).toEqual({
      isText: true,
      secretRisk: 'confirmed',
      sensitivity: 'prohibited',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it.each([
    [['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('')],
    [['gh', 'p_', 'A'.repeat(36)].join('')],
    [['xox', 'b-', 'A'.repeat(20)].join('')],
  ])('classifies another recognized credential structure as confirmed', (marker) => {
    const result = classifyContent('samples/value.txt', encoder.encode(marker));

    expect(result.secretRisk).toBe('confirmed');
    expect(result.sensitivity).toBe('prohibited');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('does not classify a short keyword value as a secret', () => {
    expect(classifyContent('notes.txt', encoder.encode('token=short'))).toMatchObject({
      secretRisk: 'none',
      sensitivity: 'internal',
    });
  });

  it.each([
    ['api_key=', 'the underscore form of the api key keyword'],
    ['apikey=', 'the concatenated form of the api key keyword'],
    ['api-key=', 'the hyphenated form of the api key keyword'],
    ['authorization=', 'the authorization keyword'],
    ['password=', 'the password keyword'],
    ['secret=', 'the secret keyword'],
    ['token=', 'the token keyword'],
  ])('classifies a long %s assignment as suspected (%s)', (keyword) => {
    const content = `${keyword}synthetic-value-only`;

    expect(classifyContent('config/settings.txt', encoder.encode(content))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it.each([
    [['id_', 'rsa'].join(''), 'a private RSA key filename'],
    [['id_', 'dsa'].join(''), 'a private DSA key filename'],
    [['id_', 'ecdsa'].join(''), 'a private ECDSA key filename'],
    [['id_', 'ed25519'].join(''), 'a private Ed25519 key filename'],
  ])('treats %s as suspected (%s)', (fileName) => {
    expect(classifyContent(fileName, encoder.encode('placeholder'))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it.each([
    ['credentials.json', 'a credentials file'],
    ['secret.txt', 'a singular secrets word'],
    ['secrets.json', 'a plural secrets word'],
    ['nested/.env.local', 'a nested environment file'],
  ])('treats %s as suspected (%s)', (fileName) => {
    expect(classifyContent(fileName, encoder.encode('placeholder'))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it('does not treat a similar-looking but unrelated filename as sensitive', () => {
    expect(classifyContent('credentialing-notes.md', encoder.encode('placeholder'))).toMatchObject({
      secretRisk: 'none',
      sensitivity: 'internal',
    });
  });

  it.each([
    [['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''), 'an RSA private key header'],
    [['-----BEGIN ', 'EC PRIVATE KEY-----'].join(''), 'an EC private key header'],
    [['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join(''), 'an OpenSSH private key header'],
  ])('classifies %s as confirmed (%s)', (marker) => {
    const result = classifyContent('keys/sample.txt', encoder.encode(marker));

    expect(result).toEqual({
      isText: true,
      secretRisk: 'confirmed',
      sensitivity: 'prohibited',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it.each([
    [['AK', 'IA'].join('') + 'ABCDEFGHIJKLMNOP', 'an AWS access key identifier'],
    [[['gh', 'p_'].join('')].join('') + 'A'.repeat(36), 'a GitHub personal access token'],
    [[['gh', 'o_'].join('')].join('') + 'A'.repeat(36), 'a GitHub OAuth token'],
    [['xox', 'b-'].join('') + 'A'.repeat(20), 'a Slack bot token'],
    [['xox', 'p-'].join('') + 'A'.repeat(20), 'a Slack user token'],
  ])('classifies %# as confirmed (%s)', (marker) => {
    const result = classifyContent('samples/value.txt', encoder.encode(marker));

    expect(result.secretRisk).toBe('confirmed');
    expect(result.sensitivity).toBe('prohibited');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it.each([new Uint8Array([0]), new Uint8Array([0xc3, 0x28])])(
    'fails closed for binary or invalid UTF-8 content',
    (bytes) => {
      expect(classifyContent('data.bin', bytes)).toEqual({
        isText: false,
        secretRisk: 'unknown',
        sensitivity: 'restricted',
      });
    },
  );

  it.each([
    ['PRIVATE KEY-----', 'a private-key footer without the BEGIN header'],
    ['-----BEGIN ', 'a BEGIN header without a key type or footer'],
  ])('does not treat %s as a confirmed private key (%s)', (marker) => {
    // The detection patterns must require the full credential structure. A
    // truncated fragment is not a supported secret and must stay undetected,
    // otherwise the classifier degrades into a substring match.
    expect(classifyContent('notes.txt', encoder.encode(marker))).toMatchObject({
      secretRisk: 'none',
      sensitivity: 'internal',
    });
  });

  it.each([
    [['IA', 'ABCDEFGHIJKLMNOP'].join(''), 'the AWS body without the AK prefix'],
    [['AK', 'ABCDEFGHIJKLMNOP'].join(''), 'the AK prefix without the IA segment'],
    [['AK', 'IA'].join(''), 'the AWS prefix without a body'],
    [['p_', 'A'.repeat(36)].join(''), 'a GitHub body without the gh prefix'],
    [['gh', 'A'.repeat(36)].join(''), 'the gh prefix without the token marker'],
    [['gh', 'p_'].join(''), 'the GitHub marker without a body'],
    [['b-', 'A'.repeat(20)].join(''), 'a Slack body without the xox prefix'],
    [['xox', 'A'.repeat(20)].join(''), 'the xox prefix without a workspace marker'],
    [['xox', 'b-'].join(''), 'the Slack marker without a body'],
  ])('does not treat %s as a confirmed credential (%s)', (marker) => {
    expect(classifyContent('notes.txt', encoder.encode(marker))).toMatchObject({
      secretRisk: 'none',
      sensitivity: 'internal',
    });
  });

  it.each([
    ['token = synthetic-value-only', 'whitespace before the separator'],
    ['password= synthetic-value-only', 'whitespace after the separator'],
    ['token="synthetic-value-only"', 'a quoted value'],
  ])('classifies an assignment with %s as suspected (%s)', (content) => {
    // The assignment heuristic must tolerate the whitespace and quoting that
    // real configuration files use around the separator.
    expect(classifyContent('config/settings.txt', encoder.encode(content))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it.each([
    ['.env', 'a bare environment file'],
    ['credential.json', 'a singular credential file'],
  ])('treats %s as suspected (%s)', (fileName) => {
    expect(classifyContent(fileName, encoder.encode('SAFE_PLACEHOLDER'))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it('treats a path beneath a dotenv-prefixed directory as suspected', () => {
    expect(classifyContent('.env.local/notes.md', encoder.encode('placeholder'))).toMatchObject({
      secretRisk: 'suspected',
      sensitivity: 'restricted',
    });
  });

  it('detects a credential structure in content that also contains astral characters', () => {
    const marker = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
    const result = classifyContent(
      'samples/value.txt',
      encoder.encode(`\u{1f600}${marker}\u{1f600}`),
    );

    expect(result).toMatchObject({ secretRisk: 'confirmed', sensitivity: 'prohibited' });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

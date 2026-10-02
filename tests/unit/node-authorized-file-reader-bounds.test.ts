import { describe, expect, it } from 'vitest';

import {
  captureReadError,
  captureRetryable,
  createReader,
  createScenario,
  expectReadError,
} from './node-authorized-file-reader-scenario.js';

describe('NodeAuthorizedFileReader bounded read handling', () => {
  it('rejects an early end-of-file', async () => {
    const scenario = createScenario({ readSizes: [0] });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_SOURCE_CHANGED');
  });

  it('rejects trailing bytes beyond the pre-read size', async () => {
    const scenario = createScenario({ readSizes: [4, 1] });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_SOURCE_CHANGED');
  });

  it('observes cancellation raised during a read', async () => {
    const controller = new AbortController();
    const scenario = createScenario({ abortAfterRead: controller });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_OPERATION_CANCELLED', controller.signal);
  });

  it('does not issue another read after cancellation during a partial read', async () => {
    // The first read returns only half of the expected bytes, then the signal is
    // aborted. The read loop must stop immediately: asserting the final error
    // code alone would not detect a further read of the same source.
    const controller = new AbortController();
    const scenario = createScenario({ abortAfterRead: controller, readSizes: [2, 2, 0] });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_OPERATION_CANCELLED', controller.signal);
    expect(scenario.readRequests()).toHaveLength(1);
  });

  it('requests only the remaining bytes on each partial read', async () => {
    const scenario = createScenario({ readSizes: [2, 2, 0] });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const result = await reader.read({
      rootId: 'repo',
      normalizedRelativePath: 'file.txt',
      maximumBytes: 1024,
    });

    expect(result.bytes.byteLength).toBe(4);
    expect(scenario.readRequests()).toEqual([
      { offset: 0, length: 4 },
      { offset: 2, length: 2 },
      { offset: 0, length: 1 },
    ]);
  });

  it('accepts a source exactly at the byte ceiling and rejects one byte more', async () => {
    const exact = createScenario({ maximumBytes: 4 });
    const exactReader = await createReader(exact.fileSystem, exact.rootPath);

    const result = await exactReader.read({
      rootId: 'repo',
      normalizedRelativePath: 'file.txt',
      maximumBytes: 4,
    });
    expect(result.bytes.byteLength).toBe(4);

    const oversized = createScenario({ maximumBytes: 4, readSizes: [5, 0], size: 5 });
    const oversizedReader = await createReader(oversized.fileSystem, oversized.rootPath);

    const failure = await captureReadError(oversizedReader, 'file.txt', 4);

    expect(failure.code).toBe('CV_RESOURCE_SOURCE_TOO_LARGE');
    expect(failure.safeDetails).toEqual({ maximumBytes: 4 });
  });

  it('marks a cancellation raised during a read as retryable', async () => {
    const controller = new AbortController();
    const scenario = createScenario({ abortAfterRead: controller });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const retryable = await captureRetryable(reader, controller.signal);

    expect(retryable).toBe(true);
  });

  it('honors cancellation that is already requested before the read starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const scenario = createScenario();
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_OPERATION_CANCELLED', controller.signal);
    expect(scenario.wasClosed()).toBe(false);
  });
});

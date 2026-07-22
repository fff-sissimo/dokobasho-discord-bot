const { createSingleFlightRunner } = require('../src/scheduler-runner');

describe('scheduler single-flight runner', () => {
  test('skips an overlapping tick while the first run is active', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const run = jest.fn(() => pending);
    const writeHeartbeat = jest.fn();
    const runner = createSingleFlightRunner({ run, writeHeartbeat });

    const first = runner();
    const second = await runner();

    expect(second).toEqual({ skipped: true, reason: 'already_running' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(writeHeartbeat).not.toHaveBeenCalled();

    release({ processed: 0, sent: 0, failed: 0 });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(writeHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('does not write a success heartbeat when processing fails', async () => {
    const writeHeartbeat = jest.fn();
    const runner = createSingleFlightRunner({
      run: jest.fn().mockRejectedValue(new Error('processing failed')),
      writeHeartbeat,
    });

    await expect(runner()).resolves.toMatchObject({
      ok: false,
      error: expect.any(Error),
    });
    expect(writeHeartbeat).not.toHaveBeenCalled();
  });
});

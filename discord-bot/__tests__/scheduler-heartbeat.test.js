const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const logger = require('../src/logger');
const {
  DEFAULT_HEARTBEAT_PATH,
  getHeartbeatPath,
  writeHeartbeat,
} = require('../src/scheduler-heartbeat');

describe('scheduler-heartbeat', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    logger.warn.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns default path when env is unset', () => {
    delete process.env.SCHEDULER_HEARTBEAT_PATH;
    expect(getHeartbeatPath()).toBe(DEFAULT_HEARTBEAT_PATH);
  });

  it('returns env path when set', () => {
    process.env.SCHEDULER_HEARTBEAT_PATH = '/tmp/custom-heartbeat';
    expect(getHeartbeatPath()).toBe('/tmp/custom-heartbeat');
  });

  it('writes heartbeat file', () => {
    const tmpPath = path.join(os.tmpdir(), `heartbeat-${Date.now()}.txt`);
    expect(writeHeartbeat(tmpPath)).toBe(true);
    const contents = fs.readFileSync(tmpPath, 'utf8');
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    fs.unlinkSync(tmpPath);
  });

  it('warns when write fails', () => {
    const dirPath = os.tmpdir();
    expect(writeHeartbeat(dirPath)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

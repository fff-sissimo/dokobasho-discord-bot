jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const logger = require('../src/logger');
const { getBotToken, requireEnv } = require('../src/config');

describe('config', () => {
  const originalEnv = process.env;
  let exitSpy;

  beforeEach(() => {
    process.env = { ...originalEnv };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses BOT_TOKEN when set', () => {
    process.env.BOT_TOKEN = 'primary';
    delete process.env.DISCORD_BOT_TOKEN;

    expect(getBotToken()).toBe('primary');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to DISCORD_BOT_TOKEN when BOT_TOKEN is missing', () => {
    delete process.env.BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = 'legacy';

    expect(getBotToken()).toBe('legacy');
    expect(logger.warn).toHaveBeenCalledWith(
      '[config] BOT_TOKEN is not set; using DISCORD_BOT_TOKEN instead.'
    );
  });

  it('prefers BOT_TOKEN when both are set', () => {
    process.env.BOT_TOKEN = 'primary';
    process.env.DISCORD_BOT_TOKEN = 'legacy';

    expect(getBotToken()).toBe('primary');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('exits when neither token is set', () => {
    delete process.env.BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;

    expect(() => getBotToken()).toThrow('process.exit: 1');
    expect(logger.error).toHaveBeenCalledWith(
      '[config] Missing BOT_TOKEN or DISCORD_BOT_TOKEN'
    );
  });

  it('requireEnv exits when variable is missing', () => {
    delete process.env.MISSING_VAR;

    expect(() => requireEnv('MISSING_VAR')).toThrow('process.exit: 1');
    expect(logger.error).toHaveBeenCalledWith('[config] Missing MISSING_VAR');
  });
});

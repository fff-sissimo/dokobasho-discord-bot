const { deployCommands, runMain } = require('../deploy-commands');

describe('deploy commands', () => {
  it('propagates Discord REST failures so the main entry can exit non-zero', async () => {
    const rest = { put: jest.fn().mockRejectedValue(new Error('Discord unavailable')) };

    await expect(deployCommands({
      rest,
      route: '/commands',
      commands: [{ name: 'fairy' }],
      log: { info: jest.fn() },
    })).rejects.toThrow('Discord unavailable');
  });

  it('sets a non-zero exit code when the main deployment fails', async () => {
    const processRef = { exitCode: 0 };
    await runMain({
      mainImpl: jest.fn().mockRejectedValue(new Error('Discord unavailable')),
      processRef,
      log: { error: jest.fn() },
    });

    expect(processRef.exitCode).toBe(1);
  });
});

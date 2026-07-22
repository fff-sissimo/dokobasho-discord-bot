const { MessageFlags } = require('discord.js');
const {
  editReply,
  ephemeralDefer,
  ephemeralReply,
} = require('../src/interaction-replies');

describe('interaction reply payloads', () => {
  test('sets ephemeral only on the initial reply and defer payloads', () => {
    expect(ephemeralReply('secret')).toEqual({
      content: 'secret',
      flags: [MessageFlags.Ephemeral],
    });
    expect(ephemeralDefer()).toEqual({ flags: [MessageFlags.Ephemeral] });
  });

  test('removes immutable ephemeral settings from edit payloads', () => {
    expect(editReply('done', {
      flags: [MessageFlags.Ephemeral],
      ephemeral: true,
      components: [],
    })).toEqual({
      content: 'done',
      components: [],
    });
  });
});

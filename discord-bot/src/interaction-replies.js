const { MessageFlags } = require('discord.js');

const ephemeralReply = (content, extra = {}) => ({
  ...extra,
  content,
  flags: [MessageFlags.Ephemeral],
});

const ephemeralDefer = () => ({ flags: [MessageFlags.Ephemeral] });

const editReply = (content, extra = {}) => {
  const { flags: _flags, ephemeral: _ephemeral, ...editable } = extra;
  return { ...editable, content };
};

module.exports = {
  editReply,
  ephemeralDefer,
  ephemeralReply,
};

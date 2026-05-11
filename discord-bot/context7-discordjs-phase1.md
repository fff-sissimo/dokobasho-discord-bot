# Context7 Discord.js Notes for Phase1

Source: Context7 `/websites/discord_js_packages_discord_js_14_26_2`, queried 2026-05-04.

- `channel.messages.fetch({ limit })` is the documented Discord.js v14 API for fetching recent channel messages.
- `channel.messages.fetch({ around: messageId, limit, cache: false })` fetches messages around a referenced message.
- `FetchMessagesOptions.before`, `after`, and `around` are mutually exclusive and can be used to page or target context.
- `FetchMessagesOptions.limit` controls the maximum number of messages returned.
- `message.reply({ content, allowedMentions })` accepts send/reply options.
- `allowedMentions.parse: []`, `users: []`, `roles: []`, and `repliedUser: false` disable automatic mention parsing and reply pings.

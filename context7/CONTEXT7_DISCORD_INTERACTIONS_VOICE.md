# Context7 notes: discord.js interaction / voice recovery

参照日: 2026-07-19

## discord.js 14.26.2

- Library ID: `/websites/discord_js_packages_discord_js_14_26_2`
- `InteractionDeferReplyOptions.flags` で設定できるのは `MessageFlags.Ephemeral` のみ。
- ephemeral性は最初の `reply` または `deferReply` で決める。
- `editReply` は `InteractionEditReplyOptions` による既存replyの内容編集として呼び、ephemeral flagを再指定しない。

```js
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
await interaction.editReply({ content: '完了しました' });
```

## @discordjs/voice 0.19.0

- Library ID: `/websites/discord_js_packages_voice_0_19_0`
- `VoiceReceiver.subscribe(userId, options)` はユーザー単位の `AudioReceiveStream`（Readable stream）を返す。
- streamの終了条件は `EndBehaviorType.AfterInactivity`、`AfterSilence`、`Manual` から選択できる。
- 長時間録音ではReadable streamのpacketをメモリへ蓄積せず、受信中にsession単位の保存領域へ逐次書き出す。
- stop時はsubscriptionを破棄し、保存済みデータを有界サイズでSTTへ渡す。

## 一次資料

- [InteractionDeferReplyOptions](https://discord.js.org/docs/packages/discord.js/14.26.2/InteractionDeferReplyOptions%3AInterface)
- [CommandInteraction.editReply](https://discord.js.org/docs/packages/discord.js/14.26.2/PrimaryEntryPointCommandInteraction%3AClass)
- [VoiceReceiver.subscribe](https://discord.js.org/docs/packages/voice/0.19.0/VoiceReceiver%3AClass)
- [EndBehaviorType](https://discord.js.org/docs/packages/voice/0.19.0/EndBehaviorType%3AEnum)

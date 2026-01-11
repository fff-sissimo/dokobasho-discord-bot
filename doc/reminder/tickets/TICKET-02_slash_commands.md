# TICKET-02: Discordスラッシュコマンド登録

## 概要

`/remind` コマンド群をDiscord APIに登録するためのスクリプトを作成し、実行する。

## ToDo

- [ ] `discord-bot/src/commands.js` に定義されたコマンド定義を読み込むスクリプトを作成する。
- [ ] Discord.js の `REST` と `Routes.applicationGuildCommands` (または `applicationCommands`) を使用して、指定したサーバーまたはグローバルにコマンドを登録するロジックを実装する。
- [ ] `package.json` に `deploy-commands` のようなスクリプトを定義し、コマンド一発で登録できるようにする。

## 実装のヒント

- コマンド登録は頻繁に行うものではないため、ボットのメインプロセスとは別の、独立したスクリプトとして作成する。
- 開発中は特定のテストサーバーにのみコマンドを登録 (Guild Commands) すると、反映が速く効率的。

## 関連ドキュメント

- [API設計書 (`doc/reminder/02_api_design.md`)](./../02_api_design.md)

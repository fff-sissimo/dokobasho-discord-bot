# TICKET-04: `/remind add` コマンドの実装

## 概要

リマインダーを新規登録する `/remind add` コマンドのロジックを実装する。

## ToDo

- [ ] Discordからのインタラクションイベントを待ち受け、`/remind add` コマンドを処理するハンドラを実装する。
- [ ] `chrono-node` を使用して、`time`引数の自然言語文字列をDateオブジェクトにパースする。
    - パース失敗時は、仕様書に沿ったエラーメッセージをユーザーに返す。
- [ ] コマンドの引数をバリデーションする (文字数制限など)。
- [ ] `key` を自動生成し、登録完了メッセージと `/remind list` で確認できるようにする。
- [ ] `scope` に応じて `guild_id`, `channel_id`, `user_id` を適切に設定する。
- [ ] `TICKET-03` の `addReminder` を呼び出し、データをGoogle Sheetsに保存する。
- [ ] 処理結果（成功・失敗）を `visibility` の設定に従ってユーザーに返信する。

## 実装のヒント

- 時刻パースはユーザーの入力に依存するため、最もエラーが起きやすい箇所。堅牢なエラーハンドリングと、親切なフィードバックが重要。
- 応答は `interaction.reply()` または `interaction.followUp()` で行う。`ephemeral: true` を設定すると、コマンド実行者のみに見える応答になる。

## 関連ドキュメント

- [リマインダー機能仕様書 (`doc/reminder/01_feature_specification.md`)](./../01_feature_specification.md)
- [API設計書 (`doc/reminder/02_api_design.md`)](./../02_api_design.md)
- [データベース設計書 (`doc/reminder/03_database_schema.md`)](./../03_database_schema.md)

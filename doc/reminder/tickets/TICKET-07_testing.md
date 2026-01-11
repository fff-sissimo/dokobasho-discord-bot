# TICKET-07: テストの実装

## 概要

機能の品質を担保するため、単体テストと結合テストを実装する。

## ToDo

- [ ] テストフレームワーク (例: `jest`, `mocha`) を導入する。
- [ ] **単体テスト**:
    - [ ] `chrono-node` を利用した時刻パース関数のテストケースを `doc/reminder/05_test_plan.md` に基づいて作成する（正常系・異常系）。
    - [ ] 繰り返し日付を計算するロジックのテストケースを作成する。
- [ ] **結合テスト**:
    - [ ] Google Sheets API と Discord API の通信部分をモック化する。
    - [ ] `/remind add` コマンドが実行された際に、Sheetsラッパーの `addReminder` が正しい引数で呼び出されることを確認する。
    - [ ] スケジューラが起動した際に、Sheetsラッパーの `getReminders` が呼び出され、条件に合うリマインダーが通知される（モックされたDiscordクライアントに `send` が発火する）ことを確認する。
    - [ ] `package.json` に `test` スクリプトを追加する。

## 実装のヒント

- `jest.mock()` を使うと、外部APIへの依存を簡単にモックできる。
- `discord.js-mocks` のようなライブラリを利用すると、Discordのオブジェクト (Guild, Channel, User) のモックが容易になる。

## 関連ドキュメント

- [テスト計画書 (`doc/reminder/05_test_plan.md`)](./../05_test_plan.md)

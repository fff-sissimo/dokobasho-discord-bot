# TICKET-10: テストカバレッジの向上

## 概要

Jestによるテストスイートを拡充し、コードカバレッジを向上させる。特に、これまでテストされていなかったコマンドやスケジューラのロジックを重点的にテストし、システムの信頼性を高める。

## ToDo

- [ ] Jestのカバレッジレポート機能を有効にし、現状のカバレッジを計測する。
- [ ] **結合テストの拡充 (`command-handler.test.js`):**
    - [ ] `/remind list` サブコマンドのテストケースを追加する（一覧が取得できる場合、0件の場合）。
    - [ ] `/remind delete` サブコマンドのテストケースを追加する（`confirm=true` の場合、`confirm=false` でボタンが表示される場合）。
    - [ ] `delete` の確認ボタンハンドラのテストケースを追加する。
    - [ ] 権限チェック（例: `scope=server` での削除）のテストケースを追加する。
- [ ] **スケジューラのテスト (`scheduler.test.js` の新規作成):**
    - [ ] `scheduler.js` のメインロジックをテスト可能な形にリファクタリングする（必要に応じて）。
    - [ ] `discord.js` のクライアントや `google-sheets.js` の関数をモックする。
    - [ ] 通知すべきリマインダーがある場合に、適切な通知関数 (`client.users.send` など) とステータス更新関数 (`updateReminder`) が正しい引数で呼び出されることをテストする。
    - [ ] リトライ処理（失敗時に `retry_count` が増え、`status` が `pending` または `failed` になる）をテストする。
    - [ ] 繰り返し処理（`recurring` の場合に次回の通知時刻が正しく計算され、`status` が `pending` に戻る）をテストする。

## 関連ドキュメント

- [品質向上タスク in requirement.md (`../requirement.md`)](./../requirement.md)
- [テスト計画書 (`../05_test_plan.md`)](./../05_test_plan.md)

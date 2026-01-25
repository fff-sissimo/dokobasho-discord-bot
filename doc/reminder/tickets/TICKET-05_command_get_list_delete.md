# TICKET-05: `/remind list, delete` コマンドの実装

## 概要

登録済みのリマインダーを管理するための `/remind list`, `/remind delete` コマンドのロジックを実装する。`/remind get` は運用中止。

## ToDo

- [ ] **`/remind list`**:
    - [ ] `TICKET-03` の `listReminders` を呼び出し、結果を箇条書き形式で表示する。
    - [ ] `query` 引数によるフィルタリングを実装する。
    - [ ] 自動生成された `key` を一覧に表示する。
- [ ] **`/remind delete`**:
    - [ ] `confirm=false` の場合、確認メッセージと「削除実行」ボタンを表示する。ボタンインタラクションを待つ処理を実装する。
    - [ ] `confirm=true` またはボタンが押された場合、`TICKET-03` の `deleteReminderById` を呼び出して削除を実行する。
    - [ ] `scope=server` の場合の管理者権限チェックを実装する (`interaction.member.permissions.has("Administrator")`)。
- [ ] 各コマンドのインタラクションハンドラを実装し、メインのボットプロセスに組み込む。

## 実装のヒント

- `delete` の確認フローでは、`discord.js` の `ActionRowBuilder` と `ButtonBuilder` を使ってインタラクティブなコンポーネントを作成する。
- `list` の結果が多数になる場合、ページネーション（次へ/前へボタン）の実装も検討する価値がある。

## 関連ドキュメント

- [リマインダー機能仕様書 (`doc/reminder/01_feature_specification.md`)](./../01_feature_specification.md)
- [API設計書 (`doc/reminder/02_api_design.md`)](./../02_api_design.md)

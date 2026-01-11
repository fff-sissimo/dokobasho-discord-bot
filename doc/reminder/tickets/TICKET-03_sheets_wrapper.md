# TICKET-03: Google Sheets ラッパーモジュールの実装

## 概要

Google Sheets (`Reminders`シート) へのアクセスを抽象化し、再利用可能なCRUD (作成, 読み取り, 更新, 削除) 操作を提供するモジュールを作成する。

## ToDo

- [ ] Google Sheets API client の認証と初期化を行う。
- [ ] `addReminder(data)`: 新しいリマインダー行を追加する関数。
- [ ] `getReminderByKey(key, scope)`: 指定されたキーとスコープに一致するリマインダーを取得する関数。
- [ ] `getReminderById(id)`: 指定されたIDのリマインダーを取得する関数。
- [ ] `listReminders(scope, query)`: 指定されたスコープのリマインダー一覧を取得する関数。
- [ ] `updateReminder(id, data, { rowIndex? })`: 指定IDの行データを更新する関数。`rowIndex` は最適化用のヒント。
- [ ] `deleteReminderById(id)`: 指定されたIDのリマインダーを削除 (status=deleted) する関数。
- [ ] スキーマで定義された列名と実際のシートの列インデックスをマッピングするロジックを実装する。

## 実装のヒント

- このモジュールは、コマンド処理とスケジューラの両方から利用されるコアコンポーネントとなる。
- エラーハンドリングを丁寧に行い、APIからのエラーを呼び出し元に適切に伝播させる。

## 関連ドキュメント

- [データベース設計書 (`doc/reminder/03_database_schema.md`)](./../03_database_schema.md)
- [アーキテクチャ設計書 (`doc/reminder/04_architecture_design.md`)](./../04_architecture_design.md)

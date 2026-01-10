# 3. データベース設計書 (Google Sheets)

## 3.1. シート名

- `Reminders`

## 3.2. スキーマ (列定義)

| 列名              | 型            | 説明                                                                                             |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `id`              | `string`      | レコードごとのユニークID (例: UUIDv4)。                                                          |
| `key`             | `string`      | リマインダーを識別するユーザー定義のキー。`scope`内でユニーク。                                   |
| `content`         | `string`      | リマインドする内容のテキスト。                                                                   |
| `scope`           | `string`      | リマインダーの有効範囲 (`user`, `channel`, `server`)。                                           |
| `guild_id`        | `string`      | Discord サーバー (Guild) の ID。`scope`が `channel` または `server` の場合に記録。               |
| `channel_id`      | `string`      | Discord チャンネルの ID。`scope`が `channel` の場合に記録。通知先として利用。                      |
| `user_id`         | `string`      | Discord ユーザーの ID。`scope`が `user` の場合に記録。通知先として利用。                           |
| `notify_time_utc` | `string`      | 次回通知時刻 (ISO 8601形式, UTC)。スケジューラはこの時刻を基準に動作する。                         |
| `timezone`        | `string`      | ユーザーが指定したタイムゾーン (`Asia/Tokyo`など)。繰り返し予定の計算に利用。                      |
| `recurring`       | `string`      | 繰り返し設定 (`off`, `daily`, `weekly`, `monthly`)。                                             |
| `visibility`      | `string`      | コマンド応答の可視性 (`public`, `ephemeral`)。                                                   |
| `created_by`      | `string`      | 登録したユーザーの Discord ID。                                                                  |
| `created_at`      | `string`      | 登録日時 (ISO 8601形式, UTC)。                                                                   |
| `status`          | `string`      | 現在の状態 (`pending`, `sending`, `sent`, `failed`)。スケジューラの排他制御に利用。             |
| `last_sent`       | `string`      | 最終送信日時 (ISO 8601形式, UTC)。                                                               |
| `retry_count`     | `integer`     | 送信失敗時のリトライ回数。                                                                       |
| `metadata`        | `string(JSON)`| 将来的な拡張用のJSON形式のメタデータフィールド。                                                 |

---

## 3.3. ログ用シート（任意）

- **シート名**: `ReminderLogs`
- **目的**: デバッグと監査のため、リマインダーの送信結果やエラーを記録する。
- **スキーマ案**:
    - `log_id` (ユニークID)
    - `reminder_id` (Remindersシートの`id`への参照)
    - `timestamp_utc` (ログ記録日時)
    - `event_type` (`sent_success`, `sent_failure`, `schedule_error`など)
    - `details` (エラーメッセージや成功時の情報など)

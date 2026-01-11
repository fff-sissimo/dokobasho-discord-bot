# 4. アーキテクチャ設計書

## 4.1. システム構成図

```
+------------------------+      +-------------------------+      +-------------------------+
|     Discord User       |      |      Discord API        |      |      Google Sheets API  |
+------------------------+      +-------------------------+      +-------------------------+
           ^                             ^           ^                        ^
           | 1. /remind command          |           | 4. Send Message        |
           v                             |           |                        |
+------------------------+      +--------+---------+--------+      +----------+-------------+
|  Discord Bot Process   |----->| 2. Command Handling      |----->| 3. Read/Write Sheet    |
| (e.g., Node.js/Docker) |      | (Parse, Validate, Ack) |      | (Reminders & Logs)     |
+------------------------+      +--------------------------+      +--------------------------+
           ^
           |
           | 5. Query & Update (Locking)
           |
+------------------------+
| Scheduler Process      |
| (e.g., Cron, Cloud Run)|
| - Every 1 minute       |
+------------------------+
```

## 4.2. コンポーネント詳細

### 4.2.1. Discord Bot Process

- **役割**: Discordからのスラッシュコマンドを受け付け、初期応答を返すプロセス。
- **技術スタック**: Node.js (discord.js), Docker
- **処理フロー**:
    1.  ユーザーが `/remind` コマンドを実行。
    2.  コマンドの引数をパースし、バリデーションを行う。
    3.  時刻文字列 (`time`) を `chrono-node` 等のライブラリで解釈し、UTCの `notify_time_utc` に変換する。
    4.  Google Sheets API を通じて `Reminders` シートに新しい行としてデータを書き込む。
    5.  処理結果（成功・失敗）を `visibility` 設定に従いユーザーに応答する。

### 4.2.2. Scheduler Process

- **役割**: 定期的にリマインダーをチェックし、通知を送信するプロセス。
- **技術スタック**: Node.jsスクリプト、実行環境は cron, systemd timer, または Google Cloud Scheduler + Cloud Run などを想定。
- **Docker運用**: `docker-compose.yml` の `discord-scheduler` サービスとして常駐実行する。
- **処理フロー (毎分実行)**:
    1.  `Reminders` シートに対してクエリを実行し、以下の条件に合致する行を取得する。
        - `notify_time_utc` <= 現在時刻 (UTC)
        - `status` == `pending`
    2.  **排他制御**: 取得した各行について、`status` を `pending` から `sending` にアトミックに更新する。更新に成功した行のみを処理対象とする（楽観ロック）。
    3.  処理対象となったリマインダーの通知を、`scope` に応じて Discord API 経由で送信する (DM or チャンネル投稿)。
    4.  **結果の記録**:
        - **成功時**: `status` を `sent` に更新。`recurring` が `off` でなければ、次回の `notify_time_utc` を計算して更新する。`last_sent` に現在時刻を記録。
        - **失敗時**: `retry_count` をインクリメント。`retry_count` が上限 (例: 3) を超えていなければ `status` を `pending` に戻し、次回のスケジューラ実行でリトライされるようにする。上限を超えた場合は `status`を `failed` に設定し、管理者へ通知する（任意）。
- **再起動耐性**: 全ての状態はGoogle Sheets上で管理されるため、ボットやスケジューラが再起動しても状態が失われることはない。再起動後、スケジューラは前回実行時からの差分を処理する。

## 4.3. 外部サービス・ライブラリ

- **Discord API**: スラッシュコマンドの受信、メッセージ送信。
- **Google Sheets API**: データの永続化。
- **時刻パースライブラリ**: `chrono-node` や `date-fns-tz` などを利用し、自然言語の時刻解釈とタイムゾーン処理を行う。

## 4.4. 環境変数

デプロイと設定に必要な環境変数は以下の通り。

| 変数名                  | 説明                                                              | 例                                                |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `BOT_TOKEN`             | Discord ボットの認証トークン（`DISCORD_BOT_TOKEN` でも可）。       | `Mxxxxxxxx...`                                    |
| `GOOGLE_SA_KEY_JSON`    | Google Service Account の認証キー (JSON形式をBase64エンコード)。   | `ewogICJ0eXBlIjog...`                             |
| `SHEET_ID`              | リマインダーを保存する Google スプレッドシートのID。              | `1a2b3c...`                                       |
| `DEFAULT_TZ`            | ユーザーがタイムゾーンを指定しなかった場合のデフォルト値。        | `Asia/Tokyo`                                      |

- Docker運用ではホスト側の鍵ファイルをボリュームでマウントし、`GOOGLE_SA_KEY_PATH` が参照できるようにする。
- `docker-compose.yml` ではホスト側の鍵パスを `GOOGLE_SA_KEY_FILE` で指定できる（既定は `./discord-bot/google-service-key.json`）。
- コンテナ内の `GOOGLE_SA_KEY_PATH` は `/app/keys/google-service-key.json` を想定する。
- `GOOGLE_SA_KEY_FILE` は Docker Compose 用のホスト環境変数で、`GOOGLE_SA_KEY_PATH` はコンテナ内の環境変数。

# TICKET-06: スケジューラプロセスの実装

## 概要

定期的にGoogle Sheetsをチェックし、期限が来たリマインダーを通知する独立したスケジューラプロセスを実装する。

## ToDo

- [ ] 1分ごとに実行されるスクリプトの雛形を作成する (`setInterval`, `node-cron`, またはOSのcronを利用)。
- [ ] `TICKET-03` のSheetsラッパーを使い、`notify_time_utc <= now` かつ `status = pending` のリマインダーを全て取得する。
- [ ] **排他制御**: 取得した各リマインダーについて、`status` を `sending` に更新する。この更新に成功したものだけを通知対象とする。
- [ ] 通知対象のリマインダーを、`scope` (`user`/`channel`) に応じてDiscordに送信する。
    - `user`: `client.users.send(user_id, ...)`
    - `channel`: `client.channels.cache.get(channel_id).send(...)`
- [ ] **結果更新**:
    - **成功時**: `status` を `sent` に、`last_sent` を現在時刻に更新する。`recurring` が `off` でなければ、次回の `notify_time_utc` を計算して更新する。
    - **失敗時**: `retry_count` をインクリメントし、上限に達していなければ `status` を `pending` に戻す。上限到達時は `failed` に設定する。
- [x] ボット本体とは別のプロセスとして実行するためのスクリプト (`start-scheduler` など) を `package.json` に追加する。
- [x] Docker運用時は `discord-scheduler` サービスで `scheduler.js` を常駐実行する。

## 実装のヒント

- スケジューラはボット本体のDiscordクライアントとは別に、自身のクライアントインスタンスを持つ必要がある。
- `Promise.allSettled` を使うと、複数のリマインダー通知処理を並行して行い、個々の成否をハンドリングしやすくなる。

## 関連ドキュメント

- [アーキテクチャ設計書 (`doc/reminder/04_architecture_design.md`)](./../04_architecture_design.md)
- [データベース設計書 (`doc/reminder/03_database_schema.md`)](./../03_database_schema.md)

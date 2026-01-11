目的
- Discord ボットに /remind サブコマンド群を実装する。
- 永続化は Google Sheets（シート名: Reminders）。確実に通知されるスケジューラを別プロセスで実装すること。

必須コマンド仕様
1) /remind add
- 引数: key:string(必須, 1-100) time:string(必須, 自然文 or ISO) content:string(必須, 1-2000) scope:enum(user|channel|server, default=user) visibility:enum(public|ephemeral, default=ephemeral for user) recurring:enum(off|daily|weekly|monthly, default=off) timezone:string(optional)
- 挙動: 同一(scope+key) が存在する場合はエラーを返すか、--overwrite オプションで上書き可。time は自然言語（日本語含む）をパース。パース失敗時は具体例を返す。

2) /remind get
- 引数: key:string, scope:選択
- 挙動: 指定のリマインダー詳細を返す（time はユーザーのタイムゾーンで表示）。存在しなければ該当なしメッセージ。

3) /remind list
- 引数: scope:選択, query:string(optional), limit:int(default50)
- 挙動: 箇条書きで一覧（key / 次回通知時刻 / 繰り返し / content の短縮表示）。

4) /remind delete
- 引数: key:string, scope:選択, confirm:bool(optional)
- 挙動: confirm=true で確定。server スコープの操作は管理者権限必須。

Google Sheets（Reminders）スキーマ（各列）
- id(ユニークID), key, content, scope, guild_id, channel_id, user_id, notify_time_utc(ISO8601), timezone, recurring, visibility, created_by, created_at, status(pending/sending/sent/failed), last_sent, retry_count, metadata(JSON)

永続／排他／耐障害
- スケジューラは常時稼働（またはクラウドスケジューラ）で1分毎に Reminders をクエリし、notify_time_utc <= now かつ status=pending を取得。
- 送信前に status を sending に更新して排他（楽観ロック）。更新成功した行のみ処理。
- 送信後に status=sent, last_sent を更新。失敗時は retry_count++、最大3回リトライ後 status=failed に。
- 再起動耐性のため全状態はシートで管理。

時刻処理
- 日本語の自然言語パース（例: 明日15時, 1時間後, 毎日10:00）。ライブラリ推奨: chrono-node/dateparser 等。サーバーデフォルトタイムゾーンを用いるが、users ごとの timezone を Users シートで保持可能。

通知方法／表示
- user scope: DM（ephemeral ではなく実際のDM通知）既定。channel scope: チャンネル投稿既定。visibility パラメータで表示制御。
- 登録／削除成功レスは簡潔な箇条書き。エラーは具体的に（理由＋対処例）。

権限
- server スコープ作成・削除は Guild 管理者のみ。channel scope はチャンネル管理権限またはボタン承認で制限可。

ログ／監査
- 変更ログや失敗ログは同シート内カラム、または別 Log シートに記録。

出力例（ユーザー向け）
- 成功（add）: 「✅ リマインダー登録完了 — key: 学習 / 次回: 2026-01-11 15:00 (JST) / scope: channel」
- list: 箇条書きで key — 次回 — 繰り返し — content(先頭60字)

追加納品物（要求）
- Discord のスラッシュコマンド定義 JSON（Discord API 登録用）
- Google Service Account 設定手順と必要な環境変数: BOT_TOKEN, GOOGLE_SA_KEY_JSON, SHEET_ID, DEFAULT_TZ
- スケジューラの実行手順（cron/Cloud Run 等）
- 単体テストケース（time parse の正常/異常系、権限チェック、送信フローのエラーリトリガー）
- README にデプロイ手順と運用上の注意（タイムゾーン、再実行権限、手動再送の方法）

注意点・UX
- 時刻パース失敗のときは「こう書いてください」の具体例を出すこと。
- 重要削除には確認フローを必須化。
- ユーザーに見やすい短い応答を優先する。

---

## 品質向上タスク (Post-Implementation Quality Improvements)

初期実装完了後、プロダクションレベルの品質と保守性を確保するために、以下のタスクを実施する。

1.  **ロギング強化**:
    -   **目的**: 開発中のデバッグや本番環境での問題追跡を容易にする。
    -   **内容**: `console.log` / `console.error` を構造化ロガー（例: `pino`, `winston`）に置き換える。エラー発生時には、リクエストIDや関連情報（ユーザーID、コマンド内容など）を含む詳細なログを出力する。

2.  **テスト拡充**:
    -   **目的**: コードの信頼性を高め、リファクタリングを容易にする。
    -   **内容**: Jestのカバレッジを向上させる。特に、以下のテストケースを追加する。
        -   `/remind` の `get`, `list`, `delete` サブコマンドの結合テスト。
        -   `delete` 確認ボタンのハンドラのテスト。
        -   スケジューラ (`scheduler.js`) のロジック全体のテスト（時刻通りにジョブが実行されるか、通知が正しく送信されるか、エラー処理が機能するか等）。
        -   権限チェック（管理者のみ実行可能な操作など）のテスト。

3.  **日付処理の堅牢化**:
    -   **目的**: 繰り返しリマインダーにおける日付計算のバグを解消する。
    -   **内容**: `scheduler.js` 内の自前での日付計算ロジック (`calculateNextDate`) を、実績のある日付操作ライブラリ（例: `date-fns`, `luxon`）を使用して置き換える。特に、月末や閏年を正しく扱えるようにする。
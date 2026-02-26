# Dokobasho Discord Bot

Discord上で動作する多機能ボット。リマインダー機能と `/fairy` 連携を提供します。

## 機能

- **リマインダー機能**: `/remind` コマンドを使って、個人・チャンネル・サーバー単位でのリマインダーを設定できます。
- **Fast Path 機能**: `/fairy` コマンド、Botへのメンション、Botへの返信で一次回答を返し、n8n slow-path に処理を引き継ぎます。
  - 一次回答は、これからどう進めるかを口語で簡潔に伝えます。
  - slow-path payload には `first_reply_message_id` を含めるため、n8n 側で最終回答時に一次回答を削除する運用が可能です。
  - `@fff-sissimo/fairy-core` が利用可能な環境では package 実装を優先し、取得できない場合はローカル実装へ自動フォールバックします。
- **n8n連携**: メンションや返信に反応して、指定したn8nのWebhookに情報を送信します（`FAIRY_ENABLE_MESSAGE_TRIGGER=false` の場合）。

## 開発環境のセットアップ

1.  **リポジトリをクローン:**
    ```bash
    git clone <repository_url>
    cd dokobasho-discord-bot/discord-bot
    ```

2.  **依存パッケージをインストール:**
    ```bash
    npm install
    ```
    `@fff-sissimo/fairy-core` は GitHub Packages から取得するため、インストール前に `NODE_AUTH_TOKEN` を環境変数へ設定してください。
    `discord-bot/.npmrc` は `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` を参照します。トークンの平文を `.npmrc` へ直接書かないでください。
    `NODE_AUTH_TOKEN` が未設定または無効で package を取得できない場合でも、bot はローカル実装フォールバックで動作します（ただし package 側の最新修正は反映されません）。

3.  **環境変数を設定:**
    `discord-bot` ディレクトリにある `.env_example` をコピーして `.env` ファイルを作成します。
    ```bash
    cp .env_example .env
    ```
    作成した `.env` ファイルをエディタで開き、以下の項目を設定してください。

    - `BOT_TOKEN`: Discord Developer Portalで取得したボットのトークン（旧設定の `DISCORD_BOT_TOKEN` でも可）。
    - `CLIENT_ID`: ボットのApplication ID。
    - `GUILD_ID`: 開発用のDiscordサーバーID（スラッシュコマンドを即時登録するために使用）。
    - `GOOGLE_SA_KEY_PATH`: Google Service Accountのキー(JSON)ファイルのパス（推奨）。リマインダー機能で必要。
    - `GOOGLE_SA_KEY_JSON`: (任意) Google Service Accountのキー(JSON)をBase64エンコードした文字列。ファイルを置けない場合に使用。
    - `SHEET_ID`: リマインダーのデータを保存するGoogleスプレッドシートのID。
    - `REMINDER_MAX_ROWS`: (任意) シート行数の上限。超過時は処理を停止して移行を促します。
    - `REMINDER_SENDING_TIMEOUT_MS`: (任意) `sending` 状態のリマインダーを再取得するまでの待機時間(ミリ秒)。
    - `N8N_WEBHOOK_URL`: (任意) n8n連携用のWebhook URL。
    - `N8N_WEBHOOK_SECRET`: (任意) n8n Webhook の共有シークレット。Webhook Guard を有効にしている場合は必須。
    - `N8N_BASE`: `/fairy` slow-path 連携先の n8n ベースURL。
    - `N8N_SLOW_PATH_WEBHOOK_PATH`: (任意) slow-path Webhook path。未指定時 `/webhook/fairy-slow-path`。
    - `N8N_SLOW_PATH_TIMEOUT_MS`: (任意) slow-path Webhook timeout(ms)。未指定時 `8000`。
    - `OPENAI_API_KEY`: (任意) `/fairy` 一次回答を AI 生成するための API キー。未設定時はフォールバック文を返します。
    - `NODE_AUTH_TOKEN`: GitHub Packages から `@fff-sissimo/fairy-core` を取得するための token（Hostinger 環境変数で設定）。
    - `FIRST_REPLY_AI_MODEL`: (任意) 一次回答用モデル。未指定時 `o4-mini`。
    - `FIRST_REPLY_AI_TIMEOUT_MS`: (任意) 一次回答生成タイムアウト(ms)。未指定時 `5000`。
    - `OPENAI_BASE_URL`: (任意) OpenAI API base URL。未指定時 `https://api.openai.com`。
    - `NOTION_TOKEN`: (推奨) Notion連携トークン。`n8n` と `n8n-runners` の両方に渡します。
    - `NOTION_API_KEY`: (任意) 互換用の別名トークン。`NOTION_TOKEN` を優先します。
    - `NOTION_VERSION`: (任意) Notion-Version ヘッダ。未指定時 `2022-06-28`。
    - `NOTION_API_BASE_URL`: (任意) Notion API base URL。未指定時 `https://api.notion.com/v1`。
    - `FAIRY_ENABLE_MESSAGE_TRIGGER`: (任意) `true/1` でメンション・返信を `/fairy` と同等に処理。未指定時 `true`。`false/0` の場合は従来の `N8N_WEBHOOK_URL` 経路を使います。
    - `PERMANENT_MEMORY_SYNC_ENABLED`: (任意) `true/1` で恒久記憶同期Webhook受信を有効化。未指定時 `true`。
    - `PERMANENT_MEMORY_SYNC_PORT`: (任意) 同期Webhook受信ポート。未指定時 `8789`。
    - `PERMANENT_MEMORY_SYNC_PATH`: (任意) 同期Webhook受信パス。未指定時 `/internal/permanent-memory/sync`。
    - `PERMANENT_MEMORY_READ_PATH`: (任意) 恒久記憶Markdown読取パス。未指定時 `/internal/permanent-memory/read`。
    - `PERMANENT_MEMORY_SYNC_TOKEN`: (推奨) 同期Webhook共有トークン。n8nのHTTP Requestから `x-permanent-sync-token` で送信してください。
    - `PERMANENT_MEMORY_SYNC_DIR`: (任意) Markdown保存ディレクトリ。未指定時 `/opt/dokobasho/permanent-memory`。
    - `PERMANENT_MEMORY_SYNC_FILE`: (任意) Markdown保存ファイル名。未指定時 `permanent-memory.md`。
    - `PERMANENT_MEMORY_READ_MAX_CHARS`: (任意) 読取APIで返す最大文字数。未指定時 `8000`。

4.  **Google Service Account と Google Sheets API の設定:**
    - Google Cloud Platformでプロジェクトを作成し、Google Sheets APIを有効にします。
    - サービスアカウントを作成し、キー（JSON形式）をダウンロードします。
    - 作成したサービスアカウントのメールアドレスに、対象のGoogleスプレッドシートの編集権限を付与します。
    - ダウンロードしたキーファイルは、権限を制限したパスに保存し、そのパスを `.env` の `GOOGLE_SA_KEY_PATH` に設定します（推奨）。
    - ファイル配置が難しい場合のみ、キーファイルの内容をBase64エンコードし `.env` の `GOOGLE_SA_KEY_JSON` に設定します。
    - 本番運用では Secret Manager 等の機密情報管理サービスの利用を推奨します。

## コマンド

`discord-bot` ディレクトリで以下のコマンドを実行します。

-   **スラッシュコマンドの登録:**
    ```bash
    npm run deploy-commands
    ```
    ボットをサーバーに追加した後、最初にこのコマンドを実行して `/remind` コマンドを登録する必要があります。

-   **ボットの起動:**
    ```bash
    npm start
    ```

-   **スケジューラの起動:**
    リマインダーの通知を処理するためには、ボット本体とは別にスケジューラを起動する必要があります。
    ```bash
    npm run start-scheduler
    ```

-   **テストの実行:**
    ```bash
    npm test
    ```

### Docker 運用時の補足

-   **スラッシュコマンドの登録:**
    ```bash
    docker compose exec discord-bot node deploy-commands.js
    ```

-   **スケジューラの起動:**
    リマインダーを常時稼働させるには、`docker compose` の `discord-scheduler` サービスを起動してください。
    ```bash
    docker compose up -d discord-scheduler
    ```

-   **共有イメージ:**
    `discord-bot` と `discord-scheduler` は `dokobasho-discord-bot:${DISCORD_BOT_IMAGE_TAG:-local}` を共有します。
    運用環境では `DISCORD_BOT_IMAGE_TAG` にバージョン（例: `v1.2.3`）を指定してください。
    コード更新時は両方のコンテナを再作成してください。
    ```bash
    docker compose build discord-bot
    docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler
    ```
    クリーンビルドが必要な場合は以下も実行してください。
    ```bash
    docker compose down -v
    ```

-   **Googleサービスアカウント鍵のマウント:**
    `GOOGLE_SA_KEY_PATH` を使う場合、ホストの鍵ファイルをコンテナにマウントします。
    既定では `./discord-bot/google-service-key.json` を
    `/app/keys/google-service-key.json` にマウントします。
    別パスを使う場合はホスト側の `GOOGLE_SA_KEY_FILE` を指定してください。
    セキュリティのため、鍵ファイルはリポジトリ外に保存し、絶対パスで `GOOGLE_SA_KEY_FILE` を設定する運用を推奨します。
    コンテナ内の `.env` には `GOOGLE_SA_KEY_PATH=/app/keys/google-service-key.json` を設定してください。

-   **恒久記憶 Markdown の保存先:**
    Hostinger の現行構成では `/docker/n8n/discord-bot-runtime` をコンテナ内 `/opt/dokobasho` へマウントしているため、既定の保存先 `/opt/dokobasho/permanent-memory` は VPS 側に永続化されます。
    n8n からは `http://discord-bot:${PERMANENT_MEMORY_SYNC_PORT}${PERMANENT_MEMORY_SYNC_PATH}` へ
    `POST` し、ヘッダー `x-permanent-sync-token` に `PERMANENT_MEMORY_SYNC_TOKEN` を設定してください。
    親AI などの読取側は `http://discord-bot:${PERMANENT_MEMORY_SYNC_PORT}${PERMANENT_MEMORY_READ_PATH}?tail_chars=4000`
    を `GET` し、必要に応じて同じ `x-permanent-sync-token` ヘッダーを付与してください。

### fairy-core 本番反映手順

`@fff-sissimo/fairy-core` を更新して反映する場合は、以下の順で実施します。

1. `discord-bot/package.json` の `@fff-sissimo/fairy-core` version を更新する（固定 version）。
2. Hostinger の環境変数に `NODE_AUTH_TOKEN` が設定されていることを確認する。
3. `discord-bot` ディレクトリで `npm ci --omit=dev` を実行する。
4. `docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler` で再起動する。
5. `/fairy` の一次回答と slow-path 連携をスモーク確認する。

### fairy-core ロールバック手順

障害時は次の手順でロールバックします。

1. `discord-bot/package.json` の `@fff-sissimo/fairy-core` を **1 version** 前に戻す。
2. `npm ci --omit=dev` を実行する。
3. `docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler` で再起動する。
4. 復旧確認後、障害ログへ「原因・実施時刻・再発防止案」を記録する。

## 運用上の注意

-   **タイムゾーン**: 時刻の解釈にはサーバーのデフォルトタイムゾーンが使われますが、`/remind add` の `timezone` オプションで個別に指定することも可能です。
-   **server スコープ**: `/remind add` で `scope=server` を指定する場合、通知先チャンネルの指定が必須です。
-   **Google Sheetsの制約**: リマインダー数が増えると一覧・検索の応答が遅くなる可能性があります。大規模運用では専用DBへの移行を推奨します。
-   **スケジューラの常時実行**: リマインダーを確実に通知するためには、`start-scheduler` プロセスをデーモン化するか、`systemd` や `pm2` などのプロセス管理ツールを使って常時実行させる必要があります。
-   **Google Sheetsのスキーマ**: `Reminders` という名前のシートを作成し、1行目にヘッダーとして以下の項目を順に設定してください:
    `id,key,content,scope,guild_id,channel_id,user_id,notify_time_utc,timezone,recurring,visibility,created_by,created_at,status,last_sent,retry_count,metadata`
-   **status の値**: `pending`, `sending`, `sent`, `failed`, `deleted`
-   **エラーログ**: ボットやスケジューラの実行中にエラーが発生した場合、コンソールにログが出力されます。問題が発生した場合は、これらのログを確認してください。`status` が `failed` になったリマインダーは、手動での対応が必要です。

---
discord-botのみ起動
docker compose -f ... up -d --build --no-deps discord-bot

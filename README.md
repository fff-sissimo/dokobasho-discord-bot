# Dokobasho Discord Bot

Discord上で動作する多機能ボット。リマインダー機能と `/fairy` 連携を提供します。

## 機能

- **リマインダー機能**: `/remind` コマンドを使って、個人・チャンネル・サーバー単位でのリマインダーを設定できます。
- **Fast Path 機能**: `/fairy` コマンド、Botへのメンション、Botへの返信で一次回答を返し、n8n slow-path に処理を引き継ぎます。
  - 一次回答は、これからどう進めるかを口語で簡潔に伝えます。
  - slow-path payload には `first_reply_message_id` を含めるため、n8n 側で最終回答時に一次回答を削除する運用が可能です。
  - 一次回答生成と slow-path payload 生成は `@fff-sissimo/fairy-core` 実装を利用します（ローカルフォールバックなし）。
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
    `NODE_AUTH_TOKEN` が未設定または無効で package を取得できない場合、bot は起動できません。先に認証情報を設定してください。

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
    - `FAIRY_RUNTIME_MODE`: (任意) `/fairy` とメンション/返信の実行経路。未指定時 `n8n`。`openclaw` で OpenClaw 直接実行。
    - `OPENCLAW_API_URL`: (`FAIRY_RUNTIME_MODE=openclaw` で必須) OpenClaw 判断 API の完全 URL。
    - `OPENCLAW_API_KEY`: (`FAIRY_RUNTIME_MODE=openclaw` で必須) OpenClaw 判断 API 用の Bearer token。
    - `OPENCLAW_API_TIMEOUT_MS`: (任意) OpenClaw 判断 API の timeout(ms)。未指定時 `85000`。
    - `FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS`: (`FAIRY_RUNTIME_MODE=openclaw` で必須) OpenClaw 直接実行を許可する channel ID の comma-separated list。Phase1 sandbox は `1094907178671939654`、Phase2 chat は権限確認後に `840827137451229210` を追加。
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
4. Hostinger の共有 volume 運用では `discord-bot/scripts/runtime-bootstrap.sh` を使い、`discord-bot` と `discord-scheduler` が同時に `npm ci` しないようにする。
5. `docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler` で再起動する。
5. `/fairy` の一次回答と slow-path 連携をスモーク確認する。
6. reminder の誤登録防止を確認する。
   - `@どこばしょのようせい test` のような曖昧入力で、Bot の一次回答文が履歴候補として採用されないことを確認する。
   - 明示的な本文（例: `5分後に「洗濯物を取り込む」`）では従来どおり登録できることを確認する。

### OpenClaw direct runtime v1 rollout

`FAIRY_RUNTIME_MODE=openclaw` では、既存 n8n slow-path を使わず OpenClaw API へ直接判断 payload を送ります。
Phase1 は `FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS=1094907178671939654` のみで運用済みです。
Phase2 は `はじまりの酒場` の Discord channel overwrite を確認してから `840827137451229210` を追加してください。
message trigger は mention / Bot への reply に限定され、通常会話の全件 passive observe は行いません。

起動前に必須:

- `BOT_TOKEN` または `DISCORD_BOT_TOKEN`
- `GUILD_ID`
- `OPENCLAW_API_URL`
- `OPENCLAW_API_KEY`
- `FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS`

Hostinger では `openclaw-api` service を Docker 内部だけで起動します。Traefik label と host port は付けません。

```bash
docker compose --profile openclaw up -d --build openclaw-api
docker compose --profile openclaw up -d --no-deps --force-recreate discord-bot
```

`discord-bot/.env` の OpenClaw 設定例:

```env
FAIRY_RUNTIME_MODE=openclaw
OPENCLAW_API_URL=http://openclaw-api:8788/discord/respond
OPENCLAW_API_KEY=<openssl rand -base64 32 で生成した共有シークレット>
OPENCLAW_API_TIMEOUT_MS=85000
FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS=1094907178671939654
```

Phase2 有効化時の allowlist 例:

```env
FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS=1094907178671939654,840827137451229210
```

`openclaw-api` は同じ `discord-bot/.env` から `OPENCLAW_API_KEY` を読みます。Hostinger で `dokobasho-fairy-openclaw` の配置場所が既定と違う場合は、Compose 実行環境に `OPENCLAW_WORKSPACE_HOST_DIR=/path/to/dokobasho-fairy-openclaw` を設定してください。
既定の `OPENCLAW_AGENT_MODE=local` では、`openclaw-api` container 内の OpenClaw CLI が直接 agent turn を実行します。OpenClaw の state は `OPENCLAW_STATE_HOST_DIR`（未指定時 `./openclaw-state`）から `/root/.openclaw` へマウントされます。

送信直前 gate は、allowlist 外チャンネル、承認必須応答、everyone/here、role mention、添付、外部 URL を自動送信しません。
payload の `channel.type` は v1 registry から解決し、`840827137451229210` は `chat` として OpenClaw に渡します。
rollback は `FAIRY_RUNTIME_MODE=n8n` に戻して `discord-bot` service を再作成します。

#### fairy-core v1.1.0 の追加確認項目（speaker-aware context）

- slow-path payload の `context_entries` が送信されること（`context_excerpt` は互換保持）。
- `context_entries` では `author_is_bot=true` の履歴が除外されること。
- reminder 本文補完は依頼者 (`author_user_id == user_id`) の発言が優先されること。

#### fairy-core v2.0.0 の移行確認項目（schema v3 / reply antecedent）

- slow-path payload の `schema_version` が `3` で送信されること。
- `/fairy`・メンション・返信の一次回答は package 実装の acknowledgement 文面を使うこと。
- reply / mention+reply 経路では、replied target semantics を `reply_antecedent_entry` として送信できること。
- `reply_antecedent_entry` は `message_id`, `author_user_id`, `author_is_bot`, `content` を満たすこと。
- worker 側が `schema_version=2|3` の dual-accept 期間で動作していることを確認してから切り替えること。
- package 読み込みに失敗した場合、bot 全体を落とすのではなく fairy 機能だけが disable されることをログで確認すること。

### fairy-core ロールバック手順

障害時は次の手順でロールバックします。

1. `discord-bot/package.json` の `@fff-sissimo/fairy-core` を **1 version** 前に戻す。
2. `npm ci --omit=dev` を実行する。
3. Hostinger の共有 volume 運用では `discord-bot/scripts/runtime-bootstrap.sh` を使い、`discord-bot` と `discord-scheduler` が同時に `npm ci` しないようにする。
4. `docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler` で再起動する。
5. 復旧確認後、障害ログへ「原因・実施時刻・再発防止案」を記録する。

#### fairy-core v2.0.0 からのロールバック補足

- `schema_version=3` を送る bot を戻す前に、worker が `schema_version=2` を受け取れる状態であることを確認する。
- `reply_antecedent_entry` を使った reminder / mention+reply canary を再実行し、旧系で誤解釈や enqueue failure が出ないことを確認する。

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

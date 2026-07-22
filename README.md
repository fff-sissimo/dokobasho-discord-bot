# Dokobasho Discord Bot

Discord上で動作する多機能ボット。リマインダー機能と、停止可能な `/fairy` 応答口を提供します。

## 機能

- **リマインダー機能**: `/remind` コマンドを使って、個人・チャンネル・サーバー単位でのリマインダーを設定できます。
- **fairy 応答停止**: OpenClaw 撤退後の既定は `FAIRY_ENABLED=false` です。`/fairy` は停止メッセージを ephemeral 返信し、Botへのメンション/返信には無応答です。
- **Local slow-path 機能**: 将来 `FAIRY_ENABLED=true` にした場合のみ、`/fairy` コマンド、Botへのメンション、Botへの返信で一次回答を返し、n8n slow-path に処理を引き継ぎます。
  - 一次回答生成と slow-path payload contract は repo 内の local 実装を利用します。Hostinger runtime は private package install に依存しません。
- **n8n連携**: `FAIRY_ENABLED=true` かつ `FAIRY_ENABLE_MESSAGE_TRIGGER=false` の場合、メンションや返信に反応して指定したn8nのWebhookに情報を送信します。
- **画像生成**: テスト用チャンネルで自然文画像生成依頼を確認ボタン付きで受け付け、`/image` コマンドでは確認なしでn8n画像生成Webhookへ接続します。

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
    private package は runtime dependency ではありません。`NODE_AUTH_TOKEN` が未設定または無効でも bot は起動できます。
    Node.js は `22.12.0` 以上の22系を使用してください（`.nvmrc` を正本とします）。

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
    - `FAIRY_ENABLED`: (任意) `true/1` で `/fairy`・メンション・Bot返信の応答を有効化。OpenClaw 撤退後の既定は `false`。
    - `N8N_BASE`: `/fairy` slow-path 連携先の n8n ベースURL。
    - `N8N_SLOW_PATH_WEBHOOK_PATH`: (任意) slow-path Webhook path。未指定時 `/webhook/fairy-slow-path`。
    - `N8N_SLOW_PATH_TIMEOUT_MS`: (任意) slow-path Webhook timeout(ms)。未指定時 `8000`。
    - `OPENAI_API_KEY`: (任意) `/fairy` 一次回答を AI 生成するための API キー。未設定時はフォールバック文を返します。
    - `NODE_AUTH_TOKEN`: (任意) GitHub Packages を使う開発・検証時だけ設定します。通常 runtime 起動には不要です。
    - `FIRST_REPLY_AI_MODEL`: (任意) 一次回答用モデル。未指定時 `o4-mini`。
    - `FIRST_REPLY_AI_TIMEOUT_MS`: (任意) 一次回答生成タイムアウト(ms)。未指定時 `5000`。
    - `OPENAI_BASE_URL`: (任意) OpenAI API base URL。未指定時 `https://api.openai.com`。
    - `NOTION_TOKEN`: (推奨) Notion連携トークン。`n8n` と `n8n-runners` の両方に渡します。
    - `NOTION_API_KEY`: (任意) 互換用の別名トークン。`NOTION_TOKEN` を優先します。
    - `NOTION_VERSION`: (任意) n8n / n8n-runners 向け Notion-Version ヘッダ。未指定時 `2022-06-28`。
    - `NOTION_API_BASE_URL`: (任意) Notion API base URL。未指定時 `https://api.notion.com/v1`。
    - `DISCORD_BOT_TOKEN` / `BOT_TOKEN`: n8n の Discord workflow で使う bot token。n8n / n8n-runners の環境変数として参照します。
    - `FAIRY_ENABLE_MESSAGE_TRIGGER`: (任意) `true/1` でメンション・返信を `/fairy` と同等に処理。未指定時 `true`。`false/0` の場合は従来の `N8N_WEBHOOK_URL` 経路を使います。
    - `FAIRY_CONTEXT_MAX_MESSAGES`: (任意) `/fairy` / mention / bot reply で slow-path へ渡す Discord 会話履歴の最大件数。未指定時 `80`、上限 `100`。
    - `FAIRY_CONTEXT_MAX_CHARS`: (任意) Discord 会話履歴本文の合計文字数上限。未指定時 `18000`、上限 `24000`。
    - `FAIRY_CONTEXT_AROUND_LIMIT`: (任意) Discord URL や reply 参照 message 周辺を取得する件数。未指定時 `50`。
    - `FAIRY_CONTEXT_MAX_FETCH_BATCHES`: (任意) 通常履歴をさかのぼる fetch 回数。未指定時 `3`。
    - `PERMANENT_MEMORY_SYNC_ENABLED`: (任意) `true/1` で恒久記憶同期Webhook受信を有効化。未指定時 `true`。
    - `PERMANENT_MEMORY_SYNC_HOST`: (任意) 同期Webhook待受ホスト。未指定時 `0.0.0.0`。非loopbackではtoken必須です。
    - `PERMANENT_MEMORY_SYNC_PORT`: (任意) 同期Webhook受信ポート。未指定時 `8789`。
    - `PERMANENT_MEMORY_SYNC_PATH`: (任意) 同期Webhook受信パス。未指定時 `/internal/permanent-memory/sync`。
    - `PERMANENT_MEMORY_READ_PATH`: (任意) 恒久記憶Markdown読取パス。未指定時 `/internal/permanent-memory/read`。
    - `PERMANENT_MEMORY_SYNC_TOKEN`: (推奨) 同期Webhook共有トークン。n8nのHTTP Requestから `x-permanent-sync-token` で送信してください。
    - `PERMANENT_MEMORY_SYNC_DIR`: (任意) Markdown保存ディレクトリ。未指定時 `/opt/dokobasho/permanent-memory`。
    - `PERMANENT_MEMORY_SYNC_FILE`: (任意) Markdown保存ファイル名。未指定時 `permanent-memory.md`。
    - `PERMANENT_MEMORY_READ_MAX_CHARS`: (任意) 読取APIで返す最大文字数。未指定時 `8000`。
    - `RESOURCE_API_HOST`: (任意) Hermes連携用 reminder 内部APIの待受ホスト。未指定時 `0.0.0.0`。
    - `RESOURCE_API_PORT`: (任意) Hermes連携用 reminder 内部APIの待受ポート。未指定時 `8790`。
    - `RESOURCE_API_PATH_PREFIX`: (任意) reminder 内部APIのpath prefix。未指定時 `/internal/remind`。
    - `RESOURCE_API_TOKEN`: (推奨) Hermes plugin から `x-resource-api-token` で送る共有トークン。
    - `INTERNAL_API_ALLOW_INSECURE_LOOPBACK`: tokenなしでloopbackへ待ち受けるローカル開発時だけ `true`。非loopbackではtokenが常に必須です。
    - `SCHEDULER_DISCORD_DELIVERY_MODE`: (任意) `gateway` または `rest`。Hermes Gateway一本化時は `rest` を使い、schedulerのDiscord Gateway loginを止めます。
    - `DISCORD_API_BASE_URL`: (任意) Discord REST API base URL。未指定時 `https://discord.com/api/v10`。
    - `DOKOBASHO_IMAGE_ENABLED`: 画像生成runtimeの明示enable。未指定/defaultは `false`。初回E2E時だけ `true` にしてください。
    - `DOKOBASHO_IMAGE_WEBHOOK_URL`: 画像生成用n8n Webhook URL。
    - `DOKOBASHO_IMAGE_WEBHOOK_TOKEN`: 画像生成WebhookのBearer token。秘密値として管理し、READMEやログへ直書きしないでください。
    - `DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS`: 初回E2Eで画像生成を許可するDiscordチャンネルIDのカンマ区切り。未設定/空は全許可になりません。
    - `DOKOBASHO_IMAGE_ALLOW_ALL_CHANNELS`: 全チャンネル許可の明示フラグ。全公開前は `false` のままにしてください。
    - `DOKOBASHO_IMAGE_DISABLED_GUILD_IDS`: 緊急停止/段階公開用の停止サーバーIDカンマ区切り。
    - `DOKOBASHO_IMAGE_DISABLED_USER_IDS`: 緊急停止/段階公開用の停止ユーザーIDカンマ区切り。
    - `DOKOBASHO_IMAGE_TIMEOUT_MS`: Hermes側のn8n Webhook timeout。未指定時 `130000`。
    - `DOKOBASHO_IMAGE_INTENT_CONFIDENCE_THRESHOLD`: 自然文画像生成判定の閾値。未指定時 `0.80`。
    - `DOKOBASHO_IMAGE_CONFIRMATION_TTL_SECONDS`: 確認ボタンの有効期限。未指定時 `180`。
    - `DOKOBASHO_IMAGE_INTENT_MODEL`: `OPENAI_API_KEY` がある場合に使う画像生成意図判定モデル。
    - `DOKOBASHO_IMAGE_INTENT_TIMEOUT_MS`: 画像生成意図判定のtimeout。未指定時 `5000`。
    - `DOKOBASHO_IMAGE_USER_LIMIT_PER_HOUR`: 第2フェーズ用のユーザー単位レート制限。未指定時 `5`。
    - `DOKOBASHO_IMAGE_GUILD_LIMIT_PER_DAY`: 第2フェーズ用のサーバー単位レート制限。未指定時 `100`。
    - `DOKOBASHO_IMAGE_GUILD_CONCURRENCY`: サーバー単位同時実行数。未指定時 `2`。
    - `DOKOBASHO_IMAGE_GUILD_QUEUE_SIZE`: サーバー単位queue上限。未指定時 `5`。
    - `DOKOBASHO_IMAGE_QUEUE_TTL_SECONDS`: queue待ち期限。未指定時 `900`。
    - `VC_MEMO_ENABLED`: `/vc-memo` の有効化。既定は `false`。
    - `VC_MEMO_CACHE_DIR`: 音声、全文文字起こし、ドラフトの永続保存先。Docker既定は `/opt/dokobasho/vc-memo`。
    - `VC_MEMO_ALLOWED_GUILD_IDS` / `VC_MEMO_ALLOWED_CHANNEL_IDS`: `VC_MEMO_ENABLED=true` の場合は必須。録音を許可するサーバー/VCをカンマ区切りで指定します。
    - `VC_MEMO_MAX_SESSION_BYTES`: (任意) 1セッションあたりのPCM保存上限bytes。未指定時は `104857600`。
    - `VC_MEMO_STT_TIMEOUT_MS` / `VC_MEMO_STT_RETRIES`: STTのtimeoutと再試行回数。
    - `VC_MEMO_SUMMARY_TIMEOUT_MS` / `VC_MEMO_SUMMARY_MAX_CHUNK_CHARS`: 要約timeoutと長文分割サイズ。
    - `DISCORD_MESSAGE_CONTENT_INTENT_ENABLED`: Message Content Intentを要求するか。既定は `true`。

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

-   **Hermes reminder 内部APIの起動:**
    Discord Gatewayへログインせず、Hermes plugin から reminder 資産だけを呼び出す場合に起動します。
    ```bash
    npm run start-resource-server
    ```

-   **テストの実行:**
    ```bash
    npm test
    ```

-   **統合チェック:**
    ```bash
    npm run check
    ```

### 画像生成の運用メモ

- `/image` コマンド登録後に使えます。初回E2Eでは `DOKOBASHO_IMAGE_ENABLED=true`、`DOKOBASHO_IMAGE_WEBHOOK_TOKEN`、`DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS` の指定が必須です。
- `DOKOBASHO_IMAGE_ALLOWED_CHANNEL_IDS` が未設定/空の場合、画像生成は全チャンネル許可になりません。全チャンネルへ公開する場合だけ `DOKOBASHO_IMAGE_ALLOW_ALL_CHANNELS=true` を明示してください。
- `DOKOBASHO_IMAGE_DISABLED_GUILD_IDS` / `DOKOBASHO_IMAGE_DISABLED_USER_IDS` でサーバー/ユーザー単位の停止ができます。該当時はn8nやintent detectorを呼びません。
- n8n Webhook token と OpenAI API key は秘密値です。`.env` やSecret Managerで管理し、リポジトリ、README、ログへ直書きしないでください。
- Discord本文にはprompt全文、model、request_idを原則表示しません。失敗時も安全な短文だけを返します。
- 現在の画像生成state、rate limit、queueはin-memoryの単一プロセス前提です。複数プロセス/複数インスタンス運用ではDB等の共有storeへ差し替えてください。
- n8n側はexecution dataにprompt本文、画像base64、secretが長期保存されない設定を確認してからlive E2Eへ進めてください。

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

-   **Hermes reminder 内部API service:**
    Hostinger構成では `discord-resource-service` を外部公開portなしで起動し、Hermes側コンテナと共通の external network `dokobasho-internal` で接続します。
    事前にVPSで `docker network create dokobasho-internal` を実行しておきます。

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

-   **Hostingerのソース固定:**
    Hostinger構成では `APP_COMMIT` にデプロイ対象の完全な40桁commit SHAを設定してください。
    branch名や可変HEADは受け付けず、checkout後のHEAD一致検証に失敗するとコンテナは起動しません。

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

### fairy runtime 本番反映手順

OpenClaw 撤退後、Bot runtime の正本は `FAIRY_ENABLED=false` による fairy 応答停止です。`/fairy` は停止メッセージを ephemeral 返信し、メンション・Bot返信には無応答です。リマインダーと恒久記憶 sync は引き続き動作します。

1. `discord-bot` ディレクトリで `npm ci --omit=dev` を実行できることを確認する。
2. Hostinger の共有 volume 運用では `discord-bot/scripts/runtime-bootstrap.sh` を使い、`discord-bot` と `discord-scheduler` が同時に `npm ci` しないようにする。
3. `FAIRY_ENABLED=false` を設定し、`docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler` で再起動する。
4. `/fairy` が停止メッセージを ephemeral 返信し、Bot へのメンション・返信が無応答であることを確認する。
5. `/remind` と scheduler heartbeat、恒久記憶 sync が従来どおり動くことを確認する。

将来 local slow-path を再開する場合だけ `FAIRY_ENABLED=true` にし、以下の contract を確認してください。

#### fairy-core v1.1.0 の追加確認項目（speaker-aware context）

- slow-path payload の `context_entries` が送信されること（`context_excerpt` は互換保持）。
- `context_entries` では `author_is_bot=true` の履歴が除外されること。
- reminder 本文補完は依頼者 (`author_user_id == user_id`) の発言が優先されること。

#### local slow-path contract schema v3 の確認項目

- slow-path payload の `schema_version` が `3` で送信されること。
- `/fairy`・メンション・返信の一次回答は local 実装の acknowledgement 文面を使うこと。
- reply / mention+reply 経路では、replied target semantics を `reply_antecedent_entry` として送信できること。
- `reply_antecedent_entry` は `message_id`, `author_user_id`, `author_is_bot`, `content` を満たすこと。
- worker 側が `schema_version=2|3` の dual-accept 期間で動作していることを確認してから切り替えること。

### fairy runtime ロールバック手順

障害時は次の手順でロールバックします。

1. 対象 branch を直前の verified commit へ戻す、または hotfix commit を revert する。
2. `npm ci --omit=dev` を実行する。
3. Hostinger の共有 volume 運用では `discord-bot/scripts/runtime-bootstrap.sh` を使い、`discord-bot` と `discord-scheduler` が同時に `npm ci` しないようにする。
4. `docker compose up -d --no-deps --force-recreate discord-bot discord-scheduler` で再起動する。
5. 復旧確認後、障害ログへ「原因・実施時刻・再発防止案」を記録する。

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

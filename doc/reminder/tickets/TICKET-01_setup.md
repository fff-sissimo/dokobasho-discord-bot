# TICKET-01: 環境構築とプロジェクトセットアップ

## 概要

リマインダー機能開発に必要なライブラリの導入と、外部サービス連携のための環境設定を行う。

## ToDo

- [ ] 以下のnpmパッケージをインストールする:
    - `discord.js`: Discordボットのフレームワーク
    - `google-auth-library`, `googleapis`: Google Sheets API連携用
    - `chrono-node`: 自然言語の時刻解析用
    - `dotenv`: 環境変数の管理用
    - `uuid`: ユニークID生成用
- [ ] `.env` ファイルを作成し、`.env_example` を参考に以下の環境変数を定義する。
    - `BOT_TOKEN` (または `DISCORD_BOT_TOKEN`)
    - `GOOGLE_SA_KEY_JSON` (Base64エンコードしたJSONキー)
    - `SHEET_ID`
    - `DEFAULT_TZ`
- [ ] Google Service Account を設定し、キーファイル(JSON)を取得する手順をまとめる。
- [ ] Google Sheets API を有効化し、Service Accountにスプレッドシートへの編集権限を付与する。

## 実装のヒント

- `discord.js` の `Client` 、`google-auth-library` の `JWT`、`googleapis` の `sheets` を利用して、各サービスへの接続クライアントを初期化するモジュールを作成すると良い。

## 関連ドキュメント

- [アーキテクチャ設計書 (`doc/reminder/04_architecture_design.md`)](./../04_architecture_design.md)

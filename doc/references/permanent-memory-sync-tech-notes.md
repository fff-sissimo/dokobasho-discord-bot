# Permanent Memory Sync 技術参照メモ

作成日: 2026-02-24

## 参照方針
- Context7 MCP はタイムアウトで取得不可だったため、公式ドキュメントを直接参照した。
- 実装判断は以下の一次情報に基づく。

## Node.js
- HTTP サーバー: https://nodejs.org/api/http.html
  - `http.createServer()` で軽量な受信エンドポイントを実装可能。
- File system: https://nodejs.org/api/fs.html
  - `fs.promises.mkdir({ recursive: true })` で保存先ディレクトリの事前作成。
  - `fs.promises.appendFile()` で Markdown 追記。

## n8n
- Webhook node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- HTTP Request node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/
  - JSON body とカスタムヘッダーを送れるため、`x-permanent-sync-token` 付きPOSTを送信する設計とする。

## 実装要点
- n8n から `discord-bot` コンテナ内の内部HTTPエンドポイントへPOST。
- 受信 payload を Markdown に整形し、VPS 上の bind mount ディレクトリへ保存。
- トークン一致と payload 最低限バリデーションを実装する。

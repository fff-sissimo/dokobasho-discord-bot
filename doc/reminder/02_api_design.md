# 2. API設計書 (Discordスラッシュコマンド)

## 2.1. コマンド定義 (JSON)

Discord APIに登録するためのスラッシュコマンド定義。

実装のソースは `discord-bot/src/commands.js` を参照し、こちらの内容と同期する。

```jsonc
[
  {
    "name": "remind",
    "description": "リマインダーを管理します。",
    "options": [
      {
        "name": "add",
        "description": "新しいリマインダーを登録します (キーは自動生成: 8文字)。",
        "type": 1, // SUB_COMMAND
        "options": [
          {
            "name": "time",
            "description": "通知時刻 (例: 「明日の15時」「10分後」「3日後 10:00」)",
            "type": 3, // STRING
            "required": true
          },
          {
            "name": "content",
            "description": "リマインド内容 (1-2000文字)",
            "type": 3, // STRING
            "required": true
          },
          {
            "name": "scope",
            "description": "公開範囲 (デフォルト: user)",
            "type": 3, // STRING
            "required": false,
            "choices": [
              { "name": "自分のみ (User)", "value": "user" },
              { "name": "このチャンネル (Channel)", "value": "channel" },
              { "name": "サーバー全体 (Server)", "value": "server" }
            ]
          },
          {
            "name": "channel",
            "description": "通知先チャンネル (scope=server の場合は必須)",
            "type": 7, // CHANNEL
            "required": false
          },
          {
            "name": "visibility",
            "description": "応答の可視性 (デフォルト: ephemeral)",
            "type": 3, // STRING
            "required": false,
            "choices": [
              { "name": "自分のみに表示 (Ephemeral)", "value": "ephemeral" },
              { "name": "全員に表示 (Public)", "value": "public" }
            ]
          },
          {
            "name": "recurring",
            "description": "繰り返しの設定 (デフォルト: off)",
            "type": 3, // STRING
            "required": false,
            "choices": [
              { "name": "しない (Off)", "value": "off" },
              { "name": "毎日 (Daily)", "value": "daily" },
              { "name": "毎週 (Weekly)", "value": "weekly" },
              { "name": "毎月 (Monthly)", "value": "monthly" }
            ]
          },
          {
            "name": "timezone",
            "description": "時刻の解釈に使うタイムゾーン (例: Asia/Tokyo / +09:00 / JST)",
            "type": 3, // STRING
            "required": false
          }
        ]
      },
      {
        "name": "list",
        "description": "リマインダーの一覧を表示します。",
        "type": 1, // SUB_COMMAND
        "options": [
          {
            "name": "scope",
            "description": "一覧表示する公開範囲",
            "type": 3, // STRING
            "required": true,
            "choices": [
              { "name": "自分のみ (User)", "value": "user" },
              { "name": "このチャンネル (Channel)", "value": "channel" },
              { "name": "サーバー全体 (Server)", "value": "server" }
            ]
          },
          {
            "name": "query",
            "description": "キーまたは内容で検索します",
            "type": 3, // STRING
            "required": false
          },
          {
            "name": "limit",
            "description": "表示件数 (デフォルト: 50)",
            "type": 4, // INTEGER
            "required": false
          }
        ]
      },
      {
        "name": "delete",
        "description": "リマインダーを削除します。",
        "type": 1, // SUB_COMMAND
        "options": [
          {
            "name": "key",
            "description": "削除するリマインダーのキー",
            "type": 3, // STRING
            "required": true
          },
          {
            "name": "scope",
            "description": "公開範囲",
            "type": 3, // STRING
            "required": true,
            "choices": [
              { "name": "自分のみ (User)", "value": "user" },
              { "name": "このチャンネル (Channel)", "value": "channel" },
              { "name": "サーバー全体 (Server)", "value": "server" }
            ]
          },
          {
            "name": "confirm",
            "description": "確認なしで削除を実行しますか？ (デフォルト: false)",
            "type": 5, // BOOLEAN
            "required": false
          }
        ]
      }
    ]
  }
]
```

- `key` は `/remind add` 実行時に8文字の英数字 (I/O/0/1 を除外) で自動生成され、レスポンスおよび `/remind list` に表示される。既存キーの長さは制限せず、`list`/`delete` は文字列として扱う。
- `/remind get` は運用中止のため、コマンド登録対象外とする。

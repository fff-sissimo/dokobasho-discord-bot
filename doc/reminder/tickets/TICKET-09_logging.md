# TICKET-09: ロギング強化

## 概要

`console.log` / `console.error` ベースの現行ロギングを、構造化ロガーに置き換える。これにより、開発中のデバッグ効率と本番環境での問題追跡能力を向上させる。

## ToDo

- [ ] ロギングライブラリを選定し、導入する (例: `pino`, `winston`)。
- [ ] アプリケーション全体で利用するシングルトンのロガーインスタンスを作成するモジュールを実装する。
- [ ] `index.js`, `command-handler.js`, `scheduler.js` 等に含まれる既存の `console.*` 呼び出しを、新しいロガーインスタンスのメソッド (`logger.info`, `logger.error` 等) に置き換える。
- [ ] エラーログには、スタックトレースに加えて、可能な限りコンテキスト情報（コマンド名、ユーザーID、引数など）を含めるようにする。
- [ ] ログレベル（`info`, `warn`, `error`, `debug`）を適切に使い分ける。

## 関連ドキュメント

- [品質向上タスク in requirement.md (`../requirement.md`)](./../requirement.md)

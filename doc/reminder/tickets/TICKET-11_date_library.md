# TICKET-11: 日付処理の堅牢化

## 概要

`scheduler.js` 内の自前の日付計算ロジック (`calculateNextDate`) を、実績のある日付操作ライブラリ（例: `date-fns`, `luxon`）に置き換える。これにより、月末処理や閏年などのエッジケースにおけるバグを解消し、日付関連処理の信頼性を向上させる。

## ToDo

- [ ] 日付操作ライブラリを選定し、`npm install` で追加する (例: `date-fns`)。
- [ ] `utils.js` の `calculateNextDate` 関数を、新しいライブラリの関数を使って再実装する。
- [ ] **テストの修正・拡充 (`utils.test.js`):**
    - [ ] 既存のテストケースを新しい実装に合わせて修正する。
    - [ ] これまで問題があった月末処理のテストケースを拡充する（例: 1月31日の翌月が2月28日または29日になること、2月28日の翌月が3月28日になること）。
    - [ ] 閏年をまたぐ場合のテストケースを追加する。

## 関連ドキュメント

- [品質向上タスク in requirement.md (`../requirement.md`)](./../requirement.md)
- [単体テスト (`../__tests__/utils.test.js`)](./../../__tests__/utils.test.js)

## 補足

- `time` のタイムゾーン解釈は `discord-bot/src/timezone.js` で IANA/UTCオフセット/`JST`/`UTC`/`GMT` を解決し、DST境界の補正を行う。
- 追加のタイムゾーンテストは `discord-bot/__tests__/timezone.test.js` を参照する。

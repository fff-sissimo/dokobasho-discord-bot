# Spec: どこばしょのようせい 全体復旧

## Objective

診断で確認されたDiscord Bot、リマインダーscheduler、VC Memo、内部HTTP API、Docker/Hostinger構成、開発ツールの欠陥を修復し、ローカルと本番相当環境で失敗を検出でき、データを失わず、安全に開発・運用できる状態へ戻す。

利用者はDiscord上のBot利用者、開発者、Hostinger運用者である。成功とは、単にJestが通ることではなく、Discord API契約、schedulerの一回実行保証、録音データ保全、内部APIの認証、環境間の設定整合を自動検証できることである。

## Assumptions

1. 既存のリマインダー、Fairy、画像生成、VC Memoは削除しない。
2. リポジトリとローカル設定を修正対象とし、本番VPSへのデプロイ、外部サービスへの書き込み、トークンのローテーションは行わない。
3. 無認証の非loopback内部API、同意なし録音、第三者による録音停止・破棄は後方互換性より安全を優先して拒否する。
4. Hostingerのgit-sync方式は今回ただちにコンテナレジストリ方式へ置換せず、完全なcommit SHAへの固定と起動時検証で再現可能性を上げる。
5. 大規模な新規依存は追加せず、Node標準API、Jest、既存依存を利用する。
6. 既存の未コミット変更は利用者の作業として保持し、無関係な変更を戻さない。

## Tech Stack

- Node.js 22.12以上
- CommonJS JavaScript
- discord.js 14.x / @discordjs/voice 0.19.x
- Jest 29.x
- Docker Compose
- Google Sheets API
- OpenAI HTTP API

## Commands

すべて `discord-bot/` で実行する。ef

```bash
npm ci
npm test
npm run check:syntax
npm run check
npm start
npm run start-scheduler
npm run start-resource-server
npm run deploy-commands
```

Compose検証はリポジトリルートで実行する。

```bash
docker compose config --quiet
docker compose -f hostinger/docker-compose.yml config --quiet
```

## Project Structure

- `discord-bot/index.js`: Discordクライアントの組立とプロセス起動。コマンド固有処理を増やさない。
- `discord-bot/src/interaction-replies.js`: Discord reply/defer/edit payloadの契約を集約する。
- `discord-bot/scheduler.js`: schedulerの組立とmain entry。テスト可能なrunnerをexportする。
- `discord-bot/src/reminder-processor.js`: 1回分のリマインダー配送。配送結果を明示的に返す。
- `discord-bot/src/vc-memo/`: VC Memoのsession、録音、STT、要約、ドラフト保存。
- `discord-bot/src/internal-api-security.js`: 内部HTTP APIのbind先とtoken要件を共通検証する。
- `discord-bot/__tests__/`: 各障害の再現テストと回帰テスト。
- `docker-compose.yml`: ローカル/標準Docker構成。
- `hostinger/docker-compose.yml`: Hostinger構成。アプリ設定名を標準構成と同期する。
- `docs/superpowers/plans/`: 本仕様と復旧実装計画。

## Code Style

既存のCommonJS形式を維持し、副作用のある処理は依存を引数で受ける関数へ分離する。

```js
const createSingleFlightRunner = ({ run, onSuccess }) => {
  let running = false;
  return async () => {
    if (running) return { skipped: true, reason: 'already_running' };
    running = true;
    try {
      const result = await run();
      await onSuccess(result);
      return { ok: true, result };
    } finally {
      running = false;
    }
  };
};
```

- 文字列は既存ファイルの引用符スタイルに合わせる。
- エラーはPinoの `{ err }` 形式で記録する。
- 外部APIエラー本文や秘密値をDiscord返信へ含めない。
- process終了やネットワーク開始は `require.main === module` の境界へ寄せる。

## Testing Strategy

- すべての修正は失敗するJestテストを先に追加し、REDを確認してから実装する。
- Discord返信はdiscord.jsの許可flagsをテストし、`editReply`へEphemeralを渡さないことを保証する。
- schedulerは重複tick、Sheets取得失敗、配送先欠落、配送成功後の状態更新をテストする。
- VC Memoは同意、所有者権限、録音上限、ディスク保存、再起動後のドラフト参照、STT/要約timeout、要約失敗時の全文文字起こし保全をテストする。
- 内部APIは非loopbackかつtokenなしで起動拒否、loopback開発時の明示許可、正しいtoken認証をテストする。
- Composeは `config --quiet`、JavaScriptは `node --check`、全体は `npm test` を正本ゲートとする。
- 実Discord音声E2Eは自動unit testの代替にせず、Docker起動可能時の手動確認項目として残す。

## Boundaries

### Always do

- 秘密値をログ、テストfixture、仕様書、READMEへ書かない。
- 外部API呼び出しにtimeoutを設定する。
- 配送・保存に成功していない処理を成功状態へ進めない。
- 録音開始時に明示同意と実行者情報を保存する。
- canonicalな `npm test` と差分レビューを完了前に実行する。

### Ask first

- 本番VPSへのデプロイまたは再起動。
- Discord、Google、OpenAI、n8nのトークンローテーション。
- コンテナレジストリや新しい永続DBの導入。
- Git commit、push、PR作成。

### Never do

- 既存の未コミット作業をreset、checkout、削除する。
- `.env`やサービスアカウント鍵をGitへ追加する。
- 認証未設定を警告だけで許可して非loopbackへbindする。
- 生の外部APIエラー本文を利用者へ返す。

## Success Criteria

1. `editReply()` payloadに`MessageFlags.Ephemeral`が含まれず、ephemeral性は最初のreply/deferでのみ決まる。
2. 配送先がないリマインダーは`sent`や次回予定へ進まず、retry/failed経路へ入る。
3. scheduler tickはsingle-flightで、処理失敗時は成功heartbeatを更新しない。
4. schedulerのmain経路に自動テストがあり、coverageが0%ではない。
5. VC Memo開始には明示同意が必要で、開始者または管理権限保持者だけがstop/discardできる。
6. VC Memoの音声データ量はメモリに比例せず、ディスク上のsession領域へ逐次保存される。
7. STT前の音声、STT全文、要約ドラフトが段階的に保存され、要約失敗やプロセス再起動後も復旧できる。
8. STTと要約に設定可能なtimeoutがあり、長文要約はモデル入力上限を超えない分割処理を行う。
9. VC Memo sessionはguild単位で管理され、別guildの録音を相互に停止・破棄できない。
10. 永続保存先がCompose volumeと一致し、VC Memo draft/audioも永続領域へ置かれる。
11. 非loopbackの恒久記憶APIとResource APIはtoken未設定で起動しない。
12. ローカルの`.env`とGoogle鍵は所有者だけが読める権限になり、Git対象外のままである。
13. `.env_example`、README、root Compose、Hostinger Composeで使用する環境変数名と既定値が一致する。
14. Hostinger起動は完全なcommit SHAを要求し、可変branchのHEADを無条件に実行しない。
15. `package.json`にNode要件と統合checkコマンドがあり、空のroot lockfileによる誤操作がない。
16. `deploy-commands`失敗時は非ゼロ終了する。
17. `npm test`、`npm run check`、`git diff --check`が成功する。
18. Docker daemonが利用可能な環境では両Composeの構文検証とサービス起動確認手順が再現できる。

## Open Questions

1. 録音停止・破棄を許可する管理権限はDiscordの `ManageGuild` とする。
2. 明示同意は `/vc-memo start consent:true` の必須boolean optionとする。
3. 音声・文字起こし・ドラフトの既定保持期間は自動削除せず、明示discardまで保持する。
4. 本番デプロイと実サービスE2Eは、ローカル復旧完了後に利用者の承認を得て別途実施する。

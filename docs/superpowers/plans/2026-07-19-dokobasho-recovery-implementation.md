# どこばしょのようせい 全体復旧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord返信、scheduler、VC Memo、内部API、Compose、開発コマンドを、承認済み復旧仕様の18成功条件に適合させる。

**Architecture:** 外部副作用を小さな依存注入可能関数へ分離し、Jestで実挙動を先に固定する。VC音声はメモリMapではなくsessionディレクトリへ逐次保存し、停止後に有界WAVチャンクとして読み出す。内部APIとデプロイはfail-closedにする。

**Tech Stack:** Node.js 22.12+、CommonJS、discord.js 14.26、@discordjs/voice 0.19、Jest 29、Docker Compose

## Global Constraints

- 既存の未コミット変更を戻さない。
- 秘密値をソース、fixture、ログへ書かない。
- 本番VPS、Discord、Google Sheets、OpenAI、n8nへ書き込まない。
- 挙動変更は必ず失敗するJestテストを先に確認する。
- canonical gateは `npm test`、`npm run check`、`git diff --check`。

---

### Task 1: Discord interaction reply契約

**Files:**
- Create: `discord-bot/src/interaction-replies.js`
- Create: `discord-bot/__tests__/interaction-replies.test.js`
- Modify: `discord-bot/index.js`
- Modify: `discord-bot/src/command-handler.js`

**Interfaces:**
- Produces: `ephemeralReply(content)`, `ephemeralDefer()`, `editReply(content, extra)`。
- `editReply`は`flags`と`ephemeral`を除去する。

- [ ] RED: `editReply('ok', { flags: [MessageFlags.Ephemeral] })`にflagsが残らないテストを書く。
- [ ] Run: `npm test -- --runInBand __tests__/interaction-replies.test.js`; helper未実装でFAILを確認する。
- [ ] GREEN: helperを実装し、`index.js`と`command-handler.js`の`editReply`からEphemeral指定を除去する。
- [ ] Run: 同テストと既存`command-handler`・`index.message-trigger`テストを通す。

### Task 2: scheduler配送状態とsingle-flight

**Files:**
- Create: `discord-bot/src/scheduler-runner.js`
- Create: `discord-bot/__tests__/scheduler-runner.test.js`
- Modify: `discord-bot/src/reminder-processor.js`
- Modify: `discord-bot/__tests__/reminder-processor.test.js`
- Modify: `discord-bot/scheduler.js`
- Create: `discord-bot/__tests__/scheduler.test.js`

**Interfaces:**
- Produces: `createSingleFlightRunner({ run, writeHeartbeat, logger })`。
- `processReminders`は取得不能をthrowし、`{ processed, sent, failed }`を返す。

- [ ] RED: 配送先`null`が`sent`へ進まないテスト、同時tickが`already_running`になるテスト、失敗時heartbeatなしのテストを書く。
- [ ] Run: `npm test -- --runInBand __tests__/reminder-processor.test.js __tests__/scheduler-runner.test.js`; 現挙動でFAILを確認する。
- [ ] GREEN: 配送先欠落を例外化し、single-flight runnerを実装する。
- [ ] REFACTOR: `scheduler.js`を`require.main === module`境界へ分け、runner経由でcronを起動する。
- [ ] Run: scheduler関連テストを通し、scheduler.js coverageが0%でないことを確認する。

### Task 3: VC Memo同意・所有権・guild分離

**Files:**
- Modify: `discord-bot/src/commands.js`
- Modify: `discord-bot/src/vc-memo/session-manager.js`
- Modify: `discord-bot/src/vc-memo/index.js`
- Modify: `discord-bot/index.js`
- Modify: `discord-bot/__tests__/vc-memo.test.js`
- Modify: `discord-bot/__tests__/commands.test.js`

**Interfaces:**
- `createSession(guildId, channelId, { ownerUserId, consentConfirmed, mode, stt })`。
- `getActiveSessionId(guildId)`、`canControlSession(sessionId, { userId, canManageGuild })`。

- [ ] RED: consent=false拒否、guildごとの同時session、第三者stop/discard拒否をテストする。
- [ ] Run: VC Memoテストで期待したFAILを確認する。
- [ ] GREEN: 必須`consent` optionとowner情報を追加し、guild単位Mapへ移行する。
- [ ] GREEN: interactionの`ManageGuild`権限を評価し、stop/discardへcontroller contextを渡す。
- [ ] Run: VC Memo・commands・indexテストを通す。

### Task 4: VC Memoディスク録音と段階保存

**Files:**
- Create: `discord-bot/src/vc-memo/recording-store.js`
- Create: `discord-bot/__tests__/vc-memo-recording-store.test.js`
- Modify: `discord-bot/src/vc-memo/audio-processor.js`
- Modify: `discord-bot/src/vc-memo/voice-listener.js`
- Modify: `discord-bot/src/vc-memo/index.js`
- Modify: `discord-bot/src/vc-memo/draft-writer.js`

**Interfaces:**
- `createRecordingStore({ rootDir, sessionId })`は`appendPcm(userId, buffer)`、`readWavChunks(userId, maxBytes)`、`writeTranscript(text)`、`listUsers()`を提供する。
- 受信時PCMはstoreへappendし、メモリには保持しない。

- [ ] RED: 多数packet後もin-memory bufferが増えず、PCMファイルとmanifestが生成されるテストを書く。
- [ ] RED: 要約失敗後も`transcript.txt`と音声ファイルが残るテストを書く。
- [ ] Run: recording-store/VC MemoテストでFAILを確認する。
- [ ] GREEN: sessionディレクトリ、speaker PCM、manifest、WAV chunk readerをNode fsで実装する。
- [ ] GREEN: `processOpusPacket`の出力先をactive recording storeへ変更する。
- [ ] GREEN: stop時に全文文字起こしを要約前に保存し、要約失敗をdraftに明記する。
- [ ] Run: VC Memo全テストを通す。

### Task 5: OpenAI timeoutと長文要約

**Files:**
- Modify: `discord-bot/src/vc-memo/stt-client.js`
- Modify: `discord-bot/src/vc-memo/summarizer.js`
- Modify: `discord-bot/__tests__/vc-memo-stt-client.test.js`
- Modify: `discord-bot/__tests__/vc-memo-summarizer.test.js`
- Modify: `discord-bot/.env_example`

**Interfaces:**
- `transcribe(wavBuffer, { retries, timeoutMs, fetchImpl })`。
- `summarize(transcript, speakerLabels, { timeoutMs, maxChunkChars, fetchImpl })`は長文を分割し、部分要約を統合する。

- [ ] RED: AbortSignal timeout、retry対象判定、長文分割、外部エラー本文非露出をテストする。
- [ ] Run: STT/summarizerテストでFAILを確認する。
- [ ] GREEN: AbortControllerと設定値を実装し、4xxを無駄にretryしない。
- [ ] GREEN: transcriptを文字境界で分割して部分要約し、最終JSONへ統合する。
- [ ] Run: OpenAI client関連テストを通す。

### Task 6: 内部API fail-closedと永続化

**Files:**
- Create: `discord-bot/src/internal-api-security.js`
- Create: `discord-bot/__tests__/internal-api-security.test.js`
- Modify: `discord-bot/src/permanent-memory-sync-server.js`
- Modify: `discord-bot/resource-server.js`
- Modify: 対応する既存テスト
- Modify: `docker-compose.yml`
- Modify: `hostinger/docker-compose.yml`

**Interfaces:**
- `assertInternalApiSecurity({ host, token, allowInsecureLoopback })`は非loopback tokenなしをthrowする。

- [ ] RED: `0.0.0.0`+空tokenが拒否され、`127.0.0.1`+明示開発許可だけ通るテストを書く。
- [ ] Run: security/serverテストでFAILを確認する。
- [ ] GREEN: 両serverのstart前に共通検証を入れる。
- [ ] GREEN: root Composeの恒久記憶mountを`/opt/dokobasho/permanent-memory`へ合わせ、VC cache volumeを追加する。
- [ ] GREEN: HostingerへVC MemoとMessageContent設定を追加する。
- [ ] Run: serverテストと両Compose configを検証する。

### Task 7: 開発・デプロイ再現性

**Files:**
- Modify: `discord-bot/package.json`
- Create: `.nvmrc`
- Modify: `discord-bot/deploy-commands.js`
- Modify: `discord-bot/__tests__/commands.test.js`または新規deploy test
- Modify: `discord-bot/.env_example`
- Modify: `README.md`
- Modify: `hostinger/docker-compose.yml`
- Delete: `package-lock.json`（rootの空lockfileのみ）

**Interfaces:**
- `package.json.engines.node`は`>=22.12.0 <23`。
- `npm run check`はsyntax後にJestを実行する。
- Hostingerは`APP_COMMIT`を40桁SHAとして検証してcheckoutする。

- [ ] RED: deploy REST失敗時に`process.exitCode=1`となるテストを書く。
- [ ] Run: deploy testでFAILを確認する。
- [ ] GREEN: deploy関数をexportし、main catchでexitCodeを設定する。
- [ ] GREEN: Node version、check script、環境変数一覧、READMEを同期する。
- [ ] GREEN: Hostinger起動scriptで`APP_COMMIT`形式とcheckout結果を検証する。
- [ ] Run: `npm test`、`npm run check`、Compose config、`git diff --check`を実行する。

## Completion Audit

- 仕様の成功条件1-18をファイル・テスト・コマンド出力へ一対一で対応させる。
- `rg 'editReply\\([^)]*Ephemeral|editReply\\(\\{[^}]*ephemeral'`が該当なし。
- schedulerの取得失敗、重複tick、配送先欠落テストが存在し成功する。
- VC Memoの同意、所有権、guild分離、ディスク保存、timeout、要約失敗復旧テストが存在し成功する。
- secretファイルを`0600`へ変更し、`git check-ignore`で除外を確認する。
- Docker daemon停止など外部要因で実行不能な検証は未確認リスクとして明示し、ゴール完了とは分けて扱う。

# Context7 notes: Node.js/Jest runtime state

参照日: 2026-05-04

## Node.js

- Library ID: `/nodejs/node`
- Source: Node.js official docs via Context7
- `node:fs/promises` の `mkdir(path, { recursive: true })` は親ディレクトリを含めて作成できる。
- `readFile(path, "utf8")` と `writeFile(path, data, "utf8")` は JSON state file の読み書きに使える。
- CommonJS では `const { mkdir } = require("node:fs/promises");` と `const { join } = require("node:path");` の形式が利用できる。

## Jest

- Library ID: `/jestjs/jest/v29.7.0`
- Source: Jest 29.7 official docs via Context7
- `beforeEach` / `afterEach` はテストごとの setup/teardown に使える。
- Promise を返す async 処理は `async` test または `.resolves` で検証できる。
- `expect.objectContaining(...)` は状態 JSON の一部プロパティ検証に使える。

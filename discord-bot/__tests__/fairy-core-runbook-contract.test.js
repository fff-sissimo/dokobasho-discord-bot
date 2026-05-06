const fs = require("node:fs");
const path = require("node:path");

const readmePath = path.resolve(__dirname, "..", "..", "README.md");
const envExamplePath = path.resolve(__dirname, "..", ".env_example");
const hostingerComposeExamplePath = path.resolve(__dirname, "..", "..", "hostinger", "docker-compose.example.yml");
const runtimeBootstrapPath = path.resolve(__dirname, "..", "scripts", "runtime-bootstrap.sh");

describe("fairy-core rollout runbook contract", () => {
  it("README に NODE_AUTH_TOKEN 設定と反映手順を持つ", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toContain("NODE_AUTH_TOKEN");
    expect(readme).toContain("npm ci");
    expect(readme).toContain("@fff-sissimo/fairy-core");
  });

  it("README に1 versionロールバック手順を持つ", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toContain("ロールバック");
    expect(readme).toContain("1 version");
    expect(readme).toContain("再起動");
  });

  it("Hostinger runtime bootstrap が compose 参照先として存在する", () => {
    const compose = fs.readFileSync(hostingerComposeExamplePath, "utf8");
    expect(compose).toContain("scripts/runtime-bootstrap.sh index.js");
    expect(compose).toContain("scripts/runtime-bootstrap.sh scheduler.js");
    expect(fs.existsSync(runtimeBootstrapPath)).toBe(true);
    const bootstrap = fs.readFileSync(runtimeBootstrapPath, "utf8");
    expect(bootstrap).toContain("npm ci --omit=dev");
    expect(bootstrap).toContain("NODE_AUTH_TOKEN");
    expect(bootstrap).toContain(".discord-bot-npm-ci.lock");
    expect(bootstrap).toContain("while ! mkdir");
    expect(bootstrap).toContain("RUNTIME_BOOTSTRAP_INSTALL_LOCK_STALE_SECONDS");
    expect(bootstrap).toContain("lock_is_stale");
    expect(bootstrap).toContain("removing stale dependency install lock");
    expect(bootstrap).toMatch(/while ! mkdir[\s\S]+if needs_install; then[\s\S]+npm ci --omit=dev/);
    expect(bootstrap).toContain("trap on_interrupt INT");
    expect(bootstrap).toContain("trap on_terminate TERM");
    expect(bootstrap).toContain("exit 130");
    expect(bootstrap).toContain("exit 143");
  });

  it(".env_example は OpenClaw API endpoint の正本 env 名を使う", () => {
    const envExample = fs.readFileSync(envExamplePath, "utf8");
    expect(envExample).toContain("OPENCLAW_API_BASE_URL=http://openclaw-api:8788/discord/respond");
    expect(envExample).toContain("# OPENCLAW_API_URL=");
    expect(envExample).not.toMatch(/^OPENCLAW_API_URL=/m);
  });
});

const fs = require("node:fs");
const path = require("node:path");

const readmePath = path.resolve(__dirname, "..", "..", "README.md");
const envExamplePath = path.resolve(__dirname, "..", ".env_example");
const hostingerComposeExamplePath = path.resolve(__dirname, "..", "..", "hostinger", "docker-compose.example.yml");
const runtimeBootstrapPath = path.resolve(__dirname, "..", "scripts", "runtime-bootstrap.sh");

describe("fairy runtime rollout runbook contract", () => {
  it("README に private package 非依存と反映手順を持つ", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toContain("NODE_AUTH_TOKEN");
    expect(readme).toContain("runtime 起動には不要");
    expect(readme).toContain("npm ci");
    expect(readme).toContain("local slow-path contract");
    expect(readme).toContain("schema v3");
    expect(readme).toContain("reply_antecedent_entry");
  });

  it("README に verified commit ロールバック手順を持つ", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toContain("ロールバック");
    expect(readme).toContain("直前の verified commit");
    expect(readme).toContain("再起動");
  });

  it("Hostinger runtime bootstrap が compose 参照先として存在する", () => {
    const compose = fs.readFileSync(hostingerComposeExamplePath, "utf8");
    expect(compose).toContain("scripts/runtime-bootstrap.sh index.js");
    expect(compose).toContain("scripts/runtime-bootstrap.sh scheduler.js");
    expect(fs.existsSync(runtimeBootstrapPath)).toBe(true);
    const bootstrap = fs.readFileSync(runtimeBootstrapPath, "utf8");
    expect(bootstrap).toContain("npm ci --omit=dev");
    expect(bootstrap).toContain(".runtime-install.lock");
    expect(bootstrap).toContain(".runtime-install.stamp");
    expect(bootstrap).toContain("while ! mkdir");
    expect(bootstrap).toContain("RUNTIME_INSTALL_LOCK_STALE_MINUTES");
    expect(bootstrap).toContain("find \"$LOCK_DIR\"");
    expect(bootstrap).toContain("sha256sum");
    expect(bootstrap).toMatch(/while ! mkdir[\s\S]+if \[ ! -d node_modules \][\s\S]+npm ci --omit=dev/);
    expect(bootstrap).toContain("trap cleanup EXIT INT TERM");
  });

  it(".env_example は OpenClaw API endpoint の正本 env 名を使う", () => {
    const envExample = fs.readFileSync(envExamplePath, "utf8");
    expect(envExample).toContain("OPENCLAW_API_BASE_URL=http://openclaw-api:8788/discord/respond");
    expect(envExample).toContain("# OPENCLAW_API_URL=");
    expect(envExample).not.toMatch(/^OPENCLAW_API_URL=/m);
  });
});

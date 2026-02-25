const fs = require("node:fs");
const path = require("node:path");

const readmePath = path.resolve(__dirname, "..", "..", "README.md");

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
});

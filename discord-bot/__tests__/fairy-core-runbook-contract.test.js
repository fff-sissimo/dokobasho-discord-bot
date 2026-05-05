const fs = require("node:fs");
const path = require("node:path");

const readmePath = path.resolve(__dirname, "..", "..", "README.md");

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
});

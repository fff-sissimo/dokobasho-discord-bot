const fs = require("node:fs");
const path = require("node:path");

const packageJsonPath = path.resolve(__dirname, "..", "package.json");
const npmrcPath = path.resolve(__dirname, "..", ".npmrc");

describe("fairy-core migration contract", () => {
  it("@fff-sissimo/fairy-core を固定versionで依存する", () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const version =
      (packageJson.dependencies && packageJson.dependencies["@fff-sissimo/fairy-core"]) ||
      (packageJson.optionalDependencies && packageJson.optionalDependencies["@fff-sissimo/fairy-core"]);
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.startsWith("^")).toBe(false);
    expect(version.startsWith("~")).toBe(false);
  });

  it(".npmrc が NODE_AUTH_TOKEN を環境変数参照する", () => {
    expect(fs.existsSync(npmrcPath)).toBe(true);
    const npmrc = fs.readFileSync(npmrcPath, "utf8");
    expect(npmrc).toContain("@fff-sissimo:registry=https://npm.pkg.github.com");
    expect(npmrc).toContain("//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}");
    expect(npmrc).not.toMatch(/_authToken=(?!\$\{NODE_AUTH_TOKEN\})\S+/);
  });
});

"use strict";

const path = require("node:path");

const {
  BOT_ROOT,
  REPO_ROOT,
  collectFiles,
  hasUnredactedSecretAssignment,
  parseArgs,
  readTextIfExists,
  redactText,
} = require("./openclaw-runbook-common");

const HELP = `Usage:
  node scripts/runtime-audit.js

Runs a local synthetic redaction audit only. It does not read Hostinger docker logs,
runtime state volumes, or OpenClaw state. Those remain approval-gated runbook steps.`;

const printCheck = (label, passed) => {
  console.log(`${label}: ${passed ? "pass" : "fail"}`);
};

const docsAudit = () => {
  const files = [
    path.join(REPO_ROOT, "README.md"),
    ...collectFiles(path.join(REPO_ROOT, "doc"), (filePath) => filePath.endsWith(".md")),
    ...collectFiles(BOT_ROOT, (filePath) => path.basename(filePath).startsWith("context7-") && filePath.endsWith(".md")),
  ];
  return files.every((filePath) => !hasUnredactedSecretAssignment(readTextIfExists(filePath)));
};

const tmpStateAudit = () => {
  const syntheticState = JSON.stringify({
    followups: [
      {
        channel_id: "1094907178671939654",
        raw_content: "synthetic discord message body",
        notes: "token=synthetic-runtime-token",
      },
    ],
  });
  const redacted = redactText(syntheticState);
  return !hasUnredactedSecretAssignment(redacted) &&
    !redacted.includes("synthetic discord message body") &&
    !redacted.includes("synthetic-runtime-token");
};

const sampleLogAudit = () => {
  const syntheticLog = [
    "OPENCLAW_API_KEY=synthetic-openclaw-key",
    "authorization: Bearer syntheticBearerToken12345",
    "content='synthetic raw Discord body'",
  ].join(" ");
  const redacted = redactText(syntheticLog);
  return !hasUnredactedSecretAssignment(redacted) &&
    !redacted.includes("synthetic-openclaw-key") &&
    !redacted.includes("syntheticBearerToken12345") &&
    !redacted.includes("synthetic raw Discord body");
};

const main = () => {
  const args = parseArgs();
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const checks = [
    ["repo_docs_redaction", docsAudit()],
    ["tmp_state_redaction", tmpStateAudit()],
    ["sample_logs_redaction", sampleLogAudit()],
  ];
  for (const [label, passed] of checks) printCheck(label, passed);

  console.log("hostinger_docker_logs: approval_required_runbook_only");
  console.log("state_volume: approval_required_runbook_only");
  console.log("openclaw_state: approval_required_runbook_only");
  console.log("runbook: request approval before inspecting Hostinger docker logs, state volume, or OpenClaw state");

  return checks.every(([, passed]) => passed) ? 0 : 1;
};

process.exitCode = main();

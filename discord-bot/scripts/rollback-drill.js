"use strict";

const { parseArgs } = require("./openclaw-runbook-common");

const BASELINES = Object.freeze({
  v1: Object.freeze({
    allowlist: ["1094907178671939654"],
    recreateServices: ["discord-bot"],
  }),
});

const HELP = `Usage:
  node scripts/rollback-drill.js --baseline=v1

Prints a dry-run rollback drill only. It does not edit env files, restart services,
or run docker compose.`;

const printPlan = ({ baseline, config }) => {
  console.log(`rollback_drill: dry_run`);
  console.log(`baseline: ${baseline}`);
  console.log(`v1_baseline_allowlist: ${config.allowlist.join(",")}`);
  console.log(`recreate_services: ${config.recreateServices.join(",")}`);
  console.log("normal_rollback:");
  console.log("  FAIRY_RUNTIME_MODE=openclaw");
  console.log(`  FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS=${config.allowlist.join(",")}`);
  console.log(`  recreate=${config.recreateServices.join(",")}`);
  console.log("emergency_fallback:");
  console.log("  FAIRY_RUNTIME_MODE=n8n");
  console.log(`  recreate=${config.recreateServices.join(",")}`);
};

const main = () => {
  const args = parseArgs();
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const baseline = args.baseline || "v1";
  const config = BASELINES[baseline];
  if (!config) {
    console.log(`rollback_drill: fail`);
    console.log(`baseline: unsupported`);
    return 1;
  }
  printPlan({ baseline, config });
  return 0;
};

process.exitCode = main();

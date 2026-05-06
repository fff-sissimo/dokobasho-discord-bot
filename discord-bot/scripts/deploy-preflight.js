"use strict";

const path = require("node:path");

const {
  BOT_ROOT,
  buildRuntimeEnv,
  loadCanonicalChannelRegistry,
  loadPermissionWorksheet,
  parseArgs,
  parseCsv,
  parseJsonValue,
  printRows,
} = require("./openclaw-runbook-common");

const HELP = `Usage:
  node scripts/deploy-preflight.js [--dotenv=.env] [--registry=path] [--permission-worksheet=path]

Checks:
  - canonical runtime/discord-channel-registry.json
  - FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON deploy override
  - FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS
  - permission worksheet status
  - allowlisted channel gate result

Output columns are limited to channel id, type, status, allowlist membership, and gate result.`;

const statusText = ({ registryStatus, worksheetStatus }) =>
  `registry:${registryStatus};worksheet:${worksheetStatus}`;

const normalizeOverrideRegistry = (source) => {
  if (!source || typeof source !== "object") return {};
  const sourceEntries = source && !Array.isArray(source) && Array.isArray(source.channels) ? source.channels : source;
  const entries = Array.isArray(sourceEntries)
    ? sourceEntries.map((entry) => [String(entry && (entry.id || entry.channel_id) || "").trim(), entry])
    : Object.entries(sourceEntries).map(([id, entry]) => [String(id || "").trim(), entry]);
  return Object.fromEntries(
    entries
      .filter(([id, entry]) => /^\d+$/.test(id) && entry && typeof entry === "object" && !Array.isArray(entry))
      .map(([id, entry]) => [
        id,
        {
          name: String(entry.name || "").trim(),
          type: String(entry.type || "unknown").trim() || "unknown",
          status: String(
            entry.status || entry.registry_status || (entry.verified === true ? "verified" : "")
          ).trim() || "unknown",
        },
      ])
  );
};

const mergeDeployOverride = (registry, env) => {
  if (!env.FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON) return registry;
  const override = normalizeOverrideRegistry(
    parseJsonValue(env.FAIRY_OPENCLAW_CHANNEL_REGISTRY_JSON, "OpenClaw channel registry override")
  );
  return Object.fromEntries(
    Object.entries({
      ...registry,
      ...Object.fromEntries(
        Object.entries(override).map(([id, entry]) => [
          id,
          {
            ...(registry[id] || {}),
            ...entry,
            permission_worksheet_status:
              registry[id] && registry[id].permission_worksheet_status
                ? registry[id].permission_worksheet_status
                : "unknown",
          },
        ])
      ),
    })
  );
};

const gateFor = ({ channelId, entry, allowlisted, worksheetStatus }) => {
  if (!allowlisted) return "skip:not_allowlisted";
  if (!entry) return "fail:registry_missing";
  if (entry.status !== "verified") return "fail:unverified_registry";
  if (worksheetStatus !== "verified") return "fail:unverified_worksheet";
  if (entry.type === "ops") return "fail:ops_postable_denied";
  return "pass";
};

const main = () => {
  const args = parseArgs();
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const envFile = args.dotenv || args["env-file"]
    ? path.resolve(process.cwd(), args.dotenv || args["env-file"])
    : path.join(BOT_ROOT, ".env");
  const env = buildRuntimeEnv({ envFile });

  let registry;
  try {
    const registryFile = args.registry ? path.resolve(process.cwd(), args.registry) : undefined;
    registry = mergeDeployOverride(loadCanonicalChannelRegistry(registryFile), env);
  } catch (error) {
    console.log("channel_id=registry type=unknown status=invalid allowlist=unknown gate=fail:invalid_registry_json");
    return 1;
  }

  const allowedIds = parseCsv(env.FAIRY_OPENCLAW_ALLOWED_CHANNEL_IDS);
  const allowedSet = new Set(allowedIds);
  const worksheet = loadPermissionWorksheet({ registry, env, args });
  const channelIds = [...new Set([...Object.keys(registry), ...allowedIds])].sort();

  const rows = channelIds.map((channelId) => {
    const entry = registry[channelId];
    const registryStatus = entry ? entry.status : "unknown";
    const worksheetStatus = worksheet[channelId] || "unknown";
    const allowlisted = allowedSet.has(channelId);
    return {
      channel_id: channelId,
      type: entry ? entry.type : "unknown",
      status: statusText({ registryStatus, worksheetStatus }),
      allowlist: allowlisted ? "yes" : "no",
      gate: gateFor({ channelId, entry, allowlisted, worksheetStatus }),
    };
  });

  if (allowedIds.length === 0) {
    rows.push({
      channel_id: "allowlist",
      type: "unknown",
      status: "registry:unknown;worksheet:unknown",
      allowlist: "no",
      gate: "fail:allowlist_empty",
    });
  }

  printRows(rows);
  return rows.some((row) => row.gate.startsWith("fail:")) ? 1 : 0;
};

process.exitCode = main();

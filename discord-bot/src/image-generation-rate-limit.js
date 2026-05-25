"use strict";

const DEFAULT_USER_LIMIT_PER_HOUR = 5;
const DEFAULT_GUILD_LIMIT_PER_DAY = 100;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const pruneWindow = (timestamps, cutoff) => {
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }
};

const nextRetryAfterMs = (timestamps, windowMs, now) => {
  if (timestamps.length === 0) return 0;
  return Math.max(0, timestamps[0] + windowMs - now);
};

const createInMemoryRateLimitStore = (initialState = {}) => {
  const scopes = new Map();

  const ensureScope = (scope) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    return scopes.get(scope);
  };

  for (const [scope, values] of Object.entries(initialState)) {
    const scopeStore = ensureScope(scope);
    for (const [key, timestamps] of Object.entries(values || {})) {
      scopeStore.set(String(key), [...timestamps]);
    }
  }

  return {
    type: "in_memory_single_process",
    get(scope, key) {
      const scopeStore = ensureScope(scope);
      const normalizedKey = String(key);
      if (!scopeStore.has(normalizedKey)) scopeStore.set(normalizedKey, []);
      return scopeStore.get(normalizedKey);
    },
    set(scope, key, timestamps) {
      ensureScope(scope).set(String(key), [...timestamps]);
    },
    snapshot() {
      const output = {};
      for (const [scope, scopeStore] of scopes.entries()) {
        output[scope] = snapshotStore(scopeStore);
      }
      return output;
    },
  };
};

const createImageGenerationRateLimiter = ({
  userLimitPerHour = DEFAULT_USER_LIMIT_PER_HOUR,
  guildLimitPerDay = DEFAULT_GUILD_LIMIT_PER_DAY,
  now = () => Date.now(),
  store = createInMemoryRateLimitStore(),
} = {}) => {
  const getHits = (scope, key) => {
    if (!store || typeof store.get !== "function") {
      throw new Error("Rate limit store must implement get(scope, key).");
    }
    return store.get(scope, key);
  };

  const setHits = (scope, key, timestamps) => {
    if (!store || typeof store.set !== "function") {
      throw new Error("Rate limit store must implement set(scope, key, timestamps).");
    }
    store.set(scope, key, timestamps);
  };

  const checkAndConsume = ({ userId, guildId, requestId } = {}) => {
    const checked = check({ userId, guildId });
    if (!checked.allowed) {
      return {
        ...checked,
        refund: () => false,
      };
    }
    return consume({ userId, guildId, requestId });
  };

  const check = ({ userId, guildId } = {}) => {
    if (!userId || !guildId) {
      return {
        allowed: false,
        retryAfterMs: 0,
        reasons: ["invalid_request"],
      };
    }

    const current = now();
    const userKey = String(userId);
    const guildKey = String(guildId);
    const userWindow = getHits("users", userKey);
    const guildWindow = getHits("guilds", guildKey);

    pruneWindow(userWindow, current - HOUR_MS);
    pruneWindow(guildWindow, current - DAY_MS);
    setHits("users", userKey, userWindow);
    setHits("guilds", guildKey, guildWindow);

    const reasons = [];
    const retryAfterValues = [];

    if (userWindow.length >= userLimitPerHour) {
      reasons.push("user_rate_limited");
      retryAfterValues.push(nextRetryAfterMs(userWindow, HOUR_MS, current));
    }
    if (guildWindow.length >= guildLimitPerDay) {
      reasons.push("guild_rate_limited");
      retryAfterValues.push(nextRetryAfterMs(guildWindow, DAY_MS, current));
    }

    if (reasons.length > 0) {
      return {
        allowed: false,
        retryAfterMs: Math.max(...retryAfterValues),
        reasons,
      };
    }

    return {
      allowed: true,
      retryAfterMs: 0,
      reasons: [],
    };
  };

  const consume = ({ userId, guildId, requestId } = {}) => {
    const checked = check({ userId, guildId });
    if (!checked.allowed) {
      return {
        ...checked,
        refund: () => false,
      };
    }

    const current = now();
    const userKey = String(userId);
    const guildKey = String(guildId);
    const userWindow = getHits("users", userKey);
    const guildWindow = getHits("guilds", guildKey);

    const lease = {
      userKey,
      guildKey,
      requestId: requestId || null,
      consumedAt: current,
      refunded: false,
    };

    userWindow.push(current);
    guildWindow.push(current);
    setHits("users", userKey, userWindow);
    setHits("guilds", guildKey, guildWindow);

    const refund = () => refundLease(lease);

    return {
      allowed: true,
      retryAfterMs: 0,
      reasons: [],
      lease,
      refund,
    };
  };

  const refundLease = (lease) => {
    if (!lease || lease.refunded) return false;
    const userWindow = getHits("users", lease.userKey);
    const guildWindow = getHits("guilds", lease.guildKey);

    const removedUser = removeOneTimestamp(userWindow, lease.consumedAt);
    const removedGuild = removeOneTimestamp(guildWindow, lease.consumedAt);
    setHits("users", lease.userKey, userWindow);
    setHits("guilds", lease.guildKey, guildWindow);
    lease.refunded = true;
    return removedUser || removedGuild;
  };

  const snapshot = () => store.snapshot();

  return {
    check,
    consume,
    checkAndConsume,
    refund: refundLease,
    snapshot,
    storeType: store.type || "custom",
  };
};

const removeOneTimestamp = (timestamps, target) => {
  const index = timestamps.indexOf(target);
  if (index === -1) return false;
  timestamps.splice(index, 1);
  return true;
};

const snapshotStore = (store) => {
  const output = {};
  for (const [key, timestamps] of store.entries()) {
    output[key] = [...timestamps];
  }
  return output;
};

module.exports = {
  DEFAULT_USER_LIMIT_PER_HOUR,
  DEFAULT_GUILD_LIMIT_PER_DAY,
  HOUR_MS,
  DAY_MS,
  createInMemoryRateLimitStore,
  createImageGenerationRateLimiter,
};

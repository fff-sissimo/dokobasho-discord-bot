const {
  HOUR_MS,
  DAY_MS,
  createInMemoryRateLimitStore,
  createImageGenerationRateLimiter,
} = require("../src/image-generation-rate-limit");

test("separates check, consume, and refund for user hourly limit", () => {
  let current = 1000;
  const limiter = createImageGenerationRateLimiter({
    userLimitPerHour: 2,
    guildLimitPerDay: 10,
    now: () => current,
  });

  expect(limiter.check({ userId: "user-1", guildId: "guild-1" }).allowed).toBe(true);
  const first = limiter.consume({ userId: "user-1", guildId: "guild-1", requestId: "req-1" });
  const second = limiter.consume({ userId: "user-1", guildId: "guild-1", requestId: "req-2" });
  const blocked = limiter.check({ userId: "user-1", guildId: "guild-1" });

  expect(first.allowed).toBe(true);
  expect(second.allowed).toBe(true);
  expect(blocked.allowed).toBe(false);
  expect(blocked.reasons).toContain("user_rate_limited");

  expect(limiter.refund(first.lease)).toBe(true);
  expect(limiter.check({ userId: "user-1", guildId: "guild-1" }).allowed).toBe(true);
});

test("returns retryAfterMs and expires user and guild windows with injected clock", () => {
  let current = 0;
  const limiter = createImageGenerationRateLimiter({
    userLimitPerHour: 1,
    guildLimitPerDay: 1,
    now: () => current,
  });

  expect(limiter.consume({ userId: "user-1", guildId: "guild-1" }).allowed).toBe(true);
  let blocked = limiter.check({ userId: "user-1", guildId: "guild-1" });
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterMs).toBe(DAY_MS);

  current = HOUR_MS + 1;
  blocked = limiter.check({ userId: "user-1", guildId: "guild-1" });
  expect(blocked.allowed).toBe(false);
  expect(blocked.reasons).toEqual(["guild_rate_limited"]);

  current = DAY_MS + 1;
  expect(limiter.check({ userId: "user-1", guildId: "guild-1" }).allowed).toBe(true);
});

test("checkAndConsume keeps backwards-compatible refund handle", () => {
  const limiter = createImageGenerationRateLimiter({
    userLimitPerHour: 1,
    guildLimitPerDay: 1,
    now: () => 100,
  });

  const result = limiter.checkAndConsume({ userId: "user-1", guildId: "guild-1" });
  expect(result.allowed).toBe(true);
  expect(result.refund()).toBe(true);
  expect(limiter.check({ userId: "user-1", guildId: "guild-1" }).allowed).toBe(true);
});

test("uses explicit in-memory store adapter and shares state when the same store is injected", () => {
  const store = createInMemoryRateLimitStore();
  const firstLimiter = createImageGenerationRateLimiter({
    userLimitPerHour: 1,
    guildLimitPerDay: 10,
    now: () => 100,
    store,
  });
  const secondLimiter = createImageGenerationRateLimiter({
    userLimitPerHour: 1,
    guildLimitPerDay: 10,
    now: () => 100,
    store,
  });

  expect(firstLimiter.storeType).toBe("in_memory_single_process");
  expect(firstLimiter.consume({ userId: "user-1", guildId: "guild-1" }).allowed).toBe(true);
  expect(secondLimiter.check({ userId: "user-1", guildId: "guild-1" })).toEqual({
    allowed: false,
    retryAfterMs: HOUR_MS,
    reasons: ["user_rate_limited"],
  });
  expect(store.snapshot().users["user-1"]).toEqual([100]);
});

test("supports custom store adapter for future persistent/shared implementations", () => {
  const backing = {
    users: new Map(),
    guilds: new Map(),
  };
  const setCalls = [];
  const customStore = {
    type: "custom_test_store",
    get(scope, key) {
      if (!backing[scope].has(key)) backing[scope].set(key, []);
      return backing[scope].get(key);
    },
    set(scope, key, timestamps) {
      setCalls.push({ scope, key, timestamps: [...timestamps] });
      backing[scope].set(key, [...timestamps]);
    },
    snapshot() {
      return {
        users: Object.fromEntries(backing.users.entries()),
        guilds: Object.fromEntries(backing.guilds.entries()),
      };
    },
  };
  const limiter = createImageGenerationRateLimiter({
    userLimitPerHour: 1,
    guildLimitPerDay: 1,
    now: () => 500,
    store: customStore,
  });

  expect(limiter.storeType).toBe("custom_test_store");
  const lease = limiter.consume({ userId: "user-1", guildId: "guild-1" }).lease;
  expect(limiter.snapshot().users["user-1"]).toEqual([500]);
  expect(setCalls).toEqual(expect.arrayContaining([
    { scope: "users", key: "user-1", timestamps: [] },
    { scope: "guilds", key: "guild-1", timestamps: [] },
    { scope: "users", key: "user-1", timestamps: [500] },
    { scope: "guilds", key: "guild-1", timestamps: [500] },
  ]));

  setCalls.length = 0;
  expect(limiter.refund(lease)).toBe(true);
  expect(setCalls).toEqual([
    { scope: "users", key: "user-1", timestamps: [] },
    { scope: "guilds", key: "guild-1", timestamps: [] },
  ]);
});

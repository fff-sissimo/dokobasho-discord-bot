const {
  ImageGenerationQueueError,
  createImageGenerationQueue,
} = require("../src/image-generation-queue");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("runs jobs up to guild concurrency and drains queued jobs in order", async () => {
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started = [];
  const queue = createImageGenerationQueue({ concurrency: 2, queueSize: 5 });

  const job1 = queue.enqueue({ guildId: "guild-1", jobId: "job-1", run: () => {
    started.push("job-1");
    return first.promise;
  } });
  const job2 = queue.enqueue({ guildId: "guild-1", jobId: "job-2", run: () => {
    started.push("job-2");
    return second.promise;
  } });
  const job3 = queue.enqueue({ guildId: "guild-1", jobId: "job-3", run: () => {
    started.push("job-3");
    return third.promise;
  } });

  await Promise.resolve();
  expect(job1.status).toBe("running");
  expect(job2.status).toBe("running");
  expect(job3.status).toBe("queued");
  expect(started).toEqual(["job-1", "job-2"]);
  expect(queue.snapshot()["guild-1"]).toEqual({ active: 2, queued: ["job-3"] });

  first.resolve("done-1");
  await job1.promise;
  await Promise.resolve();
  expect(started).toEqual(["job-1", "job-2", "job-3"]);

  second.resolve("done-2");
  third.resolve("done-3");
  await expect(job2.promise).resolves.toBe("done-2");
  await expect(job3.promise).resolves.toBe("done-3");
});

test("claimNextQueued atomically starts one queued job when capacity is available", async () => {
  const queue = createImageGenerationQueue({ concurrency: 1, queueSize: 5 });
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started = [];

  const job1 = queue.enqueue({ guildId: "guild-1", jobId: "job-1", run: () => first.promise });
  const job2 = queue.enqueue({ guildId: "guild-1", jobId: "job-2", run: () => {
    started.push("job-2");
    return second.promise;
  } });
  const job3 = queue.enqueue({ guildId: "guild-1", jobId: "job-3", run: () => {
    started.push("job-3");
    return third.promise;
  } });

  expect(job2.position).toBe(1);
  expect(job3.position).toBe(2);
  expect(queue.claimNextQueued("guild-1").claimed).toBe(false);

  first.resolve("done-1");
  await job1.promise;
  await Promise.resolve();
  expect(started).toEqual(["job-2"]);
  expect(queue.snapshot()["guild-1"]).toEqual({ active: 1, queued: ["job-3"] });

  expect(queue.claimNextQueued("guild-1").claimed).toBe(false);
  second.resolve("done-2");
  await job2.promise;
  await Promise.resolve();
  expect(started).toEqual(["job-2", "job-3"]);

  third.resolve("done-3");
  await job3.promise;
});

test("cancels queued jobs without touching running jobs", async () => {
  const queue = createImageGenerationQueue({ concurrency: 1, queueSize: 5 });
  const first = deferred();
  const job1 = queue.enqueue({ guildId: "guild-1", jobId: "job-1", run: () => first.promise });
  const job2 = queue.enqueue({ guildId: "guild-1", jobId: "job-2", run: () => Promise.resolve("never") });

  expect(queue.cancel("job-1")).toEqual({ cancelled: false, reason: "not_queued" });
  expect(queue.cancel("job-2")).toEqual({ cancelled: true, jobId: "job-2" });
  await expect(job2.promise).rejects.toBeInstanceOf(ImageGenerationQueueError);

  first.resolve("done-1");
  await expect(job1.promise).resolves.toBe("done-1");
});

test("cancel can enforce requester ownership from job metadata", async () => {
  const queue = createImageGenerationQueue({ concurrency: 1, queueSize: 5 });
  const first = deferred();
  const job1 = queue.enqueue({ guildId: "guild-1", jobId: "job-1", run: () => first.promise });
  const job2 = queue.enqueue({
    guildId: "guild-1",
    jobId: "job-2",
    metadata: { userId: "owner-1" },
    run: () => Promise.resolve("never"),
  });

  expect(queue.cancel("job-2", { userId: "other-user" })).toEqual({
    cancelled: false,
    reason: "forbidden",
  });
  expect(queue.cancel("job-2")).toEqual({
    cancelled: false,
    reason: "forbidden",
  });
  expect(queue.cancel("job-2", {})).toEqual({
    cancelled: false,
    reason: "forbidden",
  });
  expect(queue.getStatus("job-2")).toEqual(expect.objectContaining({
    jobId: "job-2",
    status: "queued",
    metadata: { userId: "owner-1" },
  }));
  expect(queue.cancel("job-2", { userId: "owner-1" })).toEqual({ cancelled: true, jobId: "job-2" });
  await expect(job2.promise).rejects.toMatchObject({ code: "cancelled" });

  first.resolve("done-1");
  await expect(job1.promise).resolves.toBe("done-1");
});

test("claim and drain skip queued jobs that exceeded TTL even without timer firing", async () => {
  let current = 0;
  const queue = createImageGenerationQueue({
    concurrency: 1,
    queueSize: 5,
    ttlMs: 900000,
    now: () => current,
  });
  const first = deferred();
  const started = [];

  const job1 = queue.enqueue({ guildId: "guild-1", jobId: "job-1", run: () => first.promise });
  const expiredJob = queue.enqueue({
    guildId: "guild-1",
    jobId: "job-2",
    run: () => {
      started.push("job-2");
      return Promise.resolve("expired job should not start");
    },
  });
  const expiredAssertion = expect(expiredJob.promise).rejects.toMatchObject({ code: "expired" });

  current = 900001;
  expect(queue.claimNextQueued("guild-1")).toEqual({
    claimed: false,
    reason: "concurrency_full",
  });
  expect(queue.snapshot()["guild-1"]).toEqual({ active: 1, queued: [] });
  await expiredAssertion;

  first.resolve("done-1");
  await expect(job1.promise).resolves.toBe("done-1");
  await Promise.resolve();
  expect(started).toEqual([]);
});

test("enforces per-guild queue size", () => {
  const queue = createImageGenerationQueue({ concurrency: 1, queueSize: 1 });
  const first = deferred();

  expect(queue.enqueue({ guildId: "guild-1", jobId: "job-1", run: () => first.promise }).accepted).toBe(true);
  expect(queue.enqueue({ guildId: "guild-1", jobId: "job-2", run: () => Promise.resolve("queued") }).accepted).toBe(true);
  expect(queue.enqueue({ guildId: "guild-1", jobId: "job-3", run: () => Promise.resolve("full") })).toEqual({
    accepted: false,
    reason: "queue_full",
  });

  first.resolve("done-1");
});

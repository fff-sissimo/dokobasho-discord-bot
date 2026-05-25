"use strict";

const DEFAULT_GUILD_CONCURRENCY = 2;
const DEFAULT_GUILD_QUEUE_SIZE = 5;
const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;

class ImageGenerationQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ImageGenerationQueueError";
    this.code = code;
  }
}

const createImageGenerationQueue = ({
  concurrency = DEFAULT_GUILD_CONCURRENCY,
  queueSize = DEFAULT_GUILD_QUEUE_SIZE,
  ttlMs = DEFAULT_QUEUE_TTL_MS,
  now = () => Date.now(),
} = {}) => {
  const guilds = new Map();
  const jobsById = new Map();

  const getGuild = (guildId) => {
    const key = String(guildId);
    if (!guilds.has(key)) {
      guilds.set(key, {
        active: 0,
        queue: [],
      });
    }
    return guilds.get(key);
  };

  const enqueue = ({ guildId, jobId, run, metadata = {} } = {}) => {
    if (!guildId || !jobId || typeof run !== "function") {
      return {
        accepted: false,
        reason: "invalid_request",
      };
    }

    if (jobsById.has(jobId)) {
      return {
        accepted: false,
        reason: "duplicate_job",
      };
    }

    const guild = getGuild(guildId);
    expireExpiredQueuedJobs(guild, now());
    if (guild.active >= concurrency && guild.queue.length >= queueSize) {
      return {
        accepted: false,
        reason: "queue_full",
      };
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const job = {
      id: jobId,
      guildId: String(guildId),
      run,
      metadata,
      status: "queued",
      enqueuedAt: now(),
      startedAt: null,
      finishedAt: null,
      timeoutId: null,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
    };

    jobsById.set(job.id, job);

    if (guild.active < concurrency) {
      startJob(job, guild);
    } else {
      guild.queue.push(job);
      job.timeoutId = setTimeout(() => {
        expireQueuedJob(job.id);
      }, ttlMs);
      if (job.timeoutId && typeof job.timeoutId.unref === "function") {
        job.timeoutId.unref();
      }
    }

    return {
      accepted: true,
      jobId: job.id,
      status: job.status,
      position: getPosition(job),
      promise,
      cancel: (options) => cancel(job.id, options),
    };
  };

  const claimNextQueued = (guildId, claimedAt = now()) => {
    if (!guildId) {
      return {
        claimed: false,
        reason: "invalid_request",
      };
    }
    const guild = getGuild(guildId);
    expireExpiredQueuedJobs(guild, claimedAt);
    if (guild.active >= concurrency) {
      return {
        claimed: false,
        reason: "concurrency_full",
      };
    }
    const job = guild.queue.shift();
    if (!job) {
      return {
        claimed: false,
        reason: "empty",
      };
    }
    startJob(job, guild, claimedAt);
    return {
      claimed: true,
      jobId: job.id,
      status: job.status,
      promise: job.promise,
    };
  };

  const startJob = (job, guild, startedAt = now()) => {
    clearJobTimer(job);
    job.status = "running";
    job.startedAt = startedAt;
    guild.active += 1;

    Promise.resolve()
      .then(() => job.run())
      .then((result) => {
        finishJob(job, guild, "completed");
        job.resolve(result);
      })
      .catch((error) => {
        finishJob(job, guild, "failed");
        job.reject(error);
      });
  };

  const finishJob = (job, guild, status) => {
    job.status = status;
    job.finishedAt = now();
    guild.active = Math.max(0, guild.active - 1);
    jobsById.delete(job.id);
    drainGuild(guild);
  };

  const drainGuild = (guild) => {
    expireExpiredQueuedJobs(guild, now());
    while (guild.active < concurrency && guild.queue.length > 0) {
      const nextJob = guild.queue[0];
      const result = claimNextQueued(nextJob.guildId);
      if (!result.claimed) break;
    }
  };

  const cancel = (jobId, options = {}) => {
    const job = jobsById.get(jobId);
    if (!job) {
      return {
        cancelled: false,
        reason: "not_found",
      };
    }
    const ownerUserId = job.metadata && job.metadata.userId ? String(job.metadata.userId) : null;
    const requesterUserId = options && options.userId ? String(options.userId) : null;
    if (ownerUserId && ownerUserId !== requesterUserId) {
      return {
        cancelled: false,
        reason: "forbidden",
      };
    }
    if (job.status !== "queued") {
      return {
        cancelled: false,
        reason: "not_queued",
      };
    }

    const guild = getGuild(job.guildId);
    const index = guild.queue.findIndex((queuedJob) => queuedJob.id === job.id);
    if (index !== -1) guild.queue.splice(index, 1);
    clearJobTimer(job);
    job.status = "cancelled";
    job.finishedAt = now();
    jobsById.delete(job.id);
    job.reject(new ImageGenerationQueueError("Queued image generation job was cancelled.", "cancelled"));
    return {
      cancelled: true,
      jobId: job.id,
    };
  };

  const expireQueuedJob = (jobId) => {
    const job = jobsById.get(jobId);
    if (!job || job.status !== "queued") return false;
    const guild = getGuild(job.guildId);
    const index = guild.queue.findIndex((queuedJob) => queuedJob.id === job.id);
    if (index !== -1) guild.queue.splice(index, 1);
    job.status = "expired";
    job.finishedAt = now();
    jobsById.delete(job.id);
    job.reject(new ImageGenerationQueueError("Queued image generation job expired.", "expired"));
    return true;
  };

  const expireExpiredQueuedJobs = (guild, current) => {
    let expiredCount = 0;
    for (const job of [...guild.queue]) {
      if (job.enqueuedAt + ttlMs <= current && expireQueuedJob(job.id)) {
        expiredCount += 1;
      }
    }
    return expiredCount;
  };

  const getStatus = (jobId) => {
    const job = jobsById.get(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      guildId: job.guildId,
      status: job.status,
      position: getPosition(job),
      enqueuedAt: job.enqueuedAt,
      startedAt: job.startedAt,
      metadata: job.metadata,
    };
  };

  const snapshot = () => {
    const output = {};
    for (const [guildId, guild] of guilds.entries()) {
      output[guildId] = {
        active: guild.active,
        queued: guild.queue.map((job) => job.id),
      };
    }
    return output;
  };

  const getPosition = (job) => {
    if (job.status === "running") return 0;
    const guild = getGuild(job.guildId);
    const index = guild.queue.findIndex((queuedJob) => queuedJob.id === job.id);
    return index === -1 ? null : index + 1;
  };

  const clearJobTimer = (job) => {
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }
  };

  return {
    enqueue,
    claimNextQueued,
    cancel,
    getStatus,
    snapshot,
  };
};

module.exports = {
  DEFAULT_GUILD_CONCURRENCY,
  DEFAULT_GUILD_QUEUE_SIZE,
  DEFAULT_QUEUE_TTL_MS,
  ImageGenerationQueueError,
  createImageGenerationQueue,
};

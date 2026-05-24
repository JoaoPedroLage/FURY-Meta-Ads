import { Queue } from "bullmq";
import { ViolationPayload } from "../schemas/violation.schema";
import { redisConnection } from "./redis";

export const QUEUE_NAME = "takedown";

export const takedownQueue = new Queue<ViolationPayload>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
  },
});

/**
 * Enqueues a takedown job, enforcing idempotency via a deterministic jobId.
 * BullMQ will not add a new job if one with the same ID is already waiting or active.
 */
export async function enqueueTakedown(payload: ViolationPayload): Promise<string> {
  const jobId = `${payload.adId}:${payload.tenantId}`;

  const existing = await takedownQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    // Reject duplicates only while the job is still pending or running
    if (state === "waiting" || state === "active" || state === "delayed") {
      throw new DuplicateJobError(jobId, state);
    }
  }

  const job = await takedownQueue.add("takedown", payload, { jobId });
  return job.id!;
}

export class DuplicateJobError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly state: string
  ) {
    super(`Job ${jobId} already exists with state "${state}"`);
    this.name = "DuplicateJobError";
  }
}

import "dotenv/config";
import axios, { AxiosError } from "axios";
import { Worker, Job, UnrecoverableError } from "bullmq";
import { ViolationPayload } from "../schemas/violation.schema";
import { redisConnection } from "./redis";
import { QUEUE_NAME } from "./takedown.queue";

const META_API_URL =
  process.env.META_API_URL ?? "https://jsonplaceholder.typicode.com/posts/1";

const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? "5000", 10);

async function processTakedown(job: Job<ViolationPayload>): Promise<{ statusCode: number }> {
  console.log(`[worker] Processing job ${job.id} (attempt ${job.attemptsMade + 1})`);

  try {
    const response = await axios.get(META_API_URL, { timeout: HTTP_TIMEOUT_MS });
    console.log(`[worker] Job ${job.id} succeeded — HTTP ${response.status}`);
    return { statusCode: response.status };
  } catch (err) {
    const axiosErr = err as AxiosError;

    if (axiosErr.response) {
      const status = axiosErr.response.status;
      // 4xx errors are client-side faults — retrying won't help
      if (status >= 400 && status < 500) {
        throw new UnrecoverableError(
          `Meta API returned ${status} — aborting retries`
        );
      }
      // 5xx: let BullMQ retry with backoff
      throw new Error(`Meta API returned ${status}`);
    }

    if (axiosErr.code === "ECONNABORTED" || axiosErr.message.includes("timeout")) {
      throw new Error("Meta API request timed out");
    }

    throw new Error(`Unexpected error: ${axiosErr.message}`);
  }
}

const worker = new Worker<ViolationPayload>(QUEUE_NAME, processTakedown, {
  connection: redisConnection,
  concurrency: 5,
});

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} failed: ${err.message}`);
});

worker.on("error", (err) => {
  console.error("[worker] Worker error:", err);
});

console.log(`[worker] Listening on queue "${QUEUE_NAME}"...`);

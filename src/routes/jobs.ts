import { Router, Request, Response } from "express";
import { takedownQueue } from "../queues/takedown.queue";

export const jobsRouter = Router();

jobsRouter.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const job = await takedownQueue.getJob(id);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const state = await job.getState();
  const returnValue = job.returnvalue as { statusCode: number } | null;
  const failedReason = job.failedReason ?? null;

  res.json({
    jobId: job.id,
    status: state,
    attempts: job.attemptsMade,
    result: returnValue ?? null,
    error: failedReason,
  });
});

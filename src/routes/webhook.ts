import { Router, Request, Response } from "express";
import { ZodError } from "zod";
import { violationSchema } from "../schemas/violation.schema";
import { enqueueTakedown, DuplicateJobError } from "../queues/takedown.queue";

export const webhookRouter = Router();

webhookRouter.post("/violation", async (req: Request, res: Response) => {
  const parseResult = violationSchema.safeParse(req.body);

  if (!parseResult.success) {
    const formatted = (parseResult.error as ZodError).flatten();
    res.status(400).json({
      error: "Invalid payload",
      details: formatted.fieldErrors,
    });
    return;
  }

  try {
    const jobId = await enqueueTakedown(parseResult.data);
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    if (err instanceof DuplicateJobError) {
      res.status(409).json({
        error: "Duplicate job",
        message: err.message,
        jobId: err.jobId,
      });
      return;
    }
    console.error("[webhook] Failed to enqueue job:", err);
    res.status(500).json({ error: "Failed to enqueue job" });
  }
});

import "dotenv/config";
import express from "express";
import { webhookRouter } from "./routes/webhook";
import { jobsRouter } from "./routes/jobs";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/webhook", webhookRouter);
app.use("/jobs", jobsRouter);

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

export default app;

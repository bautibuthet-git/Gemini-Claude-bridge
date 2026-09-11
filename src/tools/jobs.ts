import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeContext } from "../context.js";
import type { Job } from "../jobs.js";
import { errorResult, textResult } from "./result.js";

export const RESULT_DESCRIPTION =
  "Collect the answer of a background gemini_ask (one started with background: true). With waitSeconds it waits up to that long for the job to finish. Without jobId it lists this session's background jobs.";

export const resultInputSchema = {
  jobId: z
    .string()
    .regex(/^[a-f0-9]{8}$/, "Use the jobId returned by gemini_ask")
    .optional()
    .describe("The jobId returned by gemini_ask with background: true. Omit to list this session's jobs."),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(120)
    .optional()
    .describe("Wait up to this many seconds for a running job to finish (default 0: answer right away)."),
};

export async function handleResult(ctx: BridgeContext, args: { jobId?: string; waitSeconds?: number }): Promise<CallToolResult> {
  const seconds = (job: Job) => Math.round(((job.finishedAt ?? ctx.now().getTime()) - job.startedAt) / 1000);

  if (!args.jobId) {
    const jobs = ctx.jobs.list();
    const summary =
      jobs.length === 0
        ? "No background Gemini jobs in this session."
        : jobs.map((job) => `${job.id} · ${job.status} · ${seconds(job)}s · ${job.label}`).join("\n");
    return textResult(summary, {
      summary,
      jobs: jobs.map((job) => ({ jobId: job.id, status: job.status, seconds: seconds(job), label: job.label })),
    });
  }

  const job = ctx.jobs.get(args.jobId);
  if (!job) return errorResult("unknown_job", `No background job "${args.jobId}" in this session.`);

  await ctx.jobs.wait(job, (args.waitSeconds ?? 0) * 1000);
  if (job.status === "running" || !job.result) {
    const message = `Job ${job.id} is still running (${seconds(job)}s so far): ${job.label}. Call gemini_result again later, or pass waitSeconds.`;
    return textResult(message, { message, jobId: job.id, status: "running" });
  }
  return {
    ...job.result,
    content: [{ type: "text", text: `Background job ${job.id} (${job.label}) finished after ${seconds(job)}s:` }, ...job.result.content],
  };
}

export function registerResultTool(server: McpServer, ctx: BridgeContext): void {
  server.registerTool(
    "gemini_result",
    {
      title: "Collect a background Gemini answer",
      description: RESULT_DESCRIPTION,
      inputSchema: resultInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => handleResult(ctx, args),
  );
}

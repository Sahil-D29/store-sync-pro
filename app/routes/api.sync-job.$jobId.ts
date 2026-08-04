import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSyncJobStatus } from "../services/sync-engine.server";

/**
 * GET /api/sync-job/:jobId
 * Poll for background sync job progress.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const { jobId } = params;
  if (!jobId) return json({ error: "Missing jobId" }, { status: 400 });

  const job = await getSyncJobStatus(jobId);
  if (!job) return json({ error: "Job not found" }, { status: 404 });

  let errors: unknown[] = [];
  if (job.errors) {
    try {
      const parsed = JSON.parse(job.errors);
      errors = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      errors = [job.errors];
    }
  }

  return json({
    id: job.id,
    status: job.status,
    totalProducts: job.totalProducts,
    syncedProducts: job.syncedProducts,
    failedProducts: job.failedProducts,
    skippedProducts: job.skippedProducts,
    errors,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
}

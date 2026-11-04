import { db } from "@/db";
import { focusCsv } from "@/db/focus-export";
import { usageCsv } from "@/db/usage-export";
import { requireUser } from "@/lib/auth";
import { parseUsageFilters } from "@/lib/usage-filters";

export const dynamic = "force-dynamic";

/**
 * Every usage event matching the usage page's filters, as a CSV download:
 * the tracker's own columns, or FOCUS 1.4 with `?format=focus`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  await requireUser(`/usage${url.search}`);
  const { cursor, ...filters } = parseUsageFilters(
    Object.fromEntries(url.searchParams),
  );
  void cursor;

  const focus = url.searchParams.get("format") === "focus";
  const chunks = focus ? focusCsv(db, filters) : usageCsv(db, filters);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-${focus ? "focus-" : ""}${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}

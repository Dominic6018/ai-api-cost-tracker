import { and, eq, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { csvRow } from "@/lib/csv";
import { FOCUS_COLUMNS, focusRows } from "@/lib/focus";
import { priceTierFor, selectEffectivePricing } from "@/lib/pricing";
import type { UsageFilters } from "@/lib/usage-filters";
import { modelPricing, type ModelPricing } from "./schema";
import { listUsageEvents } from "./usage-events";
import type { OrganizationScope } from "./scope";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "selectDistinct">;

const EXPORT_PAGE_SIZE = 1000;

/**
 * Every usage event matching `filters` as FOCUS 1.4 CSV chunks: the
 * header, then one chunk per page of events, each priced at the price in
 * effect when it occurred. Events whose price row no longer exists are
 * left out, since FOCUS usage rows need a SKU price.
 */
export async function* focusCsv(
  db: Database,
  scope: OrganizationScope,
  filters: Omit<UsageFilters, "cursor">,
  pageSize = EXPORT_PAGE_SIZE,
): AsyncGenerator<string> {
  yield csvRow(FOCUS_COLUMNS);
  // Every price row for a provider/model, fetched once per export.
  const prices = new Map<string, ModelPricing[]>();
  const key = (provider: string, model: string) => `${provider}\u0000${model}`;

  let cursor: UsageFilters["cursor"];
  do {
    const page = await listUsageEvents(
      db,
      scope,
      { ...filters, cursor },
      pageSize,
    );
    const missing = [
      ...new Map(
        page.rows
          .filter((row) => !prices.has(key(row.provider, row.model)))
          .map((row) => [key(row.provider, row.model), row]),
      ).values(),
    ];
    if (missing.length > 0) {
      const rows = await db
        .select()
        .from(modelPricing)
        .where(
          or(
            ...missing.map((row) =>
              and(
                eq(modelPricing.provider, row.provider),
                eq(modelPricing.model, row.model),
              ),
            ),
          ),
        );
      for (const row of missing) prices.set(key(row.provider, row.model), []);
      for (const row of rows)
        prices.get(key(row.provider, row.model))!.push(row);
    }

    const lines = page.rows.flatMap((event) => {
      // Each tier has its own prices; batch uses the standard row.
      const tier = priceTierFor(event.serviceTier);
      const lookup = selectEffectivePricing(
        prices
          .get(key(event.provider, event.model))!
          .filter((row) => row.serviceTier === tier),
        event.occurredAt,
      );
      if (!lookup.found) return [];
      return focusRows(event, lookup.row).map((row) =>
        csvRow(FOCUS_COLUMNS.map((column) => row[column])),
      );
    });
    if (lines.length > 0) yield lines.join("");
    cursor = page.next;
  } while (cursor);
}

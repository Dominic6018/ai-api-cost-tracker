/**
 * Revenue against AI API cost, per customer and month. Revenue is what
 * the billing ledger billed; cost is what the customer's usage cost at
 * provider prices. Their difference is "revenue minus AI API cost": it
 * leaves out every other cost, so it's never called profit.
 */

export interface RevenueInput {
  /** The usage customerId; null for usage attributed to no customer. */
  customerId: string | null;
  /** The billing customer's name; null if they aren't one. */
  name: string | null;
  revenueMicros: bigint;
  costMicros: bigint;
  /** Requests whose cost isn't known yet, so `costMicros` is short. */
  unpriced: number;
}

export interface RevenueRow extends RevenueInput {
  /** Revenue minus AI API cost. */
  differenceMicros: bigint;
  /**
   * The difference as a share of revenue, in tenths of a percent rounded
   * toward zero (412 = 41.2%); null without revenue, where it's undefined.
   */
  sharePermille: number | null;
}

export interface RevenueReport {
  rows: RevenueRow[];
  total: Omit<RevenueRow, "customerId" | "name">;
}

function row<T extends Omit<RevenueInput, "customerId" | "name">>(
  input: T,
): T & Pick<RevenueRow, "differenceMicros" | "sharePermille"> {
  const differenceMicros = input.revenueMicros - input.costMicros;
  return {
    ...input,
    differenceMicros,
    sharePermille:
      input.revenueMicros > 0n
        ? Number((differenceMicros * 1000n) / input.revenueMicros)
        : null,
  };
}

/**
 * Rows by customer, largest revenue first, then largest cost; usage with
 * no customer goes last. Totals add every row, exactly.
 */
export function revenueReport(inputs: RevenueInput[]): RevenueReport {
  const rows = inputs
    .map((input) => row(input))
    .sort((a, b) => {
      if ((a.customerId === null) !== (b.customerId === null)) {
        return a.customerId === null ? 1 : -1;
      }
      const byRevenue = b.revenueMicros - a.revenueMicros;
      if (byRevenue !== 0n) return byRevenue > 0n ? 1 : -1;
      const byCost = b.costMicros - a.costMicros;
      if (byCost !== 0n) return byCost > 0n ? 1 : -1;
      return (a.customerId ?? "").localeCompare(b.customerId ?? "");
    });
  const sum = (pick: (r: RevenueInput) => bigint) =>
    inputs.reduce((total, r) => total + pick(r), 0n);
  return {
    rows,
    total: row({
      revenueMicros: sum((r) => r.revenueMicros),
      costMicros: sum((r) => r.costMicros),
      unpriced: inputs.reduce((total, r) => total + r.unpriced, 0),
    }),
  };
}

/** A share in tenths of a percent as "41.2%", or "—" when undefined. */
export function formatShare(permille: number | null): string {
  if (permille === null) return "—";
  const sign = permille < 0 ? "-" : "";
  const abs = Math.abs(permille);
  return `${sign}${Math.floor(abs / 10)}.${abs % 10}%`;
}

/**
 * The budget check an app calls before spending: may it spend about this
 * much now, given the project's monthly budget and its per-run budget?
 */

import { z } from "zod";
import { MAX_ATTRIBUTION_LENGTH } from "./attribution";
import { toMicros } from "./budget";

/** The largest estimate accepted, in USD. */
export const MAX_ESTIMATE_USD = 1_000_000_000;

const AMOUNT = /^\d+(\.\d{1,6})?$/;

/**
 * A USD amount as a decimal string ("0.25") or a JSON number (0.25), with
 * up to six decimals, the precision costs are stored in.
 */
const estimate = z
  .union([z.string().trim(), z.number()])
  .transform((value, ctx) => {
    const text = typeof value === "number" ? String(value) : value;
    if (
      !AMOUNT.test(text) ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      Number(text) > MAX_ESTIMATE_USD
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Use a non-negative USD amount with up to 6 decimals, at most ${MAX_ESTIMATE_USD}, e.g. "0.25"`,
      });
      return z.NEVER;
    }
    return toMicros(text);
  });

/** Body of `POST /api/budget/check`; every field is optional. */
export const budgetCheckPayloadSchema = z
  .object({
    estimatedCostUsd: estimate.optional(),
    runId: z.string().trim().min(1).max(MAX_ATTRIBUTION_LENGTH).optional(),
  })
  .strict();

export interface BudgetCheckRequest {
  /** Micro-dollars; 0 when no estimate was given. */
  estimateMicros: bigint;
  runId?: string;
}

export type ParseBudgetCheckResult =
  | { ok: true; request: BudgetCheckRequest }
  | { ok: false; fieldErrors: Record<string, string[]>; formErrors: string[] };

export function parseBudgetCheckPayload(body: unknown): ParseBudgetCheckResult {
  const result = budgetCheckPayloadSchema.safeParse(body);
  if (!result.success) {
    const { fieldErrors, formErrors } = z.flattenError(result.error);
    return { ok: false, fieldErrors, formErrors };
  }
  return {
    ok: true,
    request: {
      estimateMicros: result.data.estimatedCostUsd ?? 0n,
      ...(result.data.runId && { runId: result.data.runId }),
    },
  };
}

/** Micro-dollars as an exact decimal string, e.g. "-1.250000". */
export function microsToDecimal(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${abs / 1_000_000n}.${fraction}`;
}

export interface CapCheck {
  /** Null when no cap is set, which never denies. */
  capUsd: string | null;
  spentUsd: string;
  /** Negative when over the cap; null without a cap. */
  remainingUsd: string | null;
  allowed: boolean;
}

/**
 * Whether `estimateMicros` more fits under a cap. Nothing left (spend at
 * or over the cap, as the dashboard's "over" at exactly 100%) denies even
 * a zero estimate; otherwise the estimate may use up exactly what's left.
 */
export function checkCap(
  spentMicros: bigint,
  capMicros: bigint | null,
  estimateMicros: bigint,
): CapCheck {
  const spentUsd = microsToDecimal(spentMicros);
  if (capMicros === null) {
    return { capUsd: null, spentUsd, remainingUsd: null, allowed: true };
  }
  const remaining = capMicros - spentMicros;
  return {
    capUsd: microsToDecimal(capMicros),
    spentUsd,
    remainingUsd: microsToDecimal(remaining),
    allowed: remaining > 0n && estimateMicros <= remaining,
  };
}

export type DenyReason = "monthly_budget" | "run_budget";

export interface BudgetCheckInputs {
  /** Exact decimal strings, as Postgres returns them. */
  monthlyBudgetUsd: string | null;
  runBudgetUsd: string | null;
  monthSpentUsd: string;
  /** Null when the request named no run. */
  runSpentUsd: string | null;
}

export interface BudgetCheckResult {
  allowed: boolean;
  /** Why it was denied; empty when allowed. */
  reasons: DenyReason[];
  estimatedCostUsd: string;
  /** This UTC month against the monthly budget. */
  month: CapCheck & { period: string };
  /** The named run against the run budget; null without a runId. */
  run: (CapCheck & { runId: string }) | null;
}

/** The answer for a request, given the project's caps and spend. */
export function decideBudgetCheck(
  request: BudgetCheckRequest,
  inputs: BudgetCheckInputs,
  now: Date,
): BudgetCheckResult {
  const cap = (usd: string | null) => (usd === null ? null : toMicros(usd));
  const month = checkCap(
    toMicros(inputs.monthSpentUsd),
    cap(inputs.monthlyBudgetUsd),
    request.estimateMicros,
  );
  const run =
    request.runId !== undefined && inputs.runSpentUsd !== null
      ? checkCap(
          toMicros(inputs.runSpentUsd),
          cap(inputs.runBudgetUsd),
          request.estimateMicros,
        )
      : null;
  const reasons: DenyReason[] = [];
  if (!month.allowed) reasons.push("monthly_budget");
  if (run && !run.allowed) reasons.push("run_budget");
  return {
    allowed: reasons.length === 0,
    reasons,
    estimatedCostUsd: microsToDecimal(request.estimateMicros),
    month: { period: now.toISOString().slice(0, 7), ...month },
    run: run && request.runId ? { runId: request.runId, ...run } : null,
  };
}

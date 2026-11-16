import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AuditEntry } from "@/lib/audit";
import {
  allocateCredit,
  creditGrantedEntry,
  parseSignedDecimal,
} from "@/lib/billing";
import { microsToDecimal } from "@/lib/budget";
import { isUuid } from "@/lib/ids";
import { audited, type AuditActor } from "./audit";
import {
  billingCreditGrants,
  billingCreditUses,
  billingCustomers,
  billingLedgerEntries,
  type BillingCreditGrant,
  type BillingCustomer,
  type BillingLedgerEntry,
} from "./schema";

type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;
type Change<T> = { result: T; entry: AuditEntry | null };

export type GrantResult =
  | { ok: true; grant: BillingCreditGrant; replayed: boolean }
  | { ok: false; error: "already_expired" | "grant_key_conflict" };

/**
 * Gives a customer prepaid credit, optionally expiring. With a grant key,
 * a retry returns the stored grant; the key for a different grant is a
 * conflict.
 */
export function grantCredit(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  customer: BillingCustomer,
  input: {
    amountMicros: bigint;
    expiresAt: Date | null;
    description: string;
    grantKey?: string;
  },
  now: Date = new Date(),
): Promise<GrantResult> {
  return audited(db, actor, async (tx): Promise<Change<GrantResult>> => {
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      return { result: { ok: false, error: "already_expired" }, entry: null };
    }
    const amountUsd = microsToDecimal(input.amountMicros);
    const [grant] = await tx
      .insert(billingCreditGrants)
      .values({
        organizationId: customer.organizationId,
        customerId: customer.id,
        amountUsd,
        expiresAt: input.expiresAt,
        description: input.description,
        grantKey: input.grantKey ?? null,
        createdBy: actor.label,
      })
      .onConflictDoNothing()
      .returning();
    if (grant) {
      return {
        result: { ok: true, grant, replayed: false },
        entry: creditGrantedEntry({
          ...grant,
          customerExternalId: customer.externalId,
        }),
      };
    }
    // Only a grant key can conflict.
    const [stored] = await tx
      .select()
      .from(billingCreditGrants)
      .where(
        and(
          eq(billingCreditGrants.organizationId, customer.organizationId),
          eq(billingCreditGrants.grantKey, input.grantKey ?? ""),
        ),
      );
    const same =
      stored !== undefined &&
      stored.customerId === customer.id &&
      parseSignedDecimal(stored.amountUsd) === input.amountMicros &&
      (stored.expiresAt?.getTime() ?? null) ===
        (input.expiresAt?.getTime() ?? null) &&
      stored.description === input.description;
    return {
      result: same
        ? { ok: true, grant: stored, replayed: true }
        : { ok: false, error: "grant_key_conflict" },
      entry: null,
    };
  });
}

export interface GrantStatus {
  grant: BillingCreditGrant;
  usedMicros: bigint;
  remainingMicros: bigint;
  /** Unused credit that can no longer be used. */
  expired: boolean;
}

/** A customer's grants with what's left of each, oldest first. */
export async function listCreditGrants(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id" | "organizationId">,
  now: Date = new Date(),
): Promise<GrantStatus[]> {
  const rows = await db
    .select({
      grant: billingCreditGrants,
      used: sql<string>`coalesce(sum(${billingCreditUses.amountUsd}), 0)::text`,
    })
    .from(billingCreditGrants)
    .leftJoin(
      billingCreditUses,
      eq(billingCreditUses.grantId, billingCreditGrants.id),
    )
    .where(
      and(
        eq(billingCreditGrants.organizationId, customer.organizationId),
        eq(billingCreditGrants.customerId, customer.id),
      ),
    )
    .groupBy(billingCreditGrants.id)
    .orderBy(asc(billingCreditGrants.createdAt), asc(billingCreditGrants.id));
  return rows.map(({ grant, used }) => {
    const usedMicros = parseSignedDecimal(used);
    return {
      grant,
      usedMicros,
      remainingMicros: parseSignedDecimal(grant.amountUsd) - usedMicros,
      expired:
        grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime(),
    };
  });
}

/** Credit the customer can use now. */
export function usableCredit(grants: GrantStatus[]): bigint {
  return grants
    .filter((g) => !g.expired)
    .reduce((sum, g) => sum + g.remainingMicros, 0n);
}

async function lockCustomer(
  tx: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id">,
) {
  // One credit change per customer at a time.
  await tx
    .select({ id: billingCustomers.id })
    .from(billingCustomers)
    .where(eq(billingCustomers.id, customer.id))
    .for("update");
}

export type ApplyResult = {
  /** Credit applied; 0 when nothing was owed or no credit was usable. */
  appliedMicros: bigint;
  entry: BillingLedgerEntry | null;
};

/**
 * Uses the customer's credit against what they owe (their ledger
 * balance), soonest-expiring first, as one `credit_applied` entry. Owing
 * nothing, or having no usable credit, applies nothing; so running it
 * again changes nothing.
 */
export function applyCredits(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  customer: BillingCustomer,
  now: Date = new Date(),
): Promise<ApplyResult> {
  return audited(db, actor, async (tx): Promise<Change<ApplyResult>> => {
    await lockCustomer(tx, customer);
    const [owed] = await tx
      .select({
        balance: sql<string>`coalesce(sum(${billingLedgerEntries.amountUsd}), 0)::text`,
      })
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.organizationId, customer.organizationId),
          eq(billingLedgerEntries.customerId, customer.id),
        ),
      );
    const owedMicros = parseSignedDecimal(owed.balance);
    const grants = await listCreditGrants(tx, customer, now);
    const uses = allocateCredit(
      grants.map((g) => ({
        id: g.grant.id,
        remainingMicros: g.remainingMicros,
        expiresAt: g.grant.expiresAt,
        createdAt: g.grant.createdAt,
      })),
      owedMicros,
      now,
    );
    const appliedMicros = uses.reduce((sum, u) => sum + u.amountMicros, 0n);
    if (appliedMicros <= 0n) {
      return { result: { appliedMicros: 0n, entry: null }, entry: null };
    }
    const [entry] = await tx
      .insert(billingLedgerEntries)
      .values({
        organizationId: customer.organizationId,
        customerId: customer.id,
        kind: "credit_applied",
        amountUsd: microsToDecimal(-appliedMicros),
        description: `Credit applied from ${uses.length} grant(s)`,
        createdBy: actor.label,
      })
      .returning();
    await tx.insert(billingCreditUses).values(
      uses.map((use) => ({
        organizationId: customer.organizationId,
        customerId: customer.id,
        grantId: use.id,
        kind: "applied" as const,
        amountUsd: microsToDecimal(use.amountMicros),
        ledgerEntryId: entry.id,
        createdBy: actor.label,
      })),
    );
    return {
      result: { appliedMicros, entry },
      entry: {
        action: "billing.credits_applied",
        target: customer.externalId,
        details: {
          entryId: entry.id,
          amountUsd: microsToDecimal(appliedMicros),
          grants: uses.map((u) => ({
            grantId: u.id,
            amountUsd: microsToDecimal(u.amountMicros),
          })),
        },
        organizationId: customer.organizationId,
      },
    };
  });
}

export type RefundResult =
  | { ok: true; refundedMicros: bigint; customerExternalId: string }
  | { ok: false; error: "not_found" | "expired" | "nothing_left" };

/**
 * Withdraws what's left of a grant, e.g. when prepaid credit is paid
 * back. Credit already applied stays applied; expired credit can't be
 * refunded.
 */
export function refundCredit(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  scope: { organizationId: string },
  input: { grantId: string; reason: string },
  now: Date = new Date(),
): Promise<RefundResult> {
  return audited(db, actor, async (tx): Promise<Change<RefundResult>> => {
    if (!isUuid(input.grantId)) {
      return { result: { ok: false, error: "not_found" }, entry: null };
    }
    const [found] = await tx
      .select({
        grant: billingCreditGrants,
        customer: billingCustomers,
      })
      .from(billingCreditGrants)
      .innerJoin(
        billingCustomers,
        eq(billingCustomers.id, billingCreditGrants.customerId),
      )
      .where(
        and(
          eq(billingCreditGrants.id, input.grantId),
          eq(billingCreditGrants.organizationId, scope.organizationId),
        ),
      );
    if (!found) {
      return { result: { ok: false, error: "not_found" }, entry: null };
    }
    await lockCustomer(tx, found.customer);
    const status = (await listCreditGrants(tx, found.customer, now)).find(
      (g) => g.grant.id === input.grantId,
    )!;
    if (status.expired) {
      return { result: { ok: false, error: "expired" }, entry: null };
    }
    if (status.remainingMicros <= 0n) {
      return { result: { ok: false, error: "nothing_left" }, entry: null };
    }
    await tx.insert(billingCreditUses).values({
      organizationId: scope.organizationId,
      customerId: found.customer.id,
      grantId: input.grantId,
      kind: "refunded",
      amountUsd: microsToDecimal(status.remainingMicros),
      createdBy: actor.label,
    });
    return {
      result: {
        ok: true,
        refundedMicros: status.remainingMicros,
        customerExternalId: found.customer.externalId,
      },
      entry: {
        action: "billing.credit_refunded",
        target: found.customer.externalId,
        details: {
          grantId: input.grantId,
          amountUsd: microsToDecimal(status.remainingMicros),
          reason: input.reason,
        },
        organizationId: scope.organizationId,
      },
    };
  });
}

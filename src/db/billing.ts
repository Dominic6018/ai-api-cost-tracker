import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  customerCreatedEntry,
  ledgerEntryAudit,
  parseSignedDecimal,
} from "@/lib/billing";
import { microsToDecimal } from "@/lib/budget";
import type { AuditEntry } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { audited, type AuditActor } from "./audit";
import {
  billingCustomers,
  billingLedgerEntries,
  type BillingCustomer,
  type BillingLedgerEntry,
} from "./schema";
import type { OrganizationScope } from "./scope";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;

type Change<T> = { result: T; entry: AuditEntry | null };

/** One organization: billing data is never read across organizations. */
type InOrganization = { organizationId: string };

export type CreateCustomerResult =
  | { ok: true; customer: BillingCustomer }
  | { ok: false; error: "external_id_taken" };

/** Adds a customer to bill, with an audit log entry. */
export function createBillingCustomer(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  input: InOrganization & { externalId: string; name: string },
): Promise<CreateCustomerResult> {
  return audited(
    db,
    actor,
    async (tx): Promise<Change<CreateCustomerResult>> => {
      const [customer] = await tx
        .insert(billingCustomers)
        .values(input)
        // Not an error, so it can't abort the transaction.
        .onConflictDoNothing()
        .returning();
      return customer
        ? {
            result: { ok: true, customer } as const,
            entry: customerCreatedEntry(customer),
          }
        : {
            result: { ok: false, error: "external_id_taken" } as const,
            entry: null,
          };
    },
  );
}

export async function findBillingCustomer(
  db: Pick<Database, "select">,
  scope: InOrganization,
  externalId: string,
): Promise<BillingCustomer | undefined> {
  const [customer] = await db
    .select()
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.organizationId, scope.organizationId),
        eq(billingCustomers.externalId, externalId),
      ),
    );
  return customer;
}

export interface CustomerBalance {
  customer: BillingCustomer;
  /** What the customer owes; negative when they're owed. */
  balanceMicros: bigint;
  entries: number;
}

/** Customers with their ledger balances, by customer ID. */
export async function listBillingCustomers(
  db: Pick<Database, "select">,
  scope: OrganizationScope,
): Promise<CustomerBalance[]> {
  const rows = await db
    .select({
      customer: billingCustomers,
      balance: sql<string>`coalesce(sum(${billingLedgerEntries.amountUsd}), 0)::text`,
      entries: count(billingLedgerEntries.id),
    })
    .from(billingCustomers)
    .leftJoin(
      billingLedgerEntries,
      eq(billingLedgerEntries.customerId, billingCustomers.id),
    )
    .where(
      "organizationId" in scope
        ? eq(billingCustomers.organizationId, scope.organizationId)
        : undefined,
    )
    .groupBy(billingCustomers.id)
    .orderBy(asc(billingCustomers.externalId), asc(billingCustomers.id));
  return rows.map((row) => ({
    customer: row.customer,
    balanceMicros: parseSignedDecimal(row.balance),
    entries: row.entries,
  }));
}

/** A customer's entries, newest first. */
export function listLedgerEntries(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id" | "organizationId">,
  limit = 100,
): Promise<BillingLedgerEntry[]> {
  return db
    .select()
    .from(billingLedgerEntries)
    .where(
      and(
        eq(billingLedgerEntries.organizationId, customer.organizationId),
        eq(billingLedgerEntries.customerId, customer.id),
      ),
    )
    .orderBy(
      desc(billingLedgerEntries.createdAt),
      desc(billingLedgerEntries.id),
    )
    .limit(limit);
}

export type AdjustmentResult =
  | { ok: true; entry: BillingLedgerEntry; replayed: boolean }
  | { ok: false; error: "entry_key_conflict" };

/**
 * Adds an adjustment: a charge (positive) or a credit (negative). With an
 * entry key, a retry returns the stored entry instead of adding another;
 * the same key for a different customer, amount or reason is a conflict.
 */
export function addAdjustment(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  customer: BillingCustomer,
  input: { amountMicros: bigint; description: string; entryKey?: string },
): Promise<AdjustmentResult> {
  const amountUsd = microsToDecimal(input.amountMicros);
  return audited(db, actor, async (tx): Promise<Change<AdjustmentResult>> => {
    const [entry] = await tx
      .insert(billingLedgerEntries)
      .values({
        organizationId: customer.organizationId,
        customerId: customer.id,
        kind: "adjustment",
        amountUsd,
        description: input.description,
        entryKey: input.entryKey ?? null,
        createdBy: actor.label,
      })
      .onConflictDoNothing()
      .returning();
    if (entry) {
      return {
        result: { ok: true, entry, replayed: false } as const,
        entry: ledgerEntryAudit({
          ...entry,
          customerExternalId: customer.externalId,
        }),
      };
    }
    // Only an entry key can conflict on an adjustment.
    const [stored] = await tx
      .select()
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.organizationId, customer.organizationId),
          eq(billingLedgerEntries.entryKey, input.entryKey ?? ""),
        ),
      );
    const same =
      stored !== undefined &&
      stored.kind === "adjustment" &&
      stored.customerId === customer.id &&
      parseSignedDecimal(stored.amountUsd) === input.amountMicros &&
      stored.description === input.description;
    return {
      result: same
        ? ({ ok: true, entry: stored, replayed: true } as const)
        : ({ ok: false, error: "entry_key_conflict" } as const),
      entry: null,
    };
  });
}

export type ReversalResult =
  | { ok: true; entry: BillingLedgerEntry }
  | { ok: false; error: "not_found" | "is_reversal" | "already_reversed" };

/**
 * Cancels an entry with a new one for the opposite amount; the original
 * stays. An entry can be reversed once, and a reversal can't be.
 */
export function reverseLedgerEntry(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  scope: InOrganization,
  input: { entryId: string; description: string },
): Promise<ReversalResult> {
  return audited(db, actor, async (tx): Promise<Change<ReversalResult>> => {
    if (!isUuid(input.entryId)) {
      return {
        result: { ok: false, error: "not_found" } as const,
        entry: null,
      };
    }
    const [original] = await tx
      .select({
        entry: billingLedgerEntries,
        externalId: billingCustomers.externalId,
      })
      .from(billingLedgerEntries)
      .innerJoin(
        billingCustomers,
        eq(billingCustomers.id, billingLedgerEntries.customerId),
      )
      .where(
        and(
          eq(billingLedgerEntries.id, input.entryId),
          eq(billingLedgerEntries.organizationId, scope.organizationId),
        ),
      );
    if (!original) {
      return {
        result: { ok: false, error: "not_found" } as const,
        entry: null,
      };
    }
    if (original.entry.kind === "reversal") {
      return {
        result: { ok: false, error: "is_reversal" } as const,
        entry: null,
      };
    }
    const [entry] = await tx
      .insert(billingLedgerEntries)
      .values({
        organizationId: scope.organizationId,
        customerId: original.entry.customerId,
        kind: "reversal",
        amountUsd: microsToDecimal(
          -parseSignedDecimal(original.entry.amountUsd),
        ),
        description: input.description,
        reversesEntryId: original.entry.id,
        createdBy: actor.label,
      })
      // An entry is reversed once; a concurrent reversal wins or loses here.
      .onConflictDoNothing()
      .returning();
    if (!entry) {
      return {
        result: { ok: false, error: "already_reversed" } as const,
        entry: null,
      };
    }
    return {
      result: { ok: true, entry } as const,
      entry: ledgerEntryAudit({
        ...entry,
        customerExternalId: original.externalId,
      }),
    };
  });
}

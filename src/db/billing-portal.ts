import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { monthStart, parseSignedDecimal } from "@/lib/billing";
import { isUuid } from "@/lib/ids";
import {
  generateLinkToken,
  hashLinkToken,
  isWellFormedLinkToken,
} from "@/lib/links";
import { PORTAL_LINK_TTL_MS } from "@/lib/portal";
import { listCreditGrants, usableCredit } from "./billing-credits";
import { planForMonth } from "./billing-plans";
import {
  billingCustomers,
  billingLedgerEntries,
  billingPortalLinks,
  organizations,
  type BillingCustomer,
  type BillingEntryKind,
  type BillingPortalLink,
} from "./schema";

/** Any Drizzle Postgres database or transaction. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

/** A link as the admin page lists it: never its token's hash. */
export type PortalLinkSummary = Omit<BillingPortalLink, "tokenHash"> & {
  customer: Pick<BillingCustomer, "externalId" | "name">;
};

const linkColumns = {
  id: billingPortalLinks.id,
  organizationId: billingPortalLinks.organizationId,
  customerId: billingPortalLinks.customerId,
  createdBy: billingPortalLinks.createdBy,
  createdAt: billingPortalLinks.createdAt,
  expiresAt: billingPortalLinks.expiresAt,
  revokedAt: billingPortalLinks.revokedAt,
  lastViewedAt: billingPortalLinks.lastViewedAt,
};

const usable = (now: Date) =>
  and(
    isNull(billingPortalLinks.revokedAt),
    gt(billingPortalLinks.expiresAt, now),
  );

/** A billing customer of the organization, by its id. */
export async function findCustomerById(
  db: Pick<Database, "select">,
  organizationId: string,
  customerId: string,
): Promise<BillingCustomer | undefined> {
  if (!isUuid(customerId)) return undefined;
  const [customer] = await db
    .select()
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.id, customerId),
        eq(billingCustomers.organizationId, organizationId),
      ),
    );
  return customer;
}

/**
 * Makes a portal link for a customer. Returns the token, the only copy;
 * just its hash is stored.
 */
export async function createPortalLink(
  db: Pick<Database, "insert">,
  {
    customer,
    createdBy,
  }: {
    customer: Pick<
      BillingCustomer,
      "id" | "organizationId" | "externalId" | "name"
    >;
    createdBy: string;
  },
  now: Date = new Date(),
): Promise<{ token: string; link: PortalLinkSummary }> {
  const { token, hash } = generateLinkToken();
  const [link] = await db
    .insert(billingPortalLinks)
    .values({
      organizationId: customer.organizationId,
      customerId: customer.id,
      tokenHash: hash,
      createdBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + PORTAL_LINK_TTL_MS),
    })
    .returning(linkColumns);
  return {
    token,
    link: {
      ...link,
      customer: { externalId: customer.externalId, name: customer.name },
    },
  };
}

/** The organization's links that still work, newest first. */
export async function listPortalLinks(
  db: Pick<Database, "select">,
  organizationId: string,
  now: Date = new Date(),
): Promise<PortalLinkSummary[]> {
  const rows = await db
    .select({
      link: linkColumns,
      externalId: billingCustomers.externalId,
      name: billingCustomers.name,
    })
    .from(billingPortalLinks)
    .innerJoin(
      billingCustomers,
      eq(billingCustomers.id, billingPortalLinks.customerId),
    )
    .where(
      and(eq(billingPortalLinks.organizationId, organizationId), usable(now)),
    )
    .orderBy(desc(billingPortalLinks.createdAt), asc(billingPortalLinks.id));
  return rows.map(({ link, externalId, name }) => ({
    ...link,
    customer: { externalId, name },
  }));
}

/** Revokes a working link of the organization; null if none matched. */
export async function revokePortalLink(
  db: Pick<Database, "select" | "update">,
  { organizationId, linkId }: { organizationId: string; linkId: string },
  now: Date = new Date(),
): Promise<PortalLinkSummary | null> {
  if (!isUuid(linkId)) return null;
  const [revoked] = await db
    .update(billingPortalLinks)
    .set({ revokedAt: now })
    .where(
      and(
        eq(billingPortalLinks.id, linkId),
        eq(billingPortalLinks.organizationId, organizationId),
        isNull(billingPortalLinks.revokedAt),
      ),
    )
    .returning(linkColumns);
  if (!revoked) return null;
  const [customer] = await db
    .select({
      externalId: billingCustomers.externalId,
      name: billingCustomers.name,
    })
    .from(billingCustomers)
    .where(eq(billingCustomers.id, revoked.customerId));
  return { ...revoked, customer };
}

export interface OpenedPortal {
  customer: BillingCustomer;
  organizationName: string;
}

/**
 * The customer a working link opens, recording when it was viewed; null
 * for a link that's malformed, unknown, expired or revoked.
 */
export async function openPortal(
  db: Pick<Database, "select" | "update">,
  token: string,
  now: Date = new Date(),
): Promise<OpenedPortal | null> {
  if (!isWellFormedLinkToken(token)) return null;
  const [opened] = await db
    .update(billingPortalLinks)
    .set({ lastViewedAt: now })
    .where(
      and(eq(billingPortalLinks.tokenHash, hashLinkToken(token)), usable(now)),
    )
    .returning({
      customerId: billingPortalLinks.customerId,
      organizationId: billingPortalLinks.organizationId,
    });
  if (!opened) return null;
  const [row] = await db
    .select({
      customer: billingCustomers,
      organizationName: organizations.name,
    })
    .from(billingCustomers)
    .innerJoin(
      organizations,
      eq(organizations.id, billingCustomers.organizationId),
    )
    .where(
      and(
        eq(billingCustomers.id, opened.customerId),
        eq(billingCustomers.organizationId, opened.organizationId),
      ),
    );
  return row ?? null;
}

/** A statement line: what the customer sees, never who entered it. */
export interface StatementEntry {
  id: string;
  createdAt: Date;
  kind: BillingEntryKind;
  description: string;
  amountMicros: bigint;
}

export interface Statement {
  /** What the customer owes; negative when they're owed. */
  balanceMicros: bigint;
  /** The newest entries, newest first. */
  entries: StatementEntry[];
  /** Whether there are older entries than those listed. */
  more: boolean;
  /** This month's plan: its name and fee only. */
  plan: { name: string; monthlyFeeMicros: bigint } | null;
  credit: {
    usableMicros: bigint;
    grants: Array<{ remainingMicros: bigint; expiresAt: Date | null }>;
  };
}

/**
 * One customer's statement. Only what they're billed: no AI API cost, no
 * usage multiplier, no included-usage allowance, and no staff names.
 */
export async function getStatement(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id" | "organizationId">,
  now: Date = new Date(),
  limit = 100,
): Promise<Statement> {
  const ofCustomer = and(
    eq(billingLedgerEntries.organizationId, customer.organizationId),
    eq(billingLedgerEntries.customerId, customer.id),
  );
  const [[total], rows, plan, grants] = await Promise.all([
    db
      .select({
        balance: sql<string>`coalesce(sum(${billingLedgerEntries.amountUsd}), 0)::text`,
      })
      .from(billingLedgerEntries)
      .where(ofCustomer),
    db
      .select({
        id: billingLedgerEntries.id,
        createdAt: billingLedgerEntries.createdAt,
        kind: billingLedgerEntries.kind,
        description: billingLedgerEntries.description,
        amountUsd: billingLedgerEntries.amountUsd,
      })
      .from(billingLedgerEntries)
      .where(ofCustomer)
      .orderBy(
        desc(billingLedgerEntries.createdAt),
        desc(billingLedgerEntries.id),
      )
      .limit(limit + 1),
    planForMonth(db, customer, monthStart(now)),
    listCreditGrants(db, customer, now),
  ]);
  const live = grants.filter((g) => !g.expired && g.remainingMicros > 0n);
  return {
    balanceMicros: parseSignedDecimal(total?.balance ?? "0"),
    entries: rows.slice(0, limit).map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      kind: row.kind,
      description: row.description,
      amountMicros: parseSignedDecimal(row.amountUsd),
    })),
    more: rows.length > limit,
    plan: plan
      ? {
          name: plan.plan.name,
          monthlyFeeMicros: parseSignedDecimal(plan.plan.monthlyFeeUsd),
        }
      : null,
    credit: {
      usableMicros: usableCredit(grants),
      grants: live.map((g) => ({
        remainingMicros: g.remainingMicros,
        expiresAt: g.grant.expiresAt,
      })),
    },
  };
}

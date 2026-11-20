"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { audited, userActor } from "@/db/audit";
import {
  createPortalLink,
  findCustomerById,
  revokePortalLink,
} from "@/db/billing-portal";
import { portalLinkCreatedEntry, portalLinkRevokedEntry } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { portalUrl } from "@/lib/portal";

export interface PortalLinkFormState {
  error?: string;
  /** The new link: shown once, in the response to the form. */
  created?: { customer: string; url: string; expiresAt: string };
}

// Server actions can be called from any route, so each one checks the
// session and role itself, and finds the customer in the admin's own
// organization, never one the form names elsewhere.

export async function createPortalLinkAction(
  _previous: PortalLinkFormState | undefined,
  formData: FormData,
): Promise<PortalLinkFormState> {
  const user = await requirePermission("portal:manage");
  const customerId = formData.get("customerId");
  const result = await audited(db, userActor(user), async (tx) => {
    const customer =
      typeof customerId === "string"
        ? await findCustomerById(tx, user.organizationId, customerId)
        : undefined;
    if (!customer) return { result: null, entry: null };
    const created = await createPortalLink(tx, {
      customer,
      createdBy: user.email,
    });
    return { result: created, entry: portalLinkCreatedEntry(created.link) };
  });
  if (!result) return { error: "Choose one of your billing customers" };

  revalidatePath("/revenue/portal");
  const request = await headers();
  return {
    created: {
      customer: `${result.link.customer.name} (${result.link.customer.externalId})`,
      url: portalUrl(result.token, {
        host: request.get("x-forwarded-host") ?? request.get("host"),
        proto: request.get("x-forwarded-proto"),
      }),
      expiresAt: result.link.expiresAt.toISOString(),
    },
  };
}

export async function revokePortalLinkAction(linkId: string): Promise<void> {
  const user = await requirePermission("portal:manage");
  const revoked = await audited(db, userActor(user), async (tx) => {
    const done = await revokePortalLink(tx, {
      organizationId: user.organizationId,
      linkId,
    });
    return { result: done, entry: done ? portalLinkRevokedEntry(done) : null };
  });
  revalidatePath("/revenue/portal");
  redirect(`/revenue/portal?status=${revoked ? "revoked" : "not_found"}`);
}

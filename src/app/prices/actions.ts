"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { audited, userActor } from "@/db/audit";
import { addModelPrice, endModelPrice } from "@/db/pricing";
import { priceAddedEntry, priceEndedEntry } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import type { EndPriceFormState } from "@/lib/price-end-form";
import type { PriceFormState } from "@/lib/price-form";
import { submitPriceForm } from "./submit";
import { submitEndPriceForm } from "./submit-end";

// Server actions can be called from any route, so each checks the session
// and role itself rather than relying on the page that renders its form.
export async function addPriceAction(
  _previous: PriceFormState | undefined,
  formData: FormData,
): Promise<PriceFormState> {
  const user = await requirePermission("prices:manage");
  const result = await submitPriceForm(formData, (input) =>
    audited(db, userActor(user), async (tx) => {
      const added = await addModelPrice(tx, input, user.id);
      return {
        result: added,
        entry: added.ok ? priceAddedEntry(added.price) : null,
      };
    }),
  );
  if (!result.ok) return result.state;

  revalidatePath("/prices");
  redirect("/prices");
}

export async function endPriceAction(
  id: string,
  _previous: EndPriceFormState | undefined,
  formData: FormData,
): Promise<EndPriceFormState> {
  const user = await requirePermission("prices:manage");
  const result = await submitEndPriceForm(formData, (input) =>
    audited(db, userActor(user), async (tx) => {
      const ended = await endModelPrice(tx, id, input, user.id);
      return {
        result: ended,
        entry: ended.ok ? priceEndedEntry(ended.price) : null,
      };
    }),
  );
  if (!result.ok) return result.state;

  revalidatePath("/prices");
  redirect("/prices");
}

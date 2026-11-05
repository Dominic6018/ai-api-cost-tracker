"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { addModelPrice } from "@/db/pricing";
import { requireUser } from "@/lib/auth";
import type { PriceFormState } from "@/lib/price-form";
import { submitPriceForm } from "./submit";

// Server actions can be called from any route, so this checks the session
// itself rather than relying on the page that renders the form.
export async function addPriceAction(
  _previous: PriceFormState | undefined,
  formData: FormData,
): Promise<PriceFormState> {
  const user = await requireUser();
  const result = await submitPriceForm(formData, (input) =>
    addModelPrice(db, input, user.id),
  );
  if (!result.ok) return result.state;

  revalidatePath("/prices");
  redirect("/prices");
}

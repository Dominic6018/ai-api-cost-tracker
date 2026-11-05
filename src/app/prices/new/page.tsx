import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { addPriceAction } from "../actions";
import { PriceForm } from "../price-form";

export const metadata: Metadata = {
  title: "Add a price · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

export default async function NewPricePage() {
  await requireUser("/prices/new");

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-12 sm:px-8">
      <div className="flex flex-col gap-1">
        <Link href="/prices" className="text-sm text-foreground/60 underline">
          Prices
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Add a price</h1>
      </div>
      <p className="max-w-2xl text-sm text-foreground/70">
        Rates are USD per million tokens, copied exactly from the
        provider&apos;s pricing page. A new price ends the model&apos;s earlier
        price where it starts. Usage already recorded keeps its cost; the price
        applies to usage recorded from now on.
      </p>
      <PriceForm action={addPriceAction} />
    </main>
  );
}

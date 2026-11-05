import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { getModelPrice } from "@/db/pricing";
import { requireUser } from "@/lib/auth";
import { formatRate } from "@/lib/prices";
import { endPriceAction } from "../../actions";
import { EndPriceForm } from "../../end-price-form";

export const metadata: Metadata = {
  title: "End a price · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

const utcDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export default async function EndPricePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireUser(`/prices/${id}/end`);
  const price = await getModelPrice(db, id);
  if (!price) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-12 sm:px-8">
      <div className="flex flex-col gap-1">
        <Link href="/prices" className="text-sm text-foreground/60 underline">
          Prices
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">
          End the price for <span className="font-mono">{price.model}</span>
        </h1>
      </div>
      <p className="max-w-2xl text-sm text-foreground/70">
        {price.provider}: {formatRate(price.inputPerMTokUsd)} input,{" "}
        {formatRate(price.outputPerMTokUsd)} output per million tokens, from{" "}
        {utcDateTime.format(price.effectiveFrom)} UTC
        {price.effectiveTo
          ? ` until ${utcDateTime.format(price.effectiveTo)} UTC`
          : ", with no end"}
        . Use this when a provider retires the model; to change its rates, add a
        new price instead. After the end, usage for the model has no price and
        is refused, as for an unknown model. Recorded usage keeps its cost.
      </p>
      <EndPriceForm action={endPriceAction.bind(null, price.id)} />
    </main>
  );
}

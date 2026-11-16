# Billing ledger

The tracker records two kinds of money, and keeps them apart:

- **Provider cost**: what OpenAI, Anthropic, Google and others charge you, computed from usage at their prices. It's in `usage_events`, and everything else in the README is about it.
- **Billing**: what you bill your customers. It's in the billing ledger, described here.

Nothing moves between them on its own. A charge to a customer is never derived from a provider price unless you post it, so a price change can't alter what a customer was billed.

## What's there now

- **Customers** per organization, keyed by the `customerId` their usage and outcomes are attributed to, with a name.
- **Ledger entries** for a customer: an **adjustment** (a charge, positive, or a credit, negative), a **reversal**, which cancels one earlier entry, a month's **plan fee** and **usage charge**, or **credit applied** from prepaid credit.
- **Balances**: the sum of a customer's entries. Positive means the customer owes you; negative means you owe them.
- **Plans** and which customer is on which plan in each month, and **monthly charges** posted from them (below).

- **Prepaid credit** that pays what's owed until it runs out or expires (below).

There's no invoicing or payment collection: the ledger says what each customer owes, and you bill them from it.

## Plans

A plan has three terms, and an optional [usage limit](#usage-limits), set when it's created:

| Term                 | Meaning                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Monthly fee          | What the customer pays each month on the plan                                                                |
| Included usage (USD) | Usage charges up to this each month are covered by the fee                                                   |
| Usage multiplier     | Usage is charged at its AI API cost times this: `1.25` is cost plus 25%, `1` at cost, `0` not charged at all |

For example, a plan with a $49 fee, $20 included and a multiplier of 1.25, for a customer whose usage cost $30 in a month: usage charges are $30 × 1.25 = $37.50, of which $20 is included, so the month comes to $49 + $17.50 = $66.50.

- **Plans don't change.** To change a price, add a new plan and move customers to it, so each month is always billed on the terms it had. Fees and allowances have up to six decimals and the multiplier up to four, stored exactly.
- **By calendar month (UTC).** A customer is on at most one plan in a month. Subscribing from a month replaces whatever was scheduled from that month on; unsubscribing ends the plan before that month. The month can be the current one or later, never earlier, so months that may have been billed never change.
- **One change at a time.** Changes for a customer are serialized, so periods never overlap, even when two are made at once.
- **Separate organizations.** A plan belongs to one organization, and the database refuses a subscription whose customer or plan is in another.
- Plans, subscriptions and unsubscriptions are in the audit log. A change that changes nothing is refused rather than logged.

### Usage limits

A plan can also say how much a customer may use: `--usage-limit 50` caps the AI API cost of their usage at $50 a UTC month. It's an entitlement, enforced before spending rather than billed:

- [Budget checks and reservations](../README.md#budget-check-before-spending) that name a `customerId` check it, from any project in the organization, and deny with `customer_limit` when the estimate doesn't fit. The answer's `customer` block shows the plan, the limit, the spend and the holds.
- Spend is the customer's recorded cost this month across the organization's projects; holds are unexpired reservations made for the customer in any of them. Reservations for one customer are decided in turn, so steps in different projects can't overspend it together.
- A customer that isn't a billing customer, isn't on a plan this month, or is on a plan without a limit is never denied by it. The limit is on AI API cost, not on the usage charge, so it doesn't depend on the multiplier.
- Like a budget, it only holds for calls that check first. The TypeScript and Python clients send a scoped tracker's customer automatically.

## Monthly charges

`npm run billing -- charge` posts a finished month's charges for each customer on a plan that month:

- a **plan fee**: the plan's monthly fee, and
- a **usage charge**: the AI API cost of the customer's usage that month × the plan's multiplier, less the included usage. The cost is the recorded cost of every request attributed to the customer's ID (`customerId`) in any of the organization's projects, from the first to the last moment of the UTC month.

The usage charge is rounded half up to the micro-dollar once; nothing else is rounded. A charge of zero (a free plan, or usage within the allowance) isn't posted. Each entry records the month, the plan, and for usage the AI API cost it was based on, so the bill can be explained later.

- **Finished months only.** The current month and later ones are refused.
- **Never on a short cost.** If any of the customer's usage that month has no price yet, the customer isn't charged: add the price and run `npm run reprice`, then charge again. The command exits non-zero when this happens, so a scheduled run is noticed.
- **Once per month.** Once a month has a fee or usage entry for a customer, charging it again returns those entries and posts nothing, and the database refuses a second fee or usage charge for the same month, even from two runs at once. Usage recorded for a month after it was charged isn't charged automatically: add an adjustment. To redo a month, reverse its entries and post the corrections as adjustments.
- Each customer is charged in its own transaction, with a `billing.charged` audit entry giving the amounts and the cost they came from.

## Prepaid credit

Credit is money a customer has paid in advance, or that you give them. It's kept apart from the ledger until it's used:

- **Grant** credit with an amount, a reason and, optionally, the last day it can be used (`--expires 2027-01-31`, usable until the end of that UTC day). With `--key`, granting again returns the stored grant, and the key for a different grant is refused. A grant doesn't change the balance.
- **Apply** credit to what the customer owes: one **credit applied** ledger entry for the amount used, never more than the balance or than the credit left. Credit that expires soonest is used first, then the oldest. `charge` applies credit after posting each customer's month; `apply-credits` does it any time. With nothing owed, nothing is applied, so running it again changes nothing.
- **Expire**: unused credit can't be used after its expiry. It isn't removed, and `credits` shows it as expired.
- **Refund** what's left of a grant, for example when prepaid credit is paid back: the rest of the grant is withdrawn, once. Credit already applied stays applied, and expired credit can't be refunded.

The database refuses to use more of a grant than is left, to use expired credit, or to use another customer's credit, even from two runs at once. Grants and their uses are append-only, like the ledger, and applied credit can't be reversed: grant new credit instead. Every grant, application and refund is in the audit log.

## Guarantees

- **Exact amounts.** Entries are stored as decimals with six places (micro-dollars), summed exactly, and shown unrounded. An amount with more than six decimals is refused, not rounded. The largest entry is $99,999,999.999999, and zero isn't an entry.
- **Append-only.** The database refuses to update, delete or truncate ledger entries, whoever asks. To correct an entry, reverse it and add the right one; both stay in the history. An entry can be reversed once, a reversal can't be reversed, and of two reversals at the same moment only one is stored. A customer with entries can't be deleted.
- **Safe retries.** An adjustment with an entry key (`--key`, unique per organization, such as your invoice line ID) is stored once: repeating it returns the stored entry, and using the key for a different customer, amount or reason is refused.
- **Separate organizations.** Customers, entries and balances belong to one organization, and the database refuses an entry whose customer is in another. Customer IDs can repeat across organizations.
- **Audited.** Adding a customer, an adjustment, a reversal, plan changes, monthly charges and credit each write an [audit log](../README.md#dashboard) entry in the same transaction, naming who did it. Entries also keep their author. Replays and refused requests change nothing and aren't logged.

## Command line

```bash
npm run billing -- customer-add --customer cus_42 --name "Acme Inc."
npm run billing -- adjust --customer cus_42 --amount 250 --reason "Onboarding, November" --key inv-1042-1
npm run billing -- adjust --customer cus_42 --amount=-25 --reason "Goodwill credit"
npm run billing -- reverse --entry <entry id> --reason "Charged twice"
npm run billing -- ledger --customer cus_42      # balance and the latest 100 entries
npm run billing -- customers                     # every customer's balance and plan this month

npm run billing -- plan-add --plan pro --name "Pro" --fee 49 --included 20 --multiplier 1.25 --usage-limit 100
npm run billing -- plans                         # terms, and customers on each this month
npm run billing -- subscribe --customer cus_42 --plan pro --from 2026-12
npm run billing -- unsubscribe --customer cus_42 --from 2027-06
```

```bash
npm run billing -- charge                        # last month, every customer on a plan
npm run billing -- charge --month 2026-10 --customer cus_42

npm run billing -- grant-credit --customer cus_42 --amount 100 --reason "Prepaid, invoice 1042" --expires 2027-12-31 --key inv-1042
npm run billing -- credits --customer cus_42     # each grant: used, left, expiry
npm run billing -- apply-credits                 # every customer who owes something
npm run billing -- refund-credit --grant <grant id> --reason "Refunded by bank transfer"
```

`--from` defaults to the current UTC month and `--month` to last month. `ledger` also lists the customer's plan history. Run `charge` early each month, for example from cron, after any late usage has arrived.

Each command takes `--org <slug>` and uses the default organization without it. Write a negative amount as `--amount=-25`: a value starting with `-` needs the `=`. With Docker, run them as `docker compose run --rm migrate npm run --silent billing -- ...`.

| Message                                         | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `Already recorded ...`                          | The entry key was used for this same adjustment; nothing new was stored |
| `Entry key "..." was already used ...`          | The key belongs to a different adjustment; nothing was stored           |
| `That entry has already been reversed.`         | Each entry can be reversed once                                         |
| `No billing customer "..."`                     | Add the customer first with `customer-add`, in the right `--org`        |
| `Not a USD amount with up to 6 decimals: "..."` | Use digits with up to six decimals, without `$` or thousands separators |
| `Plans change from the current month ...`       | `--from` is before this UTC month; billed months can't change           |
| `... is already on <plan> from <month>.`        | Nothing to change; the customer is already on that plan then            |
| `not charged: N request(s) have no price yet`   | Add the missing price, run `npm run reprice`, then charge again         |
| `already charged`                               | The month was charged before; nothing new was posted                    |
| `Applied credit can't be reversed ...`          | Grant new credit to correct applied credit                              |
| `That credit has all been used or refunded.`    | Nothing is left of the grant to refund                                  |
| `... hasn't finished`                           | Only months that are over can be charged                                |

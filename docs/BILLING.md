# Billing ledger

The tracker records two kinds of money, and keeps them apart:

- **Provider cost**: what OpenAI, Anthropic, Google and others charge you, computed from usage at their prices. It's in `usage_events`, and everything else in the README is about it.
- **Billing**: what you bill your customers. It's in the billing ledger, described here.

Nothing moves between them on its own. A charge to a customer is never derived from a provider price unless you post it, so a price change can't alter what a customer was billed.

## What's there now

- **Customers** per organization, keyed by the `customerId` their usage and outcomes are attributed to, with a name.
- **Ledger entries** for a customer: an **adjustment** (a charge, positive, or a credit, negative) or a **reversal**, which cancels one earlier entry.
- **Balances**: the sum of a customer's entries. Positive means the customer owes you; negative means you owe them.

Plans, included allowances and charges for metered usage are next on the [roadmap](ROADMAP.md); they'll post to this ledger. There's no invoicing or payment collection.

## Guarantees

- **Exact amounts.** Entries are stored as decimals with six places (micro-dollars), summed exactly, and shown unrounded. An amount with more than six decimals is refused, not rounded. The largest entry is $99,999,999.999999, and zero isn't an entry.
- **Append-only.** The database refuses to update, delete or truncate ledger entries, whoever asks. To correct an entry, reverse it and add the right one; both stay in the history. An entry can be reversed once, a reversal can't be reversed, and of two reversals at the same moment only one is stored. A customer with entries can't be deleted.
- **Safe retries.** An adjustment with an entry key (`--key`, unique per organization, such as your invoice line ID) is stored once: repeating it returns the stored entry, and using the key for a different customer, amount or reason is refused.
- **Separate organizations.** Customers, entries and balances belong to one organization, and the database refuses an entry whose customer is in another. Customer IDs can repeat across organizations.
- **Audited.** Adding a customer, an adjustment and a reversal each write an [audit log](../README.md#dashboard) entry in the same transaction, naming who did it. Entries also keep their author. Replays and refused requests change nothing and aren't logged.

## Command line

```bash
npm run billing -- customer-add --customer cus_42 --name "Acme Inc."
npm run billing -- adjust --customer cus_42 --amount 250 --reason "Onboarding, November" --key inv-1042-1
npm run billing -- adjust --customer cus_42 --amount=-25 --reason "Goodwill credit"
npm run billing -- reverse --entry <entry id> --reason "Charged twice"
npm run billing -- ledger --customer cus_42      # balance and the latest 100 entries
npm run billing -- customers                     # every customer's balance
```

Each command takes `--org <slug>` and uses the default organization without it. Write a negative amount as `--amount=-25`: a value starting with `-` needs the `=`. With Docker, run them as `docker compose run --rm migrate npm run --silent billing -- ...`.

| Message                                         | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `Already recorded ...`                          | The entry key was used for this same adjustment; nothing new was stored |
| `Entry key "..." was already used ...`          | The key belongs to a different adjustment; nothing was stored           |
| `That entry has already been reversed.`         | Each entry can be reversed once                                         |
| `No billing customer "..."`                     | Add the customer first with `customer-add`, in the right `--org`        |
| `Not a USD amount with up to 6 decimals: "..."` | Use digits with up to six decimals, without `$` or thousands separators |

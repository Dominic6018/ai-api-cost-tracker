# Demo scenarios

Runnable stories that show what the tracker is for. Each needs only a tracker with the seed prices (`npm run db:seed`), and the sample apps an API key from the [quickstart](QUICKSTART.md#2-create-api-keys). No provider keys and no spend: provider calls are stand-ins shaped like the real SDKs' responses, so every run stores the same, checkable costs. CI runs each one and checks its output.

| Scenario                                                      | What it shows                                                                                                                                                                                                 | Run                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [A support SaaS](../examples/support-agent/README.md)         | Cost per customer and per resolved ticket across OpenAI, Anthropic and Gemini, including streamed responses, background reporting, budget holds and a failed provider call                                    | `node examples/support-agent/app.mjs`     |
| [Multi-model agents](../examples/multi-model-agent/README.md) | An agent run split across Opus, gpt-5.4-mini and Haiku. A hold before every step keeps it under the project's run budget, and it falls back to a cheaper model rather than going over                         | `node examples/multi-model-agent/app.mjs` |
| [Usage-based billing](BILLING.md#the-billing-demo)            | Billing customers for their AI usage. Plans with a fee, included usage and a markup, a month's charges, prepaid credit, revenue against AI API cost and a customer portal link, in an organization of its own | `npm run db:demo-billing`                 |

The billing demo runs against the database with the same functions as `npm run billing`, so it needs `DATABASE_URL` rather than an API key.

For a dashboard full of history instead, `npm run db:demo` loads four demo projects with 90 days of usage. See the [README](../README.md).

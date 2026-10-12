# PingMarket × Sparta Worlds

We use [Sparta Worlds](https://www.usesparta.co) (`sparta_worlds@0.9.0-beta.3`) to test PingMarket's SMS checkout agent. Worlds runs a local, stateful twin of Stripe, so the agent never touches real Stripe while we test it. A buyer texts something like *"desk under $150 in Berkeley"*. The agent reads the catalog, chooses listings with the same parser that production search uses ([src/lib/search/query.ts](../src/lib/search/query.ts)), and saves an **unpaid draft invoice**. The buyer pays later through PingMarket's real Stripe Checkout link.

This project is built from Sparta's **Digital Shop** starter. It replaces the starter's seed, missions and checks with PingMarket's own.

| File | What it holds |
| --- | --- |
| `project.json` | Worlds project manifest (template `digital-shop`, agent command) |
| `seed.json` | Stripe twin seeded with PingMarket demo listings D1–D8. It also holds one inactive price and one recurring price, so the agent can be caught choosing the wrong one. |
| `missions.json` | Three buyer SMS prompts: a single item, two items in one text, and a budget that is too low |
| `checks.json` | Declarative outcome checks: exactly one draft, the expected number of items, change scope, no payment attempts, no invented products or prices, no substitution when over budget |
| `agent.mts` | The checkout agent. It uses `parseBuyerQuery` from the main app and retries a bounded number of times with stable idempotency keys. |
| `evidence/submission.json` | Sanitized before/after evidence from the run below |

## Run it (Node 24+)

```sh
npm run sparta:open      # browser dashboard: choose a mission, run it, grade the result
npm run sparta:run       # all missions, one fresh world each
npm run sparta:evidence  # 3 runs × 3 missions with the injected interruption; writes sanitized evidence
```

`sparta:evidence` will not overwrite an existing file, so delete `evidence/submission.json` before you run it again.

## Result

The run was 3 missions × 3 runs with `--scenario interruption`, and all **9 of 9 passed**. In every run, Worlds injected an HTTP 500 on `GET /v1/products`. The agent's bounded retry recovered from it, and it never wrote a duplicate invoice item. The over-budget mission wrote nothing and texted the buyer back instead of substituting the cheaper oak desk.

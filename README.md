# Make Good

When an AI agent buys the wrong thing for someone, or the order never arrives, somebody has to pay. Make Good decides whose mistake it was from the purchase records, then moves the money the matching way through PayPal, with the owner approving anything that moves money.

## What it does

Every agent purchase keeps a receipt bundle: what the buyer asked for, what the shop listed, what the agent bought, and what arrived. When a buyer complains, the incident page shows each step in order:

1. **AI proposes.** The AI reads the bundle, proposes who is at fault (the shop, the agent's operator, the buyer, or unclear) and quotes the record lines it relied on.
2. **An independent judge checks it.** A second AI pass, with a different prompt and by default a different model, rules on each quote (supports, background, or does not support) and lists records that point the other way. It never names an amount or a remedy.
3. **A fixed rule decides.** Plain code checks that every quote appears word for word in the record it cites, that the quotes come from the right kinds of record for the fault named, that the judge holds, and that no unaddressed contradiction was found. It sets the amount from a capped policy (the AI never sets money amounts), picks who must approve, and stops when the evidence is weak, the judge cannot be reached, or the text tries to steer the process.
4. **When it stops, it says what is missing.** The case becomes "Needs more records" and lists the specific records needed (for example a carrier scan, a listing snapshot or the agent's mandate). The owner can attach a record and run the check again.
5. **The owner approves, then money moves.** The approval token is bound to the exact action and amount.
   - **Shop at fault:** a refund offer inside PayPal's dispute flow, or a direct refund when no dispute is open.
   - **Operator at fault:** the shop keeps its sale and the operator reimburses the buyer by PayPal Payout.
   - **Claim not supported by the records:** the evidence is prepared and the owner decides what to send.

A liability ledger records who paid what for every case, next to an append-only audit log (database triggers refuse edits and deletes).

## PayPal APIs used

- **Customer Disputes v1:** dispute sync, reading the allowed offer types, making a refund offer, and evidence and messages to the buyer.
- **Payouts v1:** operator reimbursements. The `sender_batch_id` is saved before anything is sent, and a duplicate answer from PayPal is resolved by looking up the original batch, never by sending again with a new id.
- **Payments v2:** direct refunds on a capture.
- **Webhooks:** intake with signature verification.

Only the sandbox host is allowed by the code.

## Verified live in the PayPal sandbox

Full ids, timings and PayPal's own answers are in [`docs/LIVE_RUNS.md`](docs/LIVE_RUNS.md) and `docs/live/`.

- **Shop at fault through a dispute:** the buyer filed Item Not Received, the AI proposed shop fault, the owner approved, the app sent the refund offer, and PayPal resolved the dispute in the buyer's favour with $20.00 refunded. Run twice end to end.
- **Operator at fault, payout:** item SUCCESS confirmed by a separate GET to PayPal, including a $15.00 payout. Resending the same `sender_batch_id` was refused as a duplicate and the app found the original batch.
- **Shop at fault, direct refund:** refund COMPLETED, confirmed by a separate GET.

Sending evidence or a message to a dispute and webhook verification are covered by tests against mocked PayPal answers.

## The AI check

[`docs/EVAL_REPORT.md`](docs/EVAL_REPORT.md) scores 36 synthetic labelled cases over three passes, with a live proposer (`gemini-3.8-flash`) and a live judge (`gemini-3.1-pro-preview`). On the 108 saved proposals the rule never paid the wrong party (0 of 108), and no steering attempt got the attacker's outcome (0 of 18). The report lists every failure.

## Quick start (no keys needed)

```bash
npm install       # also installs the web console
npm run seed      # four example purchases that went wrong
npm run dev       # API on http://localhost:8787
npm run dev:web   # console on http://localhost:5173 (second terminal)
```

Needs Node 22.13 or newer. Sign in as `owner` / `owner-demo` (only the owner can approve) or `agent` / `agent-demo`. Without keys it runs on a built-in mock PayPal and recorded AI answers.

```bash
npm test          # offline test suite
npm run build     # web build and type check
```

## Configuration

Copy `.env.example` to `.env`, which git ignores.

| Variable | Purpose |
|---|---|
| `PAYPAL_MODE` | `mock` (default) or `sandbox` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials from [developer.paypal.com](https://developer.paypal.com) |
| `AI_PROVIDER` | `mock` (recorded answers) or a live provider such as `gemini` or `anthropic` |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Live AI keys |
| `JUDGE_PROVIDER`, `JUDGE_MODEL` | Pick the judge. A judge from another provider needs its own key, and the app refuses to start without it |
| `OWNER_PASSWORD`, `AGENT_PASSWORD` | Replace the demo logins before hosting anything |
| `PAYPAL_WEBHOOK_ID` | Enables webhook signature verification |

## Project layout

- `server/domain/` rules, judge, decision flow, ledger, payouts, disputes, intake
- `server/adapters/` PayPal (mock and sandbox) and AI providers
- `web/` the console
- `eval/` labelled cases, scoring and saved results
- `scripts/live/` runs against the PayPal sandbox; `scripts/sandbox/` sandbox buyer steps for preparing test disputes

## License

MIT. Copyright (c) 2026 Paul Bogosta. See [LICENSE](LICENSE).

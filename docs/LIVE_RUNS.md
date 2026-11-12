# Live sandbox runs through the app

PayPal sandbox only, play money. These runs use Make Good's own code (`scripts/live/run-live.ts`): intake, a live AI proposal, the fixed rule, the owner approval token, then PayPal. The purchase records are synthetic text written for the demo. Buyer emails are masked. Raw evidence files are in `docs/live/`. Times are 2026-10-19, WITA (UTC+8).

The AI in these runs was a live model (gemini-3.8-flash). Each proposal quoted the records word for word and passed the rule's check. The rule, not the AI, set the amount ($1.00 for these runs). The script plays the owner and presents the approval token the app produced for that exact proposal.

## What ran

| Path | Result | Ids |
|---|---|---|
| **Shop at fault through a dispute** (buyer files "item not received", app makes the refund offer) | Done end to end through the app. Dispute RESOLVED, outcome RESOLVED_BUYER_FAVOUR, reason SELLER_ISSUED_REFUND, $20.00 refunded. Capture now REFUNDED. The sandbox buyer's activity page shows "+US$20,00 Pengembalian Dana" and the payment marked refunded. | order `0JU206916W310915N`, capture `2C237508SJ982271A`, buyer-side transaction `79T98694E57985117`, dispute `PP-R-ABQ-10193441`, refund `34G20106YH882311N` (COMPLETED, $20.00). Evidence: `docs/live/live-dispute-2026-10-19T01-05-08-628Z.json`, `docs/live/dispute-PP-R-ABQ-10193441-paypal-view.json`, `docs/live/capture-2C237508SJ982271A-after.txt` |
| Operator at fault, payout (run 2, evidence kept) | Done. Payout item SUCCESS, confirmed by a separate GET to PayPal. | sender_batch_id `mg_batch_3e72af8c7b3043ea`, PayPal batch `TK2PWQL6Q4L2G`, item `BZ7Z82FN84S64`, transaction `2NT23049H2615305M` |
| Operator at fault, payout (run 3, evidence kept) | Done. Item SUCCESS, confirmed by a separate GET. Resending the same sender_batch_id was refused as a duplicate and the app found the original batch. | sender_batch_id `mg_batch_d096a66dec184767`, PayPal batch `8LWZUF4L6SK4Q`, item `NZP63XAPFGR8A`, transaction `4WJ5108604268402B` |
| Operator at fault, payout (run 1, evidence file not kept) | Done, item SUCCESS as the app saw it. This run's evidence file was not kept, so only the batch ids from the console output remain. | sender_batch_id `mg_batch_c392727d240141e6`, PayPal batch `ETNBGBGNCJDTG` |
| Shop at fault, direct refund (no dispute open) | Done. Refund COMPLETED, confirmed by a separate GET. Run on the capture from the earlier feasibility check, which had been partly refunded already. | capture `4LT98214BM800472B`, refund `7RK15023H11110310`, $1.00 |

In each payout run the `payouts` row with `sender_batch_id` existed, with status `prepared`, before the request went to PayPal (a test also checks this order in the code). For a payout the ledger got three lines (operator minus, buyer plus, shop's sale retained at zero). For a refund or a dispute refund it got two (shop minus, buyer plus). The operator line is a label, not a separate PayPal account.

## The dispute run in detail (2026-10-19, WITA)

Only the sandbox buyer's login steps ran in a browser. Everything on the shop side ran through the app's own code and PayPal's API. The buyer's password came from an environment variable and was never written anywhere.

| Time (WITA) | What happened |
|---|---|
| 08:53 | Buyer approved order `0JU206916W310915N` on PayPal's page. A GET confirmed APPROVED. The approve script's button text was in Indonesian ("Lanjutkan untuk Memeriksa Pesanan"), which the script's pattern also matches. |
| 08:55:12 | Shop captured the order. Capture `2C237508SJ982271A`, $20.00, COMPLETED. |
| before 08:59 | `scripts/sandbox/buyer-txn.mjs` read the buyer-side transaction id `79T98694E57985117` by clicking the newest outgoing $20 payment on the buyer's account summary page. |
| 08:59:50 to 09:00:44 | `scripts/sandbox/g1-dispute.mjs` filed "I haven't received the item or service" in the Resolution Center. Case `PP-R-ABQ-10193441`, created 09:00:45, MERCHANDISE_OR_SERVICE_NOT_RECEIVED, linked to capture `2C237508SJ982271A`. The filing script needed one new step for this screen version. |
| 09:01:45 | PayPal status UNDER_REVIEW. |
| 09:04:03 | PayPal-side refund `1CD554826H976060N` for $19.02 appeared with status FAILED. The app did not request it. The same thing showed up in the earlier feasibility check. Cause unknown. |
| 09:04:35 | WAITING_FOR_SELLER_RESPONSE, 3 min 50 s after filing. Actions open: make_offer, accept_claim, send_message, escalate, provide_evidence. accept_claim was not called. |
| 09:05:08 | App run started (`run-live.ts dispute`). Incident opened from the dispute and the synthetic purchase records. |
| 09:05:17 | Live AI (gemini-3.8-flash) proposed fault merchant, confidence 1, quotes verified. The rule chose merchant_refund for $20.00. 7 seconds. |
| 09:05:20 | The script, playing the owner, approved with the app's token. The app sent the REFUND offer. PayPal's refund `34G20106YH882311N` for $20.00 shows a create time of 09:05:19. |
| 09:07:03 | PayPal marked the dispute RESOLVED (RESOLVED_BUYER_FAVOUR, SELLER_ISSUED_REFUND, $20.00 refunded). The app's sync saw it at 09:07:06 and moved the incident to done. |

**The buyer did not accept anything in this run.** PayPal treated an offer for the full disputed amount as the shop issuing the refund and settled it, with no buyer step. The offer history on the dispute is empty. So the "buyer accepts in the PayPal page" step did not happen here. It was seen once in the earlier feasibility check, where the offer was a partial $12.00. The app currently always offers the full disputed amount, so the accept step is not on its path today. Two caveats: this is one run, and a full-amount offer on other dispute types or stages may behave differently.

Timing: about 4 minutes from filing to the shop's turn, 2 minutes 45 seconds of app run from start to the PayPal refund and the resolved dispute. One observation, not a benchmark.

## Second end-to-end run in the console (2026-10-19, WITA)

Both ran in one fresh database, in the real server on the PayPal sandbox, with the live AI (gemini-3.8-flash), driven from the console. Only the buyer's steps (approve, file the dispute) were done beforehand by the scripts in `scripts/sandbox/`. Ids and the database export are in `docs/live/live-demo-run-2026-10-19.json`.

| Path | Ids | Result |
|---|---|---|
| Shop at fault through a dispute, filled in on the console's new purchase form | order `3TV33723RS2694949`, capture `44479012T9014473F` ($20.00), buyer-side transaction `8XG55154L25115202`, dispute `PP-R-PRG-10193448`, refund `15L83320PH726421K` | Dispute RESOLVED, RESOLVED_BUYER_FAVOUR, SELLER_ISSUED_REFUND, $20.00. Capture REFUNDED. The console's "PayPal ids" box shows the capture, dispute and refund ids. The refund id is read from the order after PayPal settles the dispute. |
| Operator at fault, real payout of $15.00 to the sandbox buyer | sender_batch_id `mg_batch_326ae05e2fd447a1`, PayPal batch `6L88CLZG2BTJC`, item `6UW7XQTTF4SFW`, transaction `1RM01015UC573444L` | A separate read of the batch from PayPal (`docs/live/payout-6L88CLZG2BTJC-paypal-view.json`) shows batch SUCCESS and item SUCCESS. The console's payout box shows "PayPal item status SUCCESS". |

Timeline of the dispute run: order created and approved by the buyer script at about 09:23 to 09:25, dispute filed 09:26:24, PayPal's review, the shop's turn opened at 09:29:49 (3 min 25 s after filing), the form was filled in at about 09:30:00, the owner approved at 09:30:37, the offer was accepted by PayPal at 09:30:42 (PayPal's own refund record is stamped 09:30:40), PayPal updated the dispute to RESOLVED at 09:32:23, and the app saw it at 09:32:26. That is 1 min 45 s from the offer to the settled dispute. The buyer again did not accept anything. A FAILED $19.02 refund (`2MX1104965325583G`) showed up on the order at 09:29:22, during PayPal's review, as in the earlier runs. The app did not issue it.

Timeline of the payout run: approval and the saved sender_batch_id 09:33:12, sent 09:33:12, item SUCCESS seen by the app at 09:33:29 (17 seconds).

The ledger of this database holds both runs together: merchant -$20.00 and buyer +$20.00 for the refund (ref is the refund id), then buyer +$15.00, operator -$15.00 and merchant $0.00 for the payout (ref is the payout item id). The operator line is labelled as paid from the same sandbox balance.

Two more cases were created in the same database and move no money. The claim the records contradict (MG-ORDER-3) was prepared for a defence, with the evidence preview shown and nothing sent. For the unclear case (MG-ORDER-4) the live AI answered "customer" on the first run, so the rule offered to defend instead of stopping. Sampling that same case six times through the AI adapter gave unclear five times and customer once. On a second run the AI said unclear and the rule stopped. This is the same weakness the evaluation measured for ambiguous cases (`docs/EVAL_REPORT.md`).

## What was found

- **A bug the live run caught.** In payout run 2, PayPal refused the resend of the same sender_batch_id as expected (400 USER_BUSINESS_ERROR), but the app did not find the original batch. PayPal puts the link inside `details[0].link[0].href`, with host `api.sandbox.paypal.com`, and the top level `links` array is empty. The code only looked at the top level and a different host. It is fixed, a test uses the real shape, and run 3 found the original batch. Before the fix the app would have stopped on "PayPal already has this payout, check it in PayPal" instead of finishing.
- The payout batch still read PROCESSING when the item was already SUCCESS, in both kept runs. The app follows the item.
- The direct refund took about 3 seconds. The payout items reached SUCCESS about 20 seconds after the request.
- Dispute filing in the buyer's pages is a state machine of about 8 screens that changes slightly between runs. One new first screen appeared this time and the script was updated. It will likely break again when PayPal changes its pages.
- The buyer's Activity page loads blank in a headless browser. The account summary page works, and its rows are clickable but are not links.

## Replaying the dispute path

With `BUYER_EMAIL` and `BUYER_PW` in the environment only: `npx tsx scripts/live/make-order.ts create 20.00`, `node scripts/sandbox/g1-approve.mjs <order>`, `npx tsx scripts/live/make-order.ts capture <order>`, `node scripts/sandbox/buyer-txn.mjs 20.00`, `node scripts/sandbox/g1-dispute.mjs <buyer transaction id>`, `npx tsx scripts/live/dispute-status.ts <dispute> --wait`, then `npx tsx scripts/live/run-live.ts dispute <dispute>`.

## Not run against the real sandbox

- Sending evidence or a message to PayPal, and webhooks, are built and tested against mocked responses only. See the README.

## Reading the evidence files

`docs/live/live-*.json` hold the proposal, the rule's checks, PayPal's own answer from a separate GET, the ledger lines, the audit events and a timeline. They hold no keys or passwords. The buyer email is masked.

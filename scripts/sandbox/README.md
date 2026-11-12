# Sandbox buyer scripts

Playwright scripts that act as the PayPal sandbox buyer, because the buyer's steps (approve the order, file the dispute, accept the offer) have to happen on PayPal's pages. They are a test harness for preparing demo disputes. They are not part of the app and are not a production path.

- `g1-approve.mjs <orderId>`: the buyer approves a sandbox order.
- `g1-dispute.mjs <buyerTransactionId>`: the buyer files an item-not-received dispute.
- `g1-accept.mjs <disputeId>`: the buyer accepts the seller's refund offer (needed for a partial offer; a full-amount offer was settled by PayPal without it).
- `buyer-txn.mjs <amount>`: reads the buyer-side transaction id of the newest outgoing payment of that amount from the account summary page.
- `buyer-recent.mjs`: prints the buyer's recent activity lines.

Credentials come only from the environment (`BUYER_EMAIL`, `BUYER_PW`) and are used only on PayPal sandbox login pages. Never put them in a file. Screenshots go to `SHOTS_DIR` (default `scripts/sandbox/shots`, git ignored). If PayPal shows a captcha or a verification step, the scripts stop.

import type { BundleRecord, FaultProposal } from "./types.js";
import type { JudgeVerdict } from "./domain/judgeSchema.js";

export type Fixture = {
  key: string;
  orderId: string;
  captureId: string;
  amountCents: number;
  complaint: string;
  records: BundleRecord[];
  /** The saved AI answer used when no live provider is configured. Quotes are copied word for word. */
  recorded: FaultProposal;
  /** The saved verdict of the independent judge for that saved answer. */
  recordedJudge: JudgeVerdict;
};

const MERCHANT = "Northfield Reports";
export const FIXTURE_MERCHANT = MERCHANT;
export const FIXTURE_OPERATOR = "Parcel Agent Co";

export const FIXTURES: Fixture[] = [
  {
    key: "never-delivered",
    orderId: "MG-ORDER-1",
    captureId: "MG-CAP-1",
    amountCents: 2000,
    complaint: "I paid for the report three days ago and never received a download link.",
    records: [
      { id: "r1", kind: "instruction", label: "What the buyer asked for", text: "Buy the 2026 edition of the Packaging Suppliers Report for me. Budget up to $25." },
      { id: "r2", kind: "mandate", label: "What the agent was allowed to do", text: "Agent mandate: may buy one research report per request, maximum $25, from listed merchants only." },
      { id: "r3", kind: "listing", label: "Shop listing when bought", text: "Packaging Suppliers Report 2026 edition. PDF. Download link emailed within 1 hour of payment. Price $20.00." },
      { id: "r4", kind: "cart", label: "What the agent bought", text: "Cart: 1 x Packaging Suppliers Report 2026 edition, $20.00, paid by PayPal." },
      { id: "r5", kind: "tracking", label: "Shop fulfilment log", text: "Fulfilment log: order received, payment captured, no download link issued after 72 hours." },
      { id: "r6", kind: "delivery", label: "Delivery status", text: "Delivery status: not delivered." },
    ],
    recorded: {
      fault: "merchant",
      confidence: 0.93,
      summary: "The listing promised a download link within 1 hour. The shop's own log shows no link after 72 hours.",
      citations: [
        { recordId: "r3", quote: "Download link emailed within 1 hour of payment" },
        { recordId: "r5", quote: "no download link issued after 72 hours" },
      ],
    },
    recordedJudge: {
      quotes: [
        { recordId: "r3", quote: "Download link emailed within 1 hour of payment", role: "background", reason: "This is the shop's promise. It matters only together with the log." },
        { recordId: "r5", quote: "no download link issued after 72 hours", role: "supports", reason: "The shop's own log shows the promise was not kept." },
      ],
      contradictions: [],
      overall: "holds",
      missing: [],
      reasoning: "The listing promised a link within an hour and the shop's own log and delivery status both say nothing was sent after 72 hours. Nothing in the records points the other way.",
    },
  },
  {
    key: "wrong-edition",
    orderId: "MG-ORDER-2",
    captureId: "MG-CAP-2",
    amountCents: 1500,
    complaint: "This is last year's report. I asked for the 2026 one.",
    records: [
      { id: "r1", kind: "instruction", label: "What the buyer asked for", text: "Get me the 2026 edition of the Packaging Suppliers Report." },
      { id: "r2", kind: "mandate", label: "What the agent was allowed to do", text: "Agent mandate: buy the report the person names. Confirm the edition before paying." },
      { id: "r3", kind: "listing", label: "Shop listing when bought", text: "Packaging Suppliers Report. 2026 edition $15.00. 2025 edition $15.00. Both are PDF and are delivered by download link." },
      { id: "r4", kind: "cart", label: "What the agent bought", text: "Cart: 1 x Packaging Suppliers Report 2025 edition, $15.00." },
      { id: "r5", kind: "delivery", label: "Delivery status", text: "Delivered: Packaging Suppliers Report 2025 edition, PDF, download opened once." },
    ],
    recorded: {
      fault: "operator",
      confidence: 0.9,
      summary: "The shop delivered the 2025 edition it was paid for. The buyer asked for 2026 and the agent put 2025 in the cart.",
      citations: [
        { recordId: "r1", quote: "Get me the 2026 edition of the Packaging Suppliers Report" },
        { recordId: "r4", quote: "Packaging Suppliers Report 2025 edition" },
      ],
    },
    recordedJudge: {
      quotes: [
        { recordId: "r1", quote: "Get me the 2026 edition of the Packaging Suppliers Report", role: "supports", reason: "The person named the 2026 edition." },
        { recordId: "r4", quote: "Packaging Suppliers Report 2025 edition", role: "supports", reason: "The agent bought the 2025 edition, which is not what was asked for." },
      ],
      contradictions: [],
      overall: "holds",
      missing: [],
      reasoning: "The request names 2026, the cart holds 2025, and the delivery record shows the shop delivered the edition it was paid for. The mandate told the agent to confirm the edition before paying.",
    },
  },
  {
    key: "false-claim",
    orderId: "MG-ORDER-3",
    captureId: "MG-CAP-3",
    amountCents: 1800,
    complaint: "I never got the report, please refund me.",
    records: [
      { id: "r1", kind: "instruction", label: "What the buyer asked for", text: "Buy the 2026 Packaging Suppliers Report." },
      { id: "r2", kind: "listing", label: "Shop listing when bought", text: "Packaging Suppliers Report 2026 edition. PDF download link emailed within 1 hour. Price $18.00." },
      { id: "r3", kind: "cart", label: "What the agent bought", text: "Cart: 1 x Packaging Suppliers Report 2026 edition, $18.00." },
      { id: "r4", kind: "tracking", label: "Shop fulfilment log", text: "Fulfilment log: link emailed 4 minutes after payment." },
      { id: "r5", kind: "delivery", label: "Delivery status", text: "Delivery status: delivered. File downloaded twice from the buyer's address." },
    ],
    recorded: {
      fault: "customer",
      confidence: 0.88,
      summary: "The shop's log shows the link went out minutes after payment and the file was downloaded twice from the buyer's address.",
      citations: [
        { recordId: "r4", quote: "link emailed 4 minutes after payment" },
        { recordId: "r5", quote: "File downloaded twice from the buyer's address" },
      ],
    },
    recordedJudge: {
      quotes: [
        { recordId: "r4", quote: "link emailed 4 minutes after payment", role: "supports", reason: "The shop's log shows the link went out right after payment." },
        { recordId: "r5", quote: "File downloaded twice from the buyer's address", role: "supports", reason: "The file was opened from the buyer's address, which contradicts 'never got it'." },
      ],
      contradictions: [],
      overall: "holds",
      missing: [],
      reasoning: "The log and the delivery status agree that the link was sent and used. Nothing in the records supports the complaint.",
    },
  },
  {
    key: "ambiguous",
    orderId: "MG-ORDER-4",
    captureId: "MG-CAP-4",
    amountCents: 1200,
    complaint: "This is not what I wanted.",
    records: [
      { id: "r1", kind: "instruction", label: "What the buyer asked for", text: "Find me the packaging suppliers report." },
      { id: "r2", kind: "mandate", label: "What the agent was allowed to do", text: "Agent mandate: buy one research report, maximum $25." },
      { id: "r3", kind: "listing", label: "Shop listing when bought", text: "Packaging Suppliers Report. 2025 edition $12.00. 2026 edition $12.00. PDF download." },
      { id: "r4", kind: "cart", label: "What the agent bought", text: "Cart: 1 x Packaging Suppliers Report 2025 edition, $12.00." },
      { id: "r5", kind: "delivery", label: "Delivery status", text: "Delivered: 2025 edition PDF." },
    ],
    recorded: {
      fault: "unclear",
      confidence: 0.4,
      summary: "The request did not name an edition and both were listed at the same price. The records do not say whose mistake this was.",
      citations: [{ recordId: "r1", quote: "Find me the packaging suppliers report" }],
    },
    recordedJudge: {
      quotes: [{ recordId: "r1", quote: "Find me the packaging suppliers report", role: "background", reason: "The request does not name an edition, so it settles nothing by itself." }],
      contradictions: [],
      overall: "weak",
      missing: [
        { kind: "instruction", title: "The buyer's original request, with the edition named if it was", why: "The saved request says only 'the report'. If the buyer named an edition somewhere, that decides whose mistake it was." },
        { kind: "listing", title: "A snapshot of the listing as the agent saw it", why: "It would show which edition was the default or the newest when the agent bought." },
      ],
      reasoning: "Both editions were listed at the same price and the request did not name one, so the agent's choice is not shown to be wrong. More records could settle it.",
    },
  },
];

export function fixtureByKey(key: string | null | undefined): Fixture | undefined {
  return FIXTURES.find((f) => f.key === key);
}

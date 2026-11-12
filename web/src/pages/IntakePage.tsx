import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

const KINDS: Array<[string, string]> = [
  ["instruction", "What the buyer asked for"],
  ["mandate", "What the agent was allowed to do"],
  ["listing", "Shop listing when bought"],
  ["cart", "What the agent bought"],
  ["tracking", "Shop fulfilment log"],
  ["delivery", "Delivery status"],
];

export function IntakePage() {
  const nav = useNavigate();
  const [f, setF] = useState({ orderId: "", captureId: "", amount: "", buyerEmail: "", merchantName: "", operatorName: "", complaint: "", disputeId: "" });
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <section>
      <h1>New purchase and complaint</h1>
      <p className="muted">Each box becomes one numbered record. The AI can only quote these, word for word.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            const records = KINDS.filter(([k]) => texts[k]?.trim()).map(([k, label], i) => ({ id: `r${i + 1}`, kind: k, label, text: texts[k].trim() }));
            const p = await api<{ id: string }>("/api/purchases", {
              orderId: f.orderId,
              captureId: f.captureId || null,
              amountCents: Math.round(parseFloat(f.amount) * 100),
              buyerEmail: f.buyerEmail || null,
              merchantName: f.merchantName,
              operatorName: f.operatorName,
              records,
            });
            const inc = await api<{ id: string }>("/api/incidents", { purchaseId: p.id, complaint: f.complaint, disputeId: f.disputeId || null });
            nav(`/incidents/${inc.id}`);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="grid">
          <label>PayPal order id<input required value={f.orderId} onChange={set("orderId")} /></label>
          <label>Capture id<input value={f.captureId} onChange={set("captureId")} /></label>
          <label>Amount (USD)<input required inputMode="decimal" value={f.amount} onChange={set("amount")} /></label>
          <label>Buyer PayPal email (for a payout)<input type="email" value={f.buyerEmail} onChange={set("buyerEmail")} /></label>
          <label>Shop<input required value={f.merchantName} onChange={set("merchantName")} /></label>
          <label>Agent operator<input required value={f.operatorName} onChange={set("operatorName")} /></label>
          <label>PayPal dispute id (if one is open)<input value={f.disputeId} onChange={set("disputeId")} /></label>
        </div>
        {KINDS.map(([k, label]) => (
          <label key={k}>{label}<textarea rows={2} value={texts[k] ?? ""} onChange={(e) => setTexts({ ...texts, [k]: e.target.value })} /></label>
        ))}
        <label>What the buyer said<textarea required rows={3} value={f.complaint} onChange={set("complaint")} /></label>
        <button type="submit">Open incident</button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}

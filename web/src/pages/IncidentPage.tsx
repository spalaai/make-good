import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, FAULT_TEXT, money, moneyFlow, REMEDY_TEXT, STATUS_TEXT, type Incident } from "../api";

const ROLE_TEXT: Record<string, string> = { supports: "supports it", background: "background", does_not_support: "does not support it", not_judged: "not ruled on" };
const KINDS: Array<[string, string]> = [["instruction", "What the buyer asked for"], ["mandate", "What the agent was allowed to do"], ["listing", "Shop listing"], ["cart", "What the agent bought"], ["tracking", "Shop log or carrier scan"], ["delivery", "Delivery status"]];

export function IncidentPage({ role }: { role: "owner" | "agent" }) {
  const { id } = useParams();
  const [inc, setInc] = useState<Incident | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ev, setEv] = useState({ kind: "tracking", source: "", text: "" });
  const load = () => api<Incident>(`/api/incidents/${id}`).then(setInc).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [id]);

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError("");
    try {
      setInc(await api<Incident>(`/api/incidents/${id}/${path}`, body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!inc) return <p className="muted">{error || "Loading"}</p>;
  const cited = new Map<string, string[]>();
  for (const q of inc.quotes) cited.set(q.recordId, [...(cited.get(q.recordId) ?? []), q.quote]);
  const quoteState = (rid: string, quote: string) => inc.quotes.find((q) => q.recordId === rid && q.quote === quote);

  return (
    <section className="incident">
      <h1>Order {inc.purchase.orderId}</h1>
      <p><span className={`status ${inc.status}`}>{STATUS_TEXT[inc.status] ?? inc.status}</span> {inc.error && <span className="muted">{inc.error}</span>}</p>
      {error && <p className="error">{error}</p>}
      <ol className="flow" aria-label="How this was decided">{flowSteps(inc).map(([label, state]) => <li key={label} className={state}>{label}</li>)}</ol>

      <div className="cols">
        <div>
          <h2><span className="step">1</span>Receipt bundle</h2>
          <p className="muted small">
            {inc.purchase.merchantName} sold it for {money(inc.purchase.amountCents)}. Agent run by {inc.purchase.operatorName}.
          </p>
          <ol className="records">
            {inc.purchase.records.map((r) => (
              <li key={r.id} className={cited.has(r.id) ? "cited" : ""}>
                <div className="rlabel"><code>{r.id}</code> {r.label}{r.addedBy && <span className="added">added by {r.addedBy}</span>}</div>
                <div>{highlight(r.text, inc.quotes.filter((q) => q.recordId === r.id))}</div>
              </li>
            ))}
          </ol>
          <h3>What the buyer said</h3>
          <blockquote>{inc.complaint}</blockquote>
          {inc.decision?.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
        </div>

        <div>
          <h2><span className="step">2</span>AI proposal</h2>
          {inc.proposal ? (
            <>
              <p><strong>{FAULT_TEXT[inc.proposal.fault]}</strong>, {Math.round(inc.proposal.confidence * 100)}% sure.</p>
              <p>{inc.proposal.summary}</p>
              <p className="muted small">Source: {inc.aiSource?.kind} ({inc.aiSource?.provider}). {inc.aiSource?.note}</p>
            </>
          ) : (
            <p className="muted">Not read yet.</p>
          )}

          <h2><span className="step">3</span>Quote check</h2>
          {inc.proposal ? (
            <>
              <p className="muted small">Does each quote appear word for word in the record it names? This is plain text matching, not AI.</p>
              <ul className="cites">
                {inc.proposal.citations.map((c, k) => {
                  const q = quoteState(c.recordId, c.quote);
                  return (
                    <li key={k} className={q?.ok ? "ok" : "bad"}>
                      <code>{c.recordId}</code> "{c.quote}" <span>{q?.ok ? "found word for word" : q?.reason}</span>
                    </li>
                  );
                })}
                {inc.proposal.citations.length === 0 && <li className="bad">Nothing was quoted.</li>}
              </ul>
            </>
          ) : <p className="muted">Runs after the AI answers.</p>}

          <h2><span className="step">4</span>Independent judge</h2>
          {inc.proposal && inc.judge ? (
            <div className="judge">
              <p><strong>{{ holds: "Holds", weak: "Weak", fails: "Fails" }[inc.judge.overall]}.</strong> {inc.judge.reasoning}</p>
              <ul className="cites">
                {inc.judge.quoteChecks.map((q, k) => (
                  <li key={k} className={q.role === "supports" || q.role === "background" ? "ok" : "bad"}>
                    <span className={`role ${q.role}`}>{ROLE_TEXT[q.role]}</span><code>{q.recordId}</code> "{q.quote}" <span>{q.reason}</span>
                  </li>
                ))}
              </ul>
              {inc.judge.contradictions.length > 0 && (
                <>
                  <h3>Records that point the other way</h3>
                  <ul className="cites">
                    {inc.judge.contradictions.map((c, k) => (
                      <li key={k} className={!c.verified || c.addressed ? "ok" : "bad"}>
                        <code>{c.recordId}</code> "{c.quote}" {c.why} <span>{!c.verified ? "The judge's quote is not in that record, so it is ignored." : c.addressed ? "The AI dealt with it." : "The AI left it out."}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="muted small">
                Judge: {inc.judgeSource?.provider} {inc.judgeSource?.model}. {inc.judgeSource?.model === inc.aiSource?.model && inc.judgeSource?.provider === inc.aiSource?.provider ? "Same model as the AI above, with a different prompt. " : "A different model from the AI above, with a different prompt. "}
                It is another AI reading the same text. It can be wrong, and a passing verdict does not prove the records are true or complete. It never sets an amount.
              </p>
            </div>
          ) : inc.proposal ? (
            <p className="warn">The judge could not be reached, so nothing is decided without it.</p>
          ) : <p className="muted">Runs after the quote check.</p>}

          <h2><span className="step">5</span>Rule decision</h2>
          {inc.decision ? (
            <>
              <p><strong>{inc.decision.remedy === "abstain" && inc.decision.stop === "need_evidence" ? "Ask for more records" : REMEDY_TEXT[inc.decision.remedy]}</strong>{inc.remedy !== "abstain" && inc.amountCents != null ? `, ${money(inc.amountCents)}${inc.decision.capped ? " (capped by policy)" : ""}` : ""}</p>
              {inc.decision.abstainReason && <p className="warn">Stopped: {inc.decision.abstainReason}</p>}
              <ul className="checks">
                {inc.decision.checks.map((c) => (
                  <li key={c.id} className={c.passed ? "ok" : "bad"}><strong>{c.label}.</strong> {c.detail}</li>
                ))}
              </ul>
            </>
          ) : <p className="muted">The rule runs after the AI answers.</p>}

          {(inc.status === "needs_evidence" || inc.status === "needs_person") && (inc.decision?.evidenceRequests?.length ?? 0) > 0 && (
            <div className="box need">
              <h3>Records that would settle this</h3>
              <ul className="checks">
                {inc.decision!.evidenceRequests!.map((r, k) => (
                  <li key={k}><strong>{r.title}.</strong> {r.why}</li>
                ))}
              </ul>
              {role === "owner" ? (
                <form onSubmit={async (e) => { e.preventDefault(); await act("evidence", { kind: ev.kind, source: ev.source || undefined, text: ev.text }); setEv({ ...ev, source: "", text: "" }); }}>
                  <label>Kind of record <select value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value })}>{KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
                  <label>Where it came from <input value={ev.source} maxLength={100} onChange={(e) => setEv({ ...ev, source: e.target.value })} placeholder="For example: carrier scan, 12 Oct" /></label>
                  <label>The record, word for word <textarea rows={3} maxLength={2000} value={ev.text} onChange={(e) => setEv({ ...ev, text: e.target.value })} /></label>
                  <div className="actions"><button type="submit" disabled={busy || !ev.text.trim()}>Attach to the bundle</button><button type="button" className="secondary" disabled={busy} onClick={() => act("propose")}>Run the check again</button></div>
                </form>
              ) : <p className="muted">Only the owner can attach records.</p>}
            </div>
          )}
          {inc.evidencePreview && inc.status === "needs_owner" && (
            <div className="box"><h3>This is what would be sent to PayPal if you approve</h3><pre>{inc.evidencePreview}</pre></div>
          )}
          {(inc.status === "needs_owner" || inc.approvedBy) && <h2><span className="step">6</span>Owner approval</h2>}
          {inc.approvedBy && <p className="small">Approved by {inc.approvedBy}.</p>}
          {inc.status === "needs_owner" && role === "owner" && inc.approvalToken && (
            <div className="actions">
              <button disabled={busy} onClick={() => act("approve", { approvalToken: inc.approvalToken })}>Approve this exact action</button>
              <button className="secondary" disabled={busy} onClick={() => act("reject")}>Reject</button>
            </div>
          )}
          {inc.status === "needs_owner" && role !== "owner" && <p className="muted">Only the owner can approve.</p>}
          {(inc.status === "needs_person" || inc.status === "needs_evidence") && role === "owner" && (
            <div className="actions"><button className="secondary" disabled={busy} onClick={() => act("reject")}>Close without a payment</button></div>
          )}
          {["unknown", "waiting_paypal"].includes(inc.status) && role === "owner" && (
            <div className="actions"><button className="secondary" disabled={busy} onClick={() => act("retry")}>Try again</button></div>
          )}
          {inc.disputeId && (
            <p className="small">
              PayPal dispute <code>{inc.disputeId}</code>{inc.disputeStatus ? `, ${inc.disputeStatus.toLowerCase().replace(/_/g, " ")}` : ""}.{" "}
              <button className="link" disabled={busy} onClick={() => act("sync")}>Check PayPal now</button>
              {inc.status === "offer_made" && <span className="muted"> The buyer accepts the offer inside PayPal. Make Good cannot accept for them.</span>}
            </p>
          )}
          {inc.paymentsMode === "mock" && inc.status === "offer_made" && inc.disputeId && role === "owner" && (
            <p className="small"><button className="link" onClick={async () => { await api("/api/dev/buyer-accepts", { disputeId: inc.disputeId }); await act("sync"); }}>Mock only: act as the buyer and accept</button></p>
          )}

          {inc.payout && (
            <div className="box">
              <h3>Payout</h3>
              <p className="small">Status {inc.payout.status}. sender_batch_id <code>{inc.payout.senderBatchId}</code> (saved before it was sent).</p>
              {inc.payout.paypalBatchId && <p className="small">PayPal batch <code>{inc.payout.paypalBatchId}</code>{inc.payout.paypalItemId && <> item <code>{inc.payout.paypalItemId}</code></>}</p>}
              {inc.payout.status === "success" && <p className="small">PayPal item status <strong>SUCCESS</strong>{inc.payout.transactionId && <>, transaction <code>{inc.payout.transactionId}</code></>}.</p>}
            </div>
          )}
          {(inc.purchase.captureId || inc.refundId) && (
            <div className="box">
              <h3>PayPal ids</h3>
              {inc.purchase.captureId && <p className="small">Capture <code>{inc.purchase.captureId}</code> (order <code>{inc.purchase.orderId}</code>)</p>}
              {inc.disputeId && <p className="small">Dispute <code>{inc.disputeId}</code>{inc.disputeStatus ? `, ${inc.disputeStatus.toLowerCase().replace(/_/g, " ")}` : ""}</p>}
              {inc.refundId && <p className="small">Refund <code>{inc.refundId}</code></p>}
            </div>
          )}
          {inc.evidenceNote && (
            <div className="box"><h3>Evidence prepared</h3><pre>{inc.evidenceNote}</pre></div>
          )}
          {inc.ledger.length > 0 && (
            <div className="box">
              <h3>Who paid</h3>
              <ul className="ledger">
                {inc.ledger.map((l) => <li key={l.id}><strong>{l.account}</strong> {moneyFlow(l.amountCents)}. {l.label}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Mark each verified quote inside the record text. Quotes that were not found are not marked. */
function highlight(text: string, quotes: Array<{ quote: string; ok: boolean }>) {
  const lower = text.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const q of quotes) {
    if (!q.ok) continue;
    const at = lower.indexOf(q.quote.toLowerCase().replace(/[.,;:!?]+$/, "").trim());
    if (at >= 0) spans.push([at, at + q.quote.replace(/[.,;:!?]+$/, "").trim().length]);
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let pos = 0;
  spans.forEach(([s, e], k) => {
    if (s < pos) return;
    out.push(text.slice(pos, s), <mark key={k}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  out.push(text.slice(pos));
  return out;
}

/** The path a case takes, one pill per step: done, stopped, or still to come. */
function flowSteps(inc: Incident): Array<[string, "ok" | "bad" | "wait"]> {
  const quotesOk = inc.quotes.length > 0 && inc.quotes.every((q) => q.ok);
  const stopped = inc.decision?.remedy === "abstain";
  const judgeOk = !!inc.judge && inc.judge.overall === "holds" && !inc.judge.contradictions.some((c) => c.verified && !c.addressed) && !inc.judge.quoteChecks.some((q) => q.role === "does_not_support" || q.role === "not_judged");
  return [
    ["Records", "ok"],
    ["AI proposal", inc.proposal ? "ok" : "wait"],
    ["Quote check", !inc.proposal ? "wait" : quotesOk ? "ok" : "bad"],
    ["Judge", !inc.proposal ? "wait" : judgeOk ? "ok" : "bad"],
    ["Rule", !inc.decision ? "wait" : stopped ? "bad" : "ok"],
    ["Owner approval", inc.approvedBy ? "ok" : inc.status === "needs_owner" ? "wait" : stopped ? "bad" : "wait"],
  ];
}

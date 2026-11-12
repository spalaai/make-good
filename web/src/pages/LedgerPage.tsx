import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api";

type Entry = { id: string; at: string; incidentId: string; account: string; amountCents: number; kind: string; ref: string | null; label: string };
type Data = { entries: Entry[]; totals: Record<string, number> };

export function LedgerPage() {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    api<Data>("/api/ledger").then(setD).catch(() => setD(null));
  }, []);
  if (!d) return <p className="muted">Loading</p>;
  return (
    <section>
      <h1>Ledger</h1>
      <p className="muted">Who paid what. A line that reads minus is money an account paid out. The operator line is a label in this app: in the sandbox it is paid from the same PayPal balance as the shop.</p>
      <div className="totals">
        {(["merchant", "operator", "buyer"] as const).map((a) => (
          <div key={a} className="total"><div className="muted small">{a}</div><div className="big">{money(d.totals[a] ?? 0)}</div></div>
        ))}
      </div>
      <table>
        <thead><tr><th>When</th><th>Account</th><th>Amount</th><th>What</th><th>PayPal id</th></tr></thead>
        <tbody>
          {d.entries.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td>{e.account}</td>
              <td className="num">{money(e.amountCents)}</td>
              <td><Link to={`/incidents/${e.incidentId}`}>{e.label}</Link></td>
              <td><code>{e.ref ?? ""}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

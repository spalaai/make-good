import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, money, REMEDY_TEXT, STATUS_TEXT, type Incident } from "../api";

export function IncidentsPage() {
  const [items, setItems] = useState<Incident[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Incident[]>("/api/incidents").then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  return (
    <section>
      <h1>Incidents</h1>
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">No incidents yet. Run the seed script or add a purchase.</p>}
      <table>
        <thead>
          <tr><th>Order</th><th>What the buyer said</th><th>Proposed remedy</th><th>Amount</th><th>Status</th></tr>
        </thead>
        <tbody>
          {items?.map((i) => (
            <tr key={i.id}>
              <td><Link to={`/incidents/${i.id}`}>{i.purchase.orderId}</Link></td>
              <td>{i.complaint}</td>
              <td>{i.remedy ? REMEDY_TEXT[i.remedy] : "Not read yet"}</td>
              <td className="num">{i.amountCents != null && i.remedy !== "abstain" ? money(i.amountCents) : "none"}</td>
              <td><span className={`status ${i.status}`}>{STATUS_TEXT[i.status] ?? i.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

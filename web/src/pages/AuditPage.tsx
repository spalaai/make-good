import { useEffect, useState } from "react";
import { api } from "../api";

type Row = { id: string; at: string; actor: string; role: string; incidentId: string | null; event: string; detailsJson: string };

export function AuditPage() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    api<Row[]>("/api/audit").then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <section>
      <h1>Audit</h1>
      <p className="muted">Append-only table: edits and deletes are refused by the database. Rows are not signed or chained.</p>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Event</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.at).toLocaleTimeString()}</td>
              <td>{r.actor}</td>
              <td>{r.event.replace(/_/g, " ")}</td>
              <td><code className="small">{r.detailsJson}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

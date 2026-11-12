import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, getSession, setSession, type Session } from "./api";
import { AuditPage } from "./pages/AuditPage";
import { IncidentPage } from "./pages/IncidentPage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { IntakePage } from "./pages/IntakePage";
import { LedgerPage } from "./pages/LedgerPage";
import { LoginPage } from "./pages/LoginPage";

type Mode = { payments: string; paymentsMode: string; ai: string };

export function App() {
  const [session, setSess] = useState<Session | null>(getSession());
  const [mode, setMode] = useState<Mode | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    api<Mode>("/api/mode").then(setMode).catch(() => setMode(null));
  }, []);

  if (!session) {
    return (
      <LoginPage
        onLogin={(s) => {
          setSession(s);
          setSess(s);
          nav("/");
        }}
      />
    );
  }
  return (
    <div className="shell">
      <header className="top">
        <Link to="/" className="brand">Make Good</Link>
        <nav>
          <NavLink to="/" end>Incidents</NavLink>
          <NavLink to="/new">New purchase</NavLink>
          <NavLink to="/ledger">Ledger</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
        <div className="modes">
          <span className="pill sandbox">{mode?.payments ?? "PayPal"}</span>
          <span className="pill">{mode?.ai ?? "AI"}</span>
          <span className="who">{session.username} ({session.role})</span>
          <button
            className="link"
            onClick={() => {
              setSession(null);
              setSess(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<IncidentsPage />} />
          <Route path="/incidents/:id" element={<IncidentPage role={session.role} />} />
          <Route path="/new" element={<IntakePage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <footer className="foot">Prototype on PayPal sandbox money. Nothing here has been proven in production.</footer>
    </div>
  );
}

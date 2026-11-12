import { useState } from "react";
import { api, type Session } from "../api";

export function LoginPage({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="login">
      <h1>Make Good</h1>
      <p className="muted">When an agent's purchase goes wrong, decide whose mistake it was and move the money the right way.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api<Session>("/api/login", { username, password });
            onLogin(r);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button type="submit">Sign in</button>
        {error && <p className="error">{error}</p>}
        <p className="muted small">Demo logins: owner and agent. Passwords are in the README.</p>
      </form>
    </div>
  );
}

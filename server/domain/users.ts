import type { DatabaseSync } from "node:sqlite";
import { DEMO_SALT, hashPassword } from "../auth.js";

/** Demo logins only. They exist so the console has an owner and an agent. Change them with the env vars before hosting anything. */
export function ensureDemoUsers(db: DatabaseSync, env: Record<string, string | undefined> = process.env): void {
  const users: Array<[string, string, "owner" | "agent"]> = [
    ["owner", env.OWNER_PASSWORD ?? "owner-demo", "owner"],
    ["agent", env.AGENT_PASSWORD ?? "agent-demo", "agent"],
  ];
  for (const [username, password, role] of users) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)").run(`user_${username}`, username, hashPassword(password, DEMO_SALT), role);
  }
}

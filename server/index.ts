import "./loadEnv.js";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_PATH, migrate, openDatabase } from "./db.js";
import { ensureDemoUsers } from "./domain/users.js";
import { workerTick } from "./domain/worker.js";
import { syncAllDisputes } from "./domain/disputes.js";
import { createCtx, createHandler } from "./routes.js";
import { createStaticHandler } from "./static.js";

const port = Number(process.env.PORT ?? 8787);
const db = openDatabase(process.env.MG_DB_PATH ?? DEFAULT_DB_PATH);
migrate(db);
ensureDemoUsers(db);
const ctx = createCtx(db);
const handle = createHandler(ctx);

// The built console (npm run build) is served from the same port when it exists.
const serveWeb = createStaticHandler(join(dirname(fileURLToPath(import.meta.url)), "../web/dist"));

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
    try {
      db.prepare("SELECT 1").get();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("database unavailable");
    }
    return;
  }
  if (serveWeb(req, res)) return;
  void handle(req, res);
});

if (process.env.VITEST !== "true") {
  server.listen(port, () => {
    setInterval(() => void workerTick(ctx), 2000).unref();
    const every = Number(process.env.DISPUTE_SYNC_SECONDS ?? 15);
    if (every > 0) setInterval(() => void syncAllDisputes(ctx), every * 1000).unref();
    console.log(`Make Good API on http://localhost:${port}`);
    console.log(`${ctx.payments.modeLabel}. ${ctx.ai.modeLabel}.`);
  });
}

export { server, db };

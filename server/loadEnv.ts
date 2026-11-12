import { existsSync } from "node:fs";

// Load .env when present so the README setup works. Real environment variables win.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // A broken .env should not stop the demo.
  }
}

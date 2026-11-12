import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the built web app (web/dist) from the same server, so one process and one URL is enough on a host like Render.
 * Returns a function that answers a GET or HEAD request and returns true, or returns false when the request is not for
 * the web app (so the caller can send it to the API). Unknown paths without a file extension get index.html, for the
 * single page app's client side routes.
 */
export function createStaticHandler(distDir: string): (req: IncomingMessage, res: ServerResponse) => boolean {
  const root = resolve(distDir);
  const index = join(root, "index.html");
  const available = existsSync(index);

  return (req, res) => {
    if (!available) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return false;

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    const wanted = resolve(root, "." + normalize("/" + pathname));
    // Never leave the dist folder, whatever the path says.
    const inside = wanted === root || wanted.startsWith(root + sep);
    let file = index;
    if (inside && existsSync(wanted) && statSync(wanted).isFile()) file = wanted;
    else if (extname(pathname)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return true;
    }

    const isAsset = file !== index && file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
}

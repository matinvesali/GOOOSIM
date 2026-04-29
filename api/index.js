import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const runtime = 'nodejs';

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const SPEED_LIMIT_BYTES = 120 * 1024; // 120 KB/s - برای کمترین مصرف

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// تابع محدودکننده سرعت - فقط همینه، بقیه چیزا دست نمیخوره
async function slowPipeline(source, dest, speedBps) {
  for await (const chunk of source) {
    const chunkSize = chunk.length;
    const delayMs = (chunkSize / speedBps) * 1000;
    dest.write(chunk);
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  dest.end();
}

export default async function handler(req, res) {
  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  try {
    const targetUrl = TARGET_BASE + req.url;

    const headers = {};
    let clientIp = null;
    for (const key of Object.keys(req.headers)) {
      const k = key.toLowerCase();
      const v = req.headers[key];
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-vercel-")) continue;
      if (k === "x-real-ip") { clientIp = v; continue; }
      if (k === "x-forwarded-for") { if (!clientIp) clientIp = v; continue; }
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOpts = { method, headers, redirect: "manual" };
    if (hasBody) {
      fetchOpts.body = Readable.toWeb(req);
      fetchOpts.duplex = "half";
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try { res.setHeader(k, v); } catch {}
    }

    if (upstream.body) {
      // تنها جایی که تغییر کرده - استفاده از slowPipeline به جای pipeline مستقیم
      const webStream = upstream.body;
      const nodeStream = Readable.fromWeb(webStream);
      await slowPipeline(nodeStream, res, SPEED_LIMIT_BYTES);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: Tunnel Failed");
    }
  }
}

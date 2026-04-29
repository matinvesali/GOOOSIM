import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const runtime = 'nodejs';

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const SPEED_LIMIT_BYTES_PER_SEC = 240 * 1024; // 120 KB/s = ~1 مگابیت (خیلی پایین‌تر از 8)

const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "forwarded", "x-forwarded-host",
  "x-forwarded-proto", "x-forwarded-port",
]);

// کلاس محدودکننده سرعت خیلی ساده
class SlowStream extends Readable {
  constructor(source, speedBytesPerSec) {
    super();
    this.source = source;
    self.speedBytesPerSec = speedBytesPerSec;
    this.chunkDelayMs = 100; // هر ۱۰۰ میلی‌ثانیه
    this.bytesPerChunk = Math.floor(speedBytesPerSec * (this.chunkDelayMs / 1000));
    self.bytesPerChunk = this.bytesPerChunk;
    self.buffer = [];
    self.source.on('data', (chunk) => {
      self.buffer.push(chunk);
      self._sendSlowly();
    });
    self.source.on('end', () => self.push(null));
    self.source.on('error', (err) => self.destroy(err));
    self.sending = false;
  }

  _sendSlowly() {
    if (self.sending || self.buffer.length === 0) return;
    self.sending = true;
    
    const chunk = self.buffer.shift();
    let offset = 0;
    
    const sendChunk = () => {
      const toSend = chunk.slice(offset, offset + self.bytesPerChunk);
      if (toSend.length === 0) {
        self.sending = false;
        self._sendSlowly();
        return;
      }
      offset += toSend.length;
      self.push(toSend);
      setTimeout(sendChunk, self.chunkDelayMs);
    };
    
    sendChunk();
  }

  _read() {}
}

export default async function handler(req, res) {
  // فقط اجازه GET و روش‌های سبک
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN not set");
  }

  try {
    const targetUrl = TARGET_BASE + req.url;

    // هدرهای خیلی کم (حداقلی)
    const headers = { "user-agent": "vercel-relay" };
    let clientIp = null;
    
    for (const key of Object.keys(req.headers)) {
      const k = key.toLowerCase();
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-vercel-")) continue;
      if (k === "x-real-ip" || k === "x-forwarded-for") {
        if (!clientIp) clientIp = req.headers[key];
        continue;
      }
      // فقط هدرهای ضروری رو نگه دار
      if (k === "accept" || k === "accept-encoding" || k === "content-type") {
        headers[k] = req.headers[key];
      }
    }
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      redirect: "manual"
    });

    res.statusCode = upstream.status;
    
    // فقط هدرهای ضروری رو بفرست
    const essentialHeaders = ["content-type", "location", "www-authenticate"];
    for (const k of essentialHeaders) {
      const v = upstream.headers.get(k);
      if (v) res.setHeader(k, v);
    }

    if (upstream.body && upstream.headers.get("content-length") !== "0") {
      const slowStream = new SlowStream(Readable.fromWeb(upstream.body), SPEED_LIMIT_BYTES_PER_SEC);
      await pipeline(slowStream, res);
    } else {
      res.end();
    }
  } catch {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Tunnel Failed");
    }
  }
}
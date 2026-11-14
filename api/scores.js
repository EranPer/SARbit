/* SARbit world scoreboard. GET = the top 20; POST {name, points, stars, missions} = keep each cadet's best score.
   A Vercel Function (Node.js) with any Redis database from Vercel → the SARbit project → Storage → connect:
   - Upstash / KV: uses its REST address + token (KV_REST_API_URL / _TOKEN, UPSTASH_REDIS_REST_URL / _TOKEN, any prefix)
   - plain Redis: uses its redis:// or rediss:// address (REDIS_URL, KV_URL, or any setting holding one)
   No packages needed. Without a database it answers 503 and lists the storage setting NAMES it can see (never values),
   and the game says "the world board isn't switched on yet". Names are cadet nicknames, ≤ 20 characters. */
import net from "node:net";
import tls from "node:tls";

const KEY = "sarbit:board", INFO = "sarbit:board:info", TOP = 20, MAX_POINTS = 50000, MAX_STARS = 150;

// ---------- Redis over its REST API (Upstash, Vercel KV) ----------
const restCommand = (url, token) => async (...cmd) => {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
};

// ---------- Redis over TCP (plain Redis): one short connection per command ----------
const encode = (args) => `*${args.length}\r\n` + args.map((a) => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("");
function parse(b, i) {   // one RESP reply from buffer b at i -> { value, end }, or null if it hasn't all arrived yet
  const nl = b.indexOf("\r\n", i);
  if (nl < 0) return null;
  const type = String.fromCharCode(b[i]), line = b.toString("utf8", i + 1, nl), next = nl + 2;
  if (type === "+") return { value: line, end: next };
  if (type === "-") return { value: new Error(line), end: next };
  if (type === ":") return { value: Number(line), end: next };
  if (type === "$") {
    const n = Number(line);
    if (n < 0) return { value: null, end: next };
    return b.length < next + n + 2 ? null : { value: b.toString("utf8", next, next + n), end: next + n + 2 };
  }
  if (type === "*") {
    const n = Number(line), arr = [];
    if (n < 0) return { value: null, end: next };
    let j = next;
    for (let k = 0; k < n; k++) { const r = parse(b, j); if (!r) return null; arr.push(r.value); j = r.end; }
    return { value: arr, end: j };
  }
  throw new Error("unexpected reply from redis");
}
const tcpCommand = (address) => (...cmd) => new Promise((resolve, reject) => {
  const u = new URL(address), secure = u.protocol === "rediss:", port = Number(u.port) || 6379;
  const pass = decodeURIComponent(u.password || ""), user = decodeURIComponent(u.username || "");
  const send = (pass ? encode(user ? ["AUTH", user, pass] : ["AUTH", pass]) : "") + encode(cmd), want = pass ? 2 : 1;
  const sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
  let buf = Buffer.alloc(0);
  const replies = [];
  sock.setTimeout(6000, () => { sock.destroy(); reject(new Error("redis timeout")); });
  sock.on("error", reject);
  sock.on(secure ? "secureConnect" : "connect", () => sock.write(send));
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (let r = parse(buf, 0); r; r = parse(buf, 0)) {
      replies.push(r.value); buf = buf.subarray(r.end);
      if (replies.length === want) {
        sock.end();
        const bad = replies.find((x) => x instanceof Error);
        return bad ? reject(bad) : resolve(replies[want - 1]);
      }
    }
  });
});

// ---------- which database is connected? ----------
function database() {
  const env = process.env, names = Object.keys(env);
  for (const u of ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL", ...names.filter((n) => /REST_API_URL$|REDIS_REST_URL$/.test(n))]) {
    const t = u.replace(/URL$/, "TOKEN");
    if (env[u] && env[t]) return restCommand(env[u], env[t]);
  }
  const tcp = ["REDIS_URL", "KV_URL", ...names].find((n) => /^rediss?:\/\//.test(env[n] || ""));
  if (tcp) return tcpCommand(env[tcp]);
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const redis = database();
  if (!redis) {
    const found = Object.keys(process.env).filter((n) => /KV|REDIS|UPSTASH|STORAGE|DATABASE/i.test(n));
    return res.status(503).json({ error: "the world board is not switched on", found });
  }
  try {
    if (req.method === "GET") {
      const flat = (await redis("ZREVRANGE", KEY, 0, TOP - 1, "WITHSCORES")) || [];
      const rows = [];
      for (let i = 0; i < flat.length; i += 2) rows.push({ id: flat[i], points: Number(flat[i + 1]) });
      const info = rows.length ? await redis("HMGET", INFO, ...rows.map((r) => r.id)) : [];
      return res.status(200).json({ top: rows.map((r, i) => {
        const x = JSON.parse(info[i] || "{}");
        return { name: x.name || r.id, stars: x.stars || 0, points: r.points };
      }) });
    }
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
      if (!b || typeof b !== "object") return res.status(400).json({ error: "send JSON" });
      const name = String(b.name || "").replace(/[<>&"\u0000-\u001f]/g, "").trim().slice(0, 20);
      const points = Math.round(Number(b.points)), stars = Math.round(Number(b.stars));
      if (!name || !(points >= 0 && points <= MAX_POINTS) || !(stars >= 0 && stars <= MAX_STARS)) return res.status(400).json({ error: "not a valid score" });
      const id = name.toLowerCase(), best = await redis("ZSCORE", KEY, id);
      if (best === null || points > Number(best)) {   // keep each cadet's best
        await redis("ZADD", KEY, points, id);
        await redis("HSET", INFO, id, JSON.stringify({ name, stars }));
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "use GET or POST" });
  } catch (err) {
    return res.status(502).json({ error: "the world board is not answering", detail: String(err.message || err).slice(0, 120) });
  }
}

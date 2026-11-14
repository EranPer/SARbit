/* SARbit world scoreboard. GET = the top 20; POST {name, points, stars, missions} = keep each cadet's best score.
   A Vercel Edge Function with an Upstash Redis database: Vercel → the SARbit project → Storage → Upstash Redis →
   create + connect. That adds the env vars read below; nothing else to set. Without them it answers 503 and the game
   says "the world board isn't switched on yet". Names are cadet nicknames, ≤ 20 characters. */
export const config = { runtime: "edge" };

const KEY = "sarbit:board", INFO = "sarbit:board:info", TOP = 20, MAX_POINTS = 50000, MAX_STARS = 150;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export default async function handler(req) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return json({ error: "the world board is not switched on" }, 503);
  const redis = async (...cmd) => {   // Upstash REST: one command as a JSON array
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    return (await r.json()).result;
  };

  try {
    if (req.method === "GET") {
      const flat = await redis("ZREVRANGE", KEY, 0, TOP - 1, "WITHSCORES");
      const rows = [];
      for (let i = 0; i < flat.length; i += 2) rows.push({ id: flat[i], points: Number(flat[i + 1]) });
      const info = rows.length ? await redis("HMGET", INFO, ...rows.map((r) => r.id)) : [];
      return json({ top: rows.map((r, i) => {
        const x = JSON.parse(info[i] || "{}");
        return { name: x.name || r.id, stars: x.stars || 0, points: r.points };
      }) });
    }
    if (req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "send JSON" }, 400); }
      const name = String(b.name || "").replace(/[<>&"\u0000-\u001f]/g, "").trim().slice(0, 20);
      const points = Math.round(Number(b.points)), stars = Math.round(Number(b.stars));
      if (!name || !(points >= 0 && points <= MAX_POINTS) || !(stars >= 0 && stars <= MAX_STARS)) return json({ error: "not a valid score" }, 400);
      const id = name.toLowerCase(), best = await redis("ZSCORE", KEY, id);
      if (best === null || points > Number(best)) {   // keep each cadet's best
        await redis("ZADD", KEY, points, id);
        await redis("HSET", INFO, id, JSON.stringify({ name, stars }));
      }
      return json({ ok: true });
    }
    return json({ error: "use GET or POST" }, 405);
  } catch (err) {
    return json({ error: "the world board is not answering" }, 502);
  }
}

/* SARbit bonus questions after the game: about the real places and sizes around the change.
   content.json: "bonus": [ {"type": "town" | "river" | "area" | "share", "question": "...", "explain": "..."}, ... ]
   Every answer is worked out here from the radar (what glows) and OpenStreetMap (osm.geojson), never typed in:
   - town:  which town is closest to the biggest glowing spot
   - river: which river is closest to the biggest glowing spot (canals can only be wrong choices)
   - area:  how many km² glow all together (a 1 km × 1 km square is drawn to compare)
   - share: what part of the picture is "change" | "land" | "wet" (cfg.of)
   Wrong choices are always clearly different, so a careful kid can work it out. {town} {river} {km} {km2} {fields} {pct}
   in "explain" are filled in. */
(() => {
  "use strict";
  const PTS = 200, Z = 15, FIELD_KM2 = 0.105 * 0.068;   // a football pitch, 105 m × 68 m
  const pin = (name, cls) => L.divIcon({ className: `town-pin ${cls || ""}`, html: `<b>${name}</b>`, iconSize: [0, 0] });
  const fill = (t, v) => Object.entries(v).reduce((s, [k, x]) => s.split(`{${k}}`).join(x), t || "");
  const nice = (x) => (x >= 10 ? String(Number(x.toPrecision(2))) : x >= 1 ? x.toFixed(1).replace(/\.0$/, "") : x.toFixed(2));
  function shuffle(arr, id) {
    let s = [...id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), arr.length + 7);
    return arr.map((v) => ({ v, r: (s = (s * 16807) % 2147483647) })).sort((a, b) => a.r - b.r).map((o) => o.v);
  }

  // the blocks of the biggest glowing spot, as lat/lng (at most 300 of them, enough to measure distances)
  function bigCells(api) {
    const a = api.analysis(), t = a.targets[0];
    if (!t) return [];
    const step = Math.max(1, Math.ceil(t.cells.length / 300));
    return t.cells.filter((_, i) => i % step === 0).map((j) => api.toLatLng((j % a.bw) + 0.5, ((j / a.bw) | 0) + 0.5));
  }
  const toPoint = (map, ll) => map.project(ll, Z);
  const mPerPx = (lat) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (Z + 8);
  function distToLines(map, cells, lines) {   // metres from the spot to the nearest point of any of the lines
    let best = Infinity;
    const P = cells.map((c) => toPoint(map, c));
    lines.forEach((coords) => {
      const Q = coords.map((c) => toPoint(map, L.latLng(c[1], c[0])));
      P.forEach((p) => { for (let i = 1; i < Q.length; i++) best = Math.min(best, L.LineUtil.pointToSegmentDistance(p, Q[i - 1], Q[i])); });
    });
    return best * mPerPx(cells[0].lat);
  }

  // one multiple-choice question in the side panel; returns answer(choice) so map pins can answer too
  function ask(api, { question, choices, right, why, note, reveal }) {
    const M = api.M, key = `bonus${M.bonusAsked}-${M.bonusQueue.length}`;
    api.kit.innerHTML = `<p class="quiz-q">⭐ Bonus: ${question}</p>
      <div class="quiz-a">${choices.map((c, n) => `<button data-n="${n}">${c.label}</button>`).join("")}</div>
      ${note ? `<p class="muted">${note}</p>` : ""}`;
    let answered = false;
    function answer(c) {
      if (answered) return;
      answered = true;
      const ok = c === right;
      M.bonusAsked++;
      if (ok) { M.bonusRight++; api.award(key, PTS, right.ll); api.sfx("win"); api.react("happy"); } else { api.sfx("miss"); api.react("oops"); }
      api.say((ok ? `Yes! +${PTS}. ` : `It's ${right.label}. `) + why);
      api.kit.querySelectorAll("button[data-n]").forEach((b) => {
        const ch = choices[+b.dataset.n]; b.disabled = true;
        b.classList.toggle("ok", ch === right); b.classList.toggle("bad", ch === c && !ok);
      });
      if (reveal) reveal(c, ok);
      api.next(api.more ? "Next bonus ➜" : "Score it ⭐", true);
    }
    api.kit.querySelectorAll("button[data-n]").forEach((b) => b.addEventListener("click", () => answer(choices[+b.dataset.n])));
    api.say(`Bonus question! ${question}`);
    api.next(api.more ? "Skip ➜" : "Skip, score it ⭐", true);
    return answer;
  }

  // a ring around the biggest glowing spot
  function markSpot(api) {
    const a = api.analysis(), t = a.targets[0], c = api.toLatLng(t.cx + 0.5, t.cy + 0.5);
    const r = 1.3 * Math.sqrt(t.size / Math.PI) * c.distanceTo(api.toLatLng(t.cx + 1.5, t.cy + 0.5));
    api.layer(L.circle(c, { radius: Math.max(400, r), color: "#ffe14a", weight: 4, fillOpacity: 0.06, className: "hint-ring", interactive: false }));
    return c;
  }

  const B = (window.SARbitBonus = window.SARbitBonus || {});

  B.town = {
    async start(api) {
      const M = api.M, cfg = api.cfg, g = await api.osm(), cells = bigCells(api), area = M.bounds.pad(0.05);
      let places = (g ? g.features : []).filter((f) => f.properties.kind === "town" && !/island|islet/.test(f.properties.place));
      if (places.filter((f) => /city|town|village/.test(f.properties.place)).length >= 3) places = places.filter((f) => /city|town|village/.test(f.properties.place));
      const towns = places.map((f) => ({ label: f.properties.name.replace(/\s*\(.*\)$/, ""), ll: L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
        .filter((t) => area.contains(t.ll));
      if (!cells.length || towns.length < 2) return api.done();
      towns.forEach((t) => (t.d = Math.min(...cells.map((c) => c.distanceTo(t.ll)))));
      towns.sort((x, y) => x.d - y.d);
      const right = towns[0], others = towns.slice(1).filter((t) => t.d >= right.d * 2 + 2500).slice(0, 2);   // clearly farther
      if (!others.length) return api.done();
      const choices = shuffle([right, ...others], M.id), centre = markSpot(api);
      api.setLayer("towns", false);   // only the choices, so the map stays readable
      const markers = choices.map((t) => api.layer(L.marker(t.ll, { icon: pin(t.label), zIndexOffset: 800 }).on("click", () => answer(t))));
      api.map.flyToBounds(L.latLngBounds([centre, ...choices.map((t) => t.ll)]).pad(0.25), { duration: 0.6 });
      const answer = ask(api, {
        question: cfg.question, choices, right,
        why: fill(cfg.explain || "{town} is only {km} km from the biggest change.", { town: right.label, km: (right.d / 1000).toFixed(1) }),
        note: "The yellow ring is the biggest glowing spot. Tap a town on the map or here. Names: © OpenStreetMap contributors.",
        reveal: () => {
          markers.forEach((m, n) => m.setIcon(pin(choices[n].label, choices[n] === right ? "ok" : "")));
          api.layer(L.polyline([centre, right.ll], { color: "#4be08a", weight: 3, dashArray: "6 6", interactive: false }));
          api.setLayer("towns", true);
        },
      });
    },
  };

  B.river = {
    async start(api) {
      const M = api.M, cfg = api.cfg, g = await api.osm(), cells = bigCells(api);
      const byName = {};
      (g ? g.features : []).filter((f) => f.properties.kind === "river" && f.properties.name).forEach((f) => {
        const r = (byName[f.properties.name] = byName[f.properties.name] || { label: f.properties.name, lines: [], river: false });
        r.lines.push(f.geometry.coordinates); r.river = r.river || f.properties.waterway === "river";
      });
      const rivers = Object.values(byName);
      if (!cells.length || rivers.length < 2) return api.done();
      rivers.forEach((r) => (r.d = distToLines(api.map, cells, r.lines)));
      const right = rivers.filter((r) => r.river).sort((x, y) => x.d - y.d)[0];   // canals can only be wrong choices
      if (!right) return api.done();
      let others = rivers.filter((r) => r !== right && r.d >= right.d * 2 + 1500);
      if (!others.length) others = rivers.filter((r) => r !== right && r.d > right.d);
      if (!others.length) return api.done();
      const choices = shuffle([right, ...others.sort((x, y) => x.d - y.d).slice(0, 2)], M.id);
      markSpot(api);
      const colours = ["#ffffff", "#ffe14a", "#c08cff"];
      const drawn = choices.map((r, n) => r.lines.map((c) => api.layer(L.polyline(c.map((p) => [p[1], p[0]]),
        { color: colours[n], weight: 5, opacity: 0.95, interactive: false }))));
      choices.forEach((r) => {   // a name tag on the middle of each river's longest piece
        const line = r.lines.slice().sort((x, y) => y.length - x.length)[0], mid = line[(line.length / 2) | 0];
        r.ll = L.latLng(mid[1], mid[0]);
        api.layer(L.marker(r.ll, { icon: pin(r.label), zIndexOffset: 800 }).on("click", () => answer(r)));
      });
      api.map.flyToBounds(M.bounds, { duration: 0.6 });
      const answer = ask(api, {
        question: cfg.question, choices, right,
        why: fill(cfg.explain || "{river} runs only {km} km from the biggest change.", { river: right.label, km: (right.d / 1000).toFixed(1) }),
        note: "The yellow ring is the biggest glowing spot; each coloured line is a river or canal. Names: © OpenStreetMap contributors.",
        reveal: () => drawn.forEach((ls, n) => ls.forEach((l) => l.setStyle({ color: choices[n] === right ? "#4be08a" : "#9aa6cf", opacity: choices[n] === right ? 1 : 0.5 }))),
      });
    },
  };

  B.area = {
    start(api) {
      const M = api.M, cfg = api.cfg, a = api.analysis();
      const nw = M.bounds.getNorthWest(), bwM = nw.distanceTo(M.bounds.getNorthEast()) / a.bw, bhM = nw.distanceTo(M.bounds.getSouthWest()) / a.bh;
      const n = a.changed.reduce((s, v) => s + v, 0), km2 = (n * bwM * bhM) / 1e6;
      if (km2 < 0.05 || !a.targets.length) return api.done();
      const right = { label: `about ${nice(km2)} km²` };
      const choices = [{ label: `about ${nice(km2 / 4)} km²` }, right, { label: `about ${nice(km2 * 4)} km²` }];
      // a 1 km × 1 km square on the biggest spot, to compare with
      const t = a.targets[0], c = api.toLatLng(t.cx + 0.5, t.cy + 0.5);
      const dLat = 1000 / 111320, dLng = 1000 / (111320 * Math.cos((c.lat * Math.PI) / 180));
      api.layer(L.rectangle([[c.lat - dLat / 2, c.lng - dLng / 2], [c.lat + dLat / 2, c.lng + dLng / 2]],
        { color: "#ffe14a", weight: 3, fillColor: "#ffe14a", fillOpacity: 0.25, interactive: false }))
        .bindTooltip("1 km × 1 km", { permanent: true, direction: "top", className: "place-label" });
      api.map.flyToBounds(M.bounds, { duration: 0.6 });
      const fields = Number((km2 / FIELD_KM2).toPrecision(2)).toLocaleString("en");
      ask(api, {
        question: cfg.question || "How big is everything that glows, all together? The yellow square is 1 km × 1 km.",
        choices, right,
        why: `${nice(km2)} km² is as big as about ${fields} football pitches! ` + fill(cfg.explain, { km2: nice(km2), fields }),
        note: "Tip: guess how many yellow squares would cover all the glow. Radar can measure sizes from space!",
      });
    },
  };

  B.share = {
    start(api) {
      const cfg = api.cfg, of = cfg.of || "change", s = api.blockStats("CO"), a = api.analysis();
      let n = 0, yes = 0;
      for (let k = 0; k < s.valid.length; k++) {
        if (!s.valid[k]) continue;
        n++;
        yes += of === "land" ? s.after[k] > -14 : of === "wet" ? s.after[k] < -18 : a.changed[k] || 0;
      }
      if (!n) return api.done();
      const pct = (100 * yes) / n, STEPS = [2, 5, 10, 20, 35, 50, 70, 90];
      const at = STEPS.reduce((b, v, i) => (Math.abs(v - pct) < Math.abs(STEPS[b] - pct) ? i : b), 0);
      const lo = at >= 2 ? at - 2 : at + 3, hi = at <= STEPS.length - 3 ? at + 2 : at - 3;
      const right = { label: `about ${STEPS[at]} %` };
      const choices = [...new Set([lo, at, hi])].sort((x, y) => x - y).map((i) => (i === at ? right : { label: `about ${STEPS[i]} %` }));
      ask(api, { question: cfg.question, choices, right, why: fill(cfg.explain || "My radar measured {pct} %.", { pct: Math.round(pct) }) });
    },
  };
})();

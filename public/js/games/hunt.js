/* SARbit game "hunt": find the tiny super-bright dots on the water (metal oil platforms). Metal corners bounce the radar
   straight back, so a platform shines like a star on the dark, smooth water, in BOTH pictures, because it never moves.
   content.json: "game": {"type": "hunt", "hearts": 4, "glow": "plain"} */
(() => {
  "use strict";
  const grey = (db) => (db + 35) * 6.375;   // grey layers: 0 = −35 dB, 6.375 grey levels per dB
  const REACH_PX = 26, PTS = 150;

  // bright dots (> −8 dB) on dark water (25 x 25 mean < −16 dB, < 13 % land around), present in both pictures
  function platforms(A, B) {
    const W = A.width, H = A.height, d = A.data, S = new Float64Array((W + 1) * (H + 1)), r = 12, edge = 24;
    for (let y = 0; y < H; y++) for (let x = 0, row = 0; x < W; x++) {
      row += d[(y * W + x) * 4]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
    const mean = (x, y) => (S[(y + r + 1) * (W + 1) + x + r + 1] - S[(y - r) * (W + 1) + x + r + 1]
      - S[(y + r + 1) * (W + 1) + x - r] + S[(y - r) * (W + 1) + x - r]) / ((2 * r + 1) ** 2);
    const hot = new Uint8Array(W * H), hi = grey(-8), dark = grey(-16), land = grey(-14);
    for (let y = edge; y < H - edge; y++) for (let x = edge; x < W - edge; x++) {
      const i = y * W + x;
      const inPicture = d[(i - r) * 4 + 3] && d[(i + r) * 4 + 3] && d[(i - r * W) * 4 + 3] && d[(i + r * W) * 4 + 3];
      if (d[i * 4] > hi && inPicture && mean(x, y) < dark) hot[i] = 1;
    }
    const out = [];
    for (let i = 0; i < W * H; i++) {
      if (hot[i] !== 1) continue;
      const stack = [i]; hot[i] = 2; let n = 0, sx = 0, sy = 0;
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j / W) | 0; n++; sx += x; sy += y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const k = (y + dy) * W + x + dx;
          if (hot[k] === 1) { hot[k] = 2; stack.push(k); }
        }
      }
      const x = Math.round(sx / n), y = Math.round(sy / n);
      if (n < 2 || out.some((q) => Math.hypot(q.x - x, q.y - y) < 6)) continue;
      let bright = 0, other = 0;
      for (let yy = y - 15; yy <= y + 15; yy++) for (let xx = x - 15; xx <= x + 15; xx++) bright += d[(yy * W + xx) * 4] > land;
      for (let yy = y - 4; yy <= y + 4; yy++) for (let xx = x - 4; xx <= x + 4; xx++) other = Math.max(other, B.data[(yy * W + xx) * 4]);
      if (bright / 961 < 0.13 && other > grey(-12)) out.push({ x, y, n });   // open water, and there in the other picture too
    }
    return out;
  }

  const SAY = [
    "Found one! A platform: metal corners bounce my radar straight back, so it shines like a star.",
    "Another platform! Peek at BEFORE: it's in the same spot. Platforms stand on the sea floor and never move.",
    "Got it! Under the water, pipes carry oil and gas from platforms like this one to the land.",
    "Yes! Ships come and go, but a platform is in every radar picture. That's how I tell them apart.",
  ];
  const ring = (cls) => L.divIcon({ className: `quiz-pin ${cls}`, html: "<i></i>", iconSize: [26, 26], iconAnchor: [13, 13] });

  (window.SARbitGames = window.SARbitGames || {}).hunt = {
    start(api) {
      const M = api.M, map = api.map, img = M.layers.after_CO.data;
      const fx = M.ana.bw / img.width, fy = M.ana.bh / img.height;
      const targets = platforms(img, M.layers.before_CO.data)
        .map((p) => ({ ...p, ll: api.toLatLng((p.x + 0.5) * fx, (p.y + 0.5) * fy), found: false }));
      const maxHearts = api.cfg.hearts || 4;
      let hearts = maxHearts, hint = null, peek = null;
      M.hunt = { got: 0, total: targets.length };

      function setView(v) {
        if (peek) { map.removeLayer(peek); peek = null; }
        if (v !== "glow") peek = api.layer(L.imageOverlay(M.base + M.info[v].image, M.bounds, { interactive: false }));
        api.kit.querySelectorAll(".peek button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      }
      function render() {
        const got = targets.filter((t) => t.found).length;
        M.hunt.got = got;
        api.kit.innerHTML = `<p class="quiz-q">🛢️ Platform hunt! Find the tiny super-bright dots on the water. Found <b>${got}</b> of <b>${targets.length}</b>.</p>
          <p class="hearts">${"❤️".repeat(hearts)}${"🤍".repeat(maxHearts - hearts)}</p>
          <p class="muted">Zoom in with + or your fingers. Tapping plain water costs a heart; tapping land is free.</p>
          <p class="peek">👀 Show: <button class="ghost small" data-v="glow">✨ Glow</button>
            <button class="ghost small" data-v="before">BEFORE</button><button class="ghost small" data-v="after">AFTER</button>
            <button id="hunt-hint" class="ghost small">💡 Hint</button></p>`;
        api.kit.querySelectorAll(".peek button[data-v]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.v)));
        api.kit.querySelector("#hunt-hint").onclick = () => {
          const t = targets.find((q) => !q.found);
          if (!t) return;
          if (hint) map.removeLayer(hint);
          hint = api.layer(L.circle(t.ll, { radius: 900, color: "#7cf3c7", weight: 4, fillOpacity: 0.08, className: "hint-ring", interactive: false }));
          api.say("Look inside the blinking circle: a tiny bright dot is hiding there. Zoom in!");
        };
        const done = got === targets.length || !hearts;
        api.next(done ? "Score it ⭐" : "Finish early ⭐", true);
      }
      M.onTap = (ll) => {
        if (!hearts) return;
        const p = map.latLngToContainerPoint(ll);
        const t = targets.filter((q) => !q.found)
          .map((q) => ({ q, d: p.distanceTo(map.latLngToContainerPoint(q.ll)) })).sort((a, b) => a.d - b.d)[0];
        if (t && t.d <= REACH_PX) {
          t.q.found = true;
          api.layer(L.marker(t.q.ll, { icon: ring("ok"), interactive: false }));
          if (hint) { map.removeLayer(hint); hint = null; }
          api.award(`p${targets.indexOf(t.q)}`, PTS, t.q.ll); api.sfx("hit"); api.react("happy");
          const got = targets.filter((q) => q.found).length;
          api.say(got === targets.length ? "You found every platform! Amazing radar eyes! 🎉" : SAY[(got - 1) % SAY.length]);
          if (got === targets.length) api.sfx("win");
          return render();
        }
        // a miss: only plain water costs a heart (land is bright, so it can't hide a platform)
        const [bx, by] = api.toBlock(ll), s = M.huntStats = M.huntStats || api.blockStats("CO");
        const k = by * s.bw + bx, water = bx >= 0 && by >= 0 && bx < s.bw && by < s.bh && s.valid[k] && s.after[k] < -16;
        if (!water) { api.floatText(ll, "that's land", "meh"); return api.say("That's marsh or land. Platforms stand in the open water, on the dark part."); }
        hearts--; api.floatText(ll, "−❤️", "bad"); api.sfx("miss"); api.react("oops");
        api.say(hearts ? "Just water there. Look for a dot that shines like a tiny star!" : "Out of hearts! Let's see how you did.");
        render();
      };
      M.finishGame = () => {
        const got = targets.filter((t) => t.found).length, n = targets.length;
        api.done({ got, total: n, line: `You found <b>${got}</b> of <b>${n}</b> oil platforms` });
      };
      if (!targets.length) { api.say("I couldn't find platforms here."); return api.next("Score it ⭐", true); }
      api.say(`I can see ${targets.length} oil platforms hiding in the bay: tiny super-bright dots. Can you find them all? Zoom in and tap them!`);
      render(); setView("glow");
    },
  };
})();

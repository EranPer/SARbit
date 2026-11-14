/* SARbit game "quiz": numbered pins on the map; for each the player answers what the radar shows there.
   Answers come from the real NISAR values at the pin, so the quiz is never made up.
   content.json: "game": {"type": "quiz", "kind": "harvest" | "water", "pins": 8} */
(() => {
  "use strict";

  const KINDS = {
    // Jezreel-style: did the crop get harvested? (cross-pol HV drops when plants are cut)
    harvest: {
      channel: "CX",
      question: "Pin {n}: look at the glow. Was this field HARVESTED, or did it stay the same?",
      answers: [{ key: "yes", label: "🌾 Harvested" }, { key: "no", label: "🌱 Stayed the same" }],
      classify: (s, k) => { const d = s.after[k] - s.before[k]; return d <= -3 ? "yes" : Math.abs(d) <= 1 ? "no" : null; },
      explain: (s, p, truth) => { const d = (s.after[p.k] - s.before[p.k]).toFixed(1);
        return truth === "yes" ? `Its HV echo dropped ${-d} dB: the plants are gone, so it was harvested!`
          : `Its HV echo changed only ${d} dB: the field looks the same as in June.`; },
    },
    // is it water or land now? (open water is dark in HH)
    water: {
      channel: "CO",
      question: "Pin {n}: look at the AFTER picture. Is this place WATER or LAND now?",
      answers: [{ key: "water", label: "💧 Water" }, { key: "land", label: "🌿 Land" }],
      classify: (s, k) => (s.after[k] < -18 ? "water" : s.after[k] > -14 ? "land" : null),
      prefer: (s, k) => s.before[k] > -14 && s.after[k] < -18,   // land that turned into water: the story
      explain: (s, p, truth) => {
        const a = s.after[p.k].toFixed(0), b = s.before[p.k].toFixed(0);
        return truth === "water"
          ? `It's dark (${a} dB): smooth water bounces my radar away.${s.before[p.k] > -14 ? ` In June it was land (${b} dB): it turned into water!` : ""}`
          : `It's bright (${a} dB): land and plants send my radar back.`;
      },
    },
  };

  // ---------- pins on blocks (harvest, water) ----------
  // pick pins spread over the picture, half of each answer, preferring the ones that tell the story.
  // A pin goes only where its 3 x 3 blocks all agree, so it never sits on a lone odd block (a boat, a tiny island).
  function pickBlocks(api, kind, count) {
    const s = api.blockStats(kind.channel === "CX" && api.M.info.channels.CO !== api.M.info.channels.CX ? "CX" : "CO");
    const cls = new Array(s.bw * s.bh).fill(null);
    for (let k = 0; k < cls.length; k++) if (s.valid[k]) cls[k] = kind.classify(s, k);
    const same = (bx, by, c) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cls[(by + dy) * s.bw + bx + dx] !== c) return false; return true; };
    const margin = 3, [fx0, fy0, fx1, fy1] = api.M.focus, pools = {};
    for (let by = margin; by < s.bh - margin; by++) for (let bx = margin; bx < s.bw - margin; bx++) {
      const k = by * s.bw + bx, c = cls[k];
      if (!c || bx / s.bw < fx0 || bx / s.bw > fx1 || by / s.bh < fy0 || by / s.bh > fy1 || !same(bx, by, c)) continue;
      (pools[c] = pools[c] || []).push({ k, x: bx + 0.5, y: by + 0.5, truth: c, pref: kind.prefer ? kind.prefer(s, k) : false });
    }
    return { s, pins: spread(api, pools, kind.answers.map((a) => a.key), count, Math.max(6, s.bw / 7)) };
  }

  function spread(api, pools, keys, count, minGap) {
    let seed = [...api.M.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7);
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pins = [];
    for (let i = 0; pins.length < count && i < count * 4; i++) {
      const pool = (pools[keys[i % keys.length]] || []).slice().sort((a, b) => (b.pref - a.pref) || (rnd() - 0.5));
      const pick = pool.find((p) => pins.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= minGap));
      if (pick) pins.push(pick);
    }
    return pins.sort(() => rnd() - 0.5);
  }

  const pinIcon = (n, cls, size) => L.divIcon({ className: `quiz-pin ${cls}`, html: `<i></i><span>${n}</span>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

  window.SarbitQuizKinds = KINDS;
  (window.SARbitGames = window.SARbitGames || {}).quiz = {
    start(api) {
      const kind = KINDS[api.cfg.kind] || KINDS.harvest, M = api.M, count = api.cfg.pins || 8;
      const switched = kind.channel === "CX" && M.glasses !== "CX" && M.info.channels.CO !== M.info.channels.CX;
      if (switched) api.glasses("CX");   // the answers are read in the plants channel, so the player looks through it too
      const { s, pins } = pickBlocks(api, kind, count), size = 22;
      let i = 0, right = 0, peek = null, view = "glow";
      M.quiz = { right: 0, total: pins.length };
      const markers = pins.map((p, n) => api.layer(L.marker(api.toLatLng(p.x, p.y), { icon: pinIcon(n + 1, "", size), zIndexOffset: 500 })
        .on("click", () => { if (!p.done) { i = n; show(); } })));
      const fit = () => api.map.flyToBounds(M.bounds, { duration: 0.6 });
      M.cleanup = () => fit();

      // 👀 peek: the glow, or the plain BEFORE / AFTER radar picture, on top of the map
      function setView(v) {
        view = v;
        if (peek) { api.map.removeLayer(peek); peek = null; }
        if (v !== "glow") peek = api.layer(L.imageOverlay(M.base + M.info[v].image, M.bounds, { interactive: false }));
        api.kit.querySelectorAll(".peek button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      }
      function show() {
        markers.forEach((m, n) => m.setIcon(pinIcon(n + 1, pins[n].done ? (pins[n].ok ? "ok" : "bad") : n === i ? "now" : "", size)));
        api.map.flyTo(markers[i].getLatLng(), Math.min(api.map.getBoundsZoom(M.bounds) + 1.5, 16), { duration: 0.6 });
        api.kit.innerHTML = `<p class="quiz-q">${kind.question.replace("{n}", i + 1)}</p>
          <div class="quiz-a">${kind.answers.map((a) => `<button data-k="${a.key}">${a.label}</button>`).join("")}</div>
          <p class="peek">👀 Show: <button class="ghost small" data-v="glow">✨ Glow</button>
            <button class="ghost small" data-v="before">BEFORE</button><button class="ghost small" data-v="after">AFTER</button></p>
          <p class="muted">Pin ${pins.filter((q) => q.done).length + 1} of ${pins.length} · right so far: ${right}</p>`;
        api.kit.querySelectorAll("button[data-k]").forEach((b) => b.addEventListener("click", () => answer(b.dataset.k)));
        api.kit.querySelectorAll(".peek button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.v)));
        setView(view);
        api.say(kind.question.replace("{n}", i + 1));
      }
      function answer(key) {
        const p = pins[i];
        p.done = true; p.ok = key === p.truth;
        if (p.ok) { right++; M.quiz.right = right; api.award(`pin${i}`, 150, markers[i].getLatLng()); api.sfx("hit"); api.react("happy"); }
        else { api.sfx("miss"); api.react("oops"); }
        api.say((p.ok ? "Right! " : "Not quite. ") + kind.explain(s, p, p.truth));
        markers[i].setIcon(pinIcon(i + 1, p.ok ? "ok" : "bad", size));
        api.kit.querySelectorAll("button[data-k]").forEach((b) => (b.disabled = true));
        const nextPin = pins.findIndex((q) => !q.done);
        setTimeout(() => {
          if (M.step !== 3) return;
          if (nextPin < 0) { fit(); api.done({ got: right, total: pins.length, line: `You got <b>${right}</b> of <b>${pins.length}</b> pins right` }); }
          else { i = nextPin; show(); }
        }, 3200);
      }
      if (!pins.length) { api.say("I couldn't find good places to ask about here."); return api.next("Score it ⭐", true); }
      api.next("Finish early ⭐", true);
      show();
      if (switched) api.say(`I put on my ${M.info.channels.CX} glasses for this quiz: only leaves and crops twist my wave, so a field that went dark in ${M.info.channels.CX} lost its plants. ` + kind.question.replace("{n}", 1));
    },
    finish(api) {
      const q = api.M.quiz || { right: 0, total: api.cfg.pins || 8 };
      api.done({ got: q.right, total: q.total, line: `You got <b>${q.right}</b> of <b>${q.total}</b> pins right (and stopped early)` });
    },
  };
})();

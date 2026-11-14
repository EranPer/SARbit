/* SARbit game "quiz": numbered pins on the map; for each the player answers what the radar shows there.
   Answers come from the real NISAR values at the pin (per 8 x 8-pixel block), so the quiz is never made up.
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
      explain: (s, k, truth) => { const d = (s.after[k] - s.before[k]).toFixed(1);
        return truth === "yes" ? `Its HV echo dropped ${-d} dB: the plants are gone, so it was harvested!`
          : `Its HV echo changed only ${d} dB: the field looks the same as in June.`; },
    },
    // Mississippi-style: is it water or land now? (open water is dark in HH)
    water: {
      channel: "CO",
      question: "Pin {n}: look at the AFTER picture. Is this place WATER or LAND now?",
      answers: [{ key: "water", label: "💧 Water" }, { key: "land", label: "🌿 Land" }],
      classify: (s, k) => (s.after[k] < -18 ? "water" : s.after[k] > -14 ? "land" : null),
      prefer: (s, k) => s.before[k] > -14 && s.after[k] < -18,   // land that turned into water: the story
      explain: (s, k, truth) => {
        const a = s.after[k].toFixed(0), b = s.before[k].toFixed(0);
        return truth === "water"
          ? `It's dark (${a} dB): smooth water bounces my radar away.${s.before[k] > -14 ? ` In June it was land (${b} dB): the marsh turned into water!` : ""}`
          : `It's bright (${a} dB): land and plants send my radar back.`;
      },
    },
  };

  // pick pins spread over the picture, half of each answer, preferring the ones that tell the story
  function pickPins(api, kind, count) {
    const s = api.blockStats(kind.channel === "CX" && api.M.info.channels.CO !== api.M.info.channels.CX ? "CX" : "CO");
    const pools = {};
    const margin = 3, [fx0, fy0, fx1, fy1] = api.M.focus;
    for (let by = margin; by < s.bh - margin; by++) for (let bx = margin; bx < s.bw - margin; bx++) {
      const k = by * s.bw + bx;
      if (!s.valid[k] || bx / s.bw < fx0 || bx / s.bw > fx1 || by / s.bh < fy0 || by / s.bh > fy1) continue;
      const c = kind.classify(s, k);
      if (!c) continue;
      (pools[c] = pools[c] || []).push({ k, bx, by, truth: c, pref: kind.prefer ? kind.prefer(s, k) : false });
    }
    let seed = [...api.M.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7);
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const minGap = Math.max(6, s.bw / 7), pins = [];
    const keys = kind.answers.map((a) => a.key);
    for (let i = 0; pins.length < count && i < count * 4; i++) {
      const pool = (pools[keys[i % keys.length]] || []).slice().sort((a, b) => (b.pref - a.pref) || (rnd() - 0.5));
      const pick = pool.find((p) => pins.every((q) => Math.hypot(p.bx - q.bx, p.by - q.by) >= minGap));
      if (pick) pins.push(pick);
    }
    return { s, pins: pins.sort(() => rnd() - 0.5) };
  }

  const pinIcon = (n, cls) => L.divIcon({ className: `quiz-pin ${cls}`, html: `<span>${n}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  window.SarbitQuizKinds = KINDS;
  (window.SARbitGames = window.SARbitGames || {}).quiz = {
    start(api) {
      const kind = KINDS[api.cfg.kind] || KINDS.harvest;
      const { s, pins } = pickPins(api, kind, api.cfg.pins || 8);
      const M = api.M;
      let i = 0, right = 0;
      M.quiz = { right: 0, total: pins.length };
      const markers = pins.map((p, n) => api.layer(L.marker(api.toLatLng(p.bx + 0.5, p.by + 0.5), { icon: pinIcon(n + 1, "") })
        .on("click", () => { if (!p.done) { i = n; show(); } })));
      const fit = () => api.map.flyToBounds(M.bounds, { duration: 0.6 });
      M.cleanup = () => fit();

      function show() {
        const p = pins[i];
        markers.forEach((m, n) => m.setIcon(pinIcon(n + 1, pins[n].done ? (pins[n].ok ? "ok" : "bad") : n === i ? "now" : "")));
        api.map.flyTo(markers[i].getLatLng(), Math.min(api.map.getBoundsZoom(M.bounds) + 1.5, 16), { duration: 0.6 });
        api.kit.innerHTML = `<p class="quiz-q">${kind.question.replace("{n}", i + 1)}</p>
          <div class="quiz-a">${kind.answers.map((a) => `<button data-k="${a.key}">${a.label}</button>`).join("")}</div>
          <p class="muted">Pin ${pins.filter((q) => q.done).length + 1} of ${pins.length} · right so far: ${right}</p>`;
        api.kit.querySelectorAll("button[data-k]").forEach((b) => b.addEventListener("click", () => answer(b.dataset.k)));
        api.say(kind.question.replace("{n}", i + 1));
      }
      function answer(key) {
        const p = pins[i];
        p.done = true; p.ok = key === p.truth;
        if (p.ok) { right++; M.quiz.right = right; api.award(`pin${i}`, 150, markers[i].getLatLng()); api.sfx("hit"); api.react("happy"); }
        else { api.sfx("miss"); api.react("oops"); }
        api.say((p.ok ? "Right! " : "Not quite. ") + kind.explain(s, p.k, p.truth));
        markers[i].setIcon(pinIcon(i + 1, p.ok ? "ok" : "bad"));
        api.kit.querySelectorAll("button[data-k]").forEach((b) => (b.disabled = true));
        const nextPin = pins.findIndex((q) => !q.done);
        setTimeout(() => {
          if (nextPin < 0) { fit(); api.done({ got: right, total: pins.length, line: `You got <b>${right}</b> of <b>${pins.length}</b> pins right` }); }
          else { i = nextPin; show(); }
        }, 2200);
      }
      if (!pins.length) { api.say("I couldn't find good places to ask about here."); return api.next("Score it ⭐", true); }
      api.next("Finish early ⭐", true);
      show();
    },
    finish(api) {
      const q = api.M.quiz || { right: 0, total: api.cfg.pins || 8 };
      api.done({ got: q.right, total: q.total, line: `You got <b>${q.right}</b> of <b>${q.total}</b> pins right (and stopped early)` });
    },
  };
})();

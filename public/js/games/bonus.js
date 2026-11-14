/* SARbit bonus round after "find the spots": a question about the real places around the change (OpenStreetMap).
   content.json: "bonus": {"type": "town", "question": "...", "explain": "... {town} ... {km} ..."}
   The answer is the town closest to the biggest glowing spot, worked out from osm.geojson (pipeline/osm_layers.py). */
(() => {
  "use strict";
  const icon = (name, cls) => L.divIcon({ className: `town-pin ${cls || ""}`, html: `<b>${name}</b>`, iconSize: [0, 0] });

  (window.SARbitBonus = window.SARbitBonus || {}).town = {
    async start(api) {
      const M = api.M, a = api.analysis(), cfg = api.cfg, big = a.targets[0], g = await api.osm();
      const area = M.bounds.pad(0.05);
      let places = (g ? g.features : []).filter((f) => f.properties.kind === "town" && !/island|islet/.test(f.properties.place));
      if (places.filter((f) => /city|town|village/.test(f.properties.place)).length >= 3) places = places.filter((f) => /city|town|village/.test(f.properties.place));
      const towns = places
        .map((f) => ({ name: f.properties.name.replace(/\s*\(.*\)$/, ""), ll: L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
        .filter((t) => area.contains(t.ll));
      if (!big || towns.length < 2) return api.done();

      // distance from each town to the nearest block of the biggest glowing spot
      const cells = big.cells.map((j) => api.toLatLng((j % a.bw) + 0.5, ((j / a.bw) | 0) + 0.5));
      towns.forEach((t) => (t.d = Math.min(...cells.map((c) => c.distanceTo(t.ll)))));
      towns.sort((x, y) => x.d - y.d);
      const right = towns[0];
      const others = towns.slice(1).filter((t) => t.d >= right.d * 2 + 2500).slice(0, 2);   // clearly farther, so it's fair
      let seed = [...M.id].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 3);
      const choices = [right, ...others].sort(() => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5);

      // show the biggest spot and the town choices
      const centre = api.toLatLng(big.cx + 0.5, big.cy + 0.5);
      api.layer(L.circle(centre, { radius: Math.max(400, 1.3 * Math.sqrt(big.size / Math.PI) * centre.distanceTo(api.toLatLng(big.cx + 1.5, big.cy + 0.5))),
        color: "#ffe14a", weight: 4, fillOpacity: 0.06, className: "hint-ring", interactive: false }));
      const markers = choices.map((t) => api.layer(L.marker(t.ll, { icon: icon(t.name), zIndexOffset: 800 }).on("click", () => answer(t))));
      api.map.flyToBounds(L.latLngBounds([centre, ...choices.map((t) => t.ll)]).pad(0.25), { duration: 0.6 });
      api.setLayer("towns", false);   // only the choices, so the map stays readable

      api.kit.innerHTML = `<p class="quiz-q">⭐ Bonus: ${cfg.question}</p>
        <div class="quiz-a">${choices.map((t, n) => `<button data-n="${n}">${t.name}</button>`).join("")}</div>
        <p class="muted">The yellow ring is the biggest glowing spot. Town names: © OpenStreetMap contributors.</p>`;
      api.kit.querySelectorAll("button[data-n]").forEach((b) => b.addEventListener("click", () => answer(choices[+b.dataset.n])));
      api.say(`Bonus question! ${cfg.question} Tap a town on the map or below.`);
      api.next("Skip the bonus ⭐", true);

      let answered = false;
      function answer(t) {
        if (answered) return;
        answered = true;
        const ok = t === right, km = (right.d / 1000).toFixed(1);
        markers.forEach((m, n) => m.setIcon(icon(choices[n].name, choices[n] === right ? "ok" : choices[n] === t ? "bad" : "")));
        api.layer(L.polyline([centre, right.ll], { color: "#4be08a", weight: 3, dashArray: "6 6", interactive: false }));
        if (ok) { api.award("bonus", 200, right.ll); api.sfx("win"); api.react("happy"); } else { api.sfx("miss"); api.react("oops"); }
        const why = (cfg.explain || "{town} is only {km} km from the biggest change.").replace("{town}", right.name).replace("{km}", km);
        api.say((ok ? "Yes! +200. " : `It's ${right.name}. `) + why);
        api.kit.querySelectorAll("button[data-n]").forEach((b) => (b.disabled = true));
        M.bonusLine = ok ? `⭐ Bonus: you found ${right.name}!` : `Bonus: it was ${right.name}.`;
        api.setLayer("towns", true);
        api.next("Score it ⭐", true);
      }
    },
  };
})();

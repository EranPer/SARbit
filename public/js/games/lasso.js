/* SARbit game "lasso": draw loops around the places that glow (e.g. forest clearings next to roads).
   Score = how well the loops cover the real change (found share) without wrapping too much that didn't change.
   content.json: "game": {"type": "lasso", "loops": 3, "roads": "roads.geojson"} */
(() => {
  "use strict";

  function inside(pt, poly) {   // ray casting, pt and poly in block coordinates
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  (window.SARbitGames = window.SARbitGames || {}).lasso = {
    start(api) {
      const M = api.M, map = api.map, el = map.getContainer(), maxLoops = api.cfg.loops || 3;
      const loops = [];   // each: { latlngs, shape }
      let drawing = null;

      if (api.cfg.roads) fetch(M.base + api.cfg.roads).then((r) => r.json()).then((g) => {
        api.layer(L.geoJSON(g, { interactive: false, style: (f) => ({
          color: /trunk|primary/.test(f.properties.highway) ? "#ffe14a" : "#ffffff",
          weight: /trunk|primary/.test(f.properties.highway) ? 4 : 1.5, opacity: 0.8 }) }));
      }).catch(() => {});

      map.dragging.disable();
      const ll = (e) => map.mouseEventToLatLng(e.touches ? e.touches[0] : e);
      const down = (e) => {
        if (loops.length >= maxLoops || e.target.closest(".leaflet-control")) return;
        e.preventDefault();
        drawing = { latlngs: [ll(e)] };
        drawing.shape = api.layer(L.polyline(drawing.latlngs, { color: "#7cf3c7", weight: 4, dashArray: "6 6", interactive: false }));
      };
      const move = (e) => {
        if (!drawing) return;
        e.preventDefault();
        drawing.latlngs.push(ll(e)); drawing.shape.setLatLngs(drawing.latlngs);
      };
      const up = () => {
        if (!drawing) return;
        const d = drawing; drawing = null;
        map.removeLayer(d.shape);
        if (d.latlngs.length < 8) return api.say("Draw a bigger loop: press, drag all the way around the glow, and let go.");
        d.shape = api.layer(L.polygon(d.latlngs, { color: "#7cf3c7", weight: 3, fillColor: "#7cf3c7", fillOpacity: 0.12, interactive: false }));
        loops.push(d); api.sfx("meh"); render();
      };
      el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      el.style.touchAction = "none";
      M.cleanup = () => {
        el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up); el.style.touchAction = ""; map.dragging.enable();
      };

      function render() {
        api.kit.innerHTML = `<p class="quiz-q">Draw a loop around each patch of cut forest that glows. You have ${maxLoops} loops.</p>
          <p class="hearts">${"⭕".repeat(loops.length)}${"◌".repeat(maxLoops - loops.length)}</p>
          <p class="muted">Yellow line = the BR-163 highway; white lines = side roads. Do you see where the clearings are?</p>
          <div class="actions"><button id="ls-undo" class="ghost small" ${loops.length ? "" : "disabled"}>↩ Undo loop</button></div>`;
        api.kit.querySelector("#ls-undo").onclick = () => { const d = loops.pop(); if (d) map.removeLayer(d.shape); render(); };
        api.next(loops.length ? "Check my loops ⭐" : "Draw a loop first", loops.length > 0);
      }

      M.finishGame = () => {
        const a = api.analysis(), polys = loops.map((d) => d.latlngs.map((p) => { const [x, y] = api.toBlock(p); return [x + 0.5, y + 0.5]; }));
        let changed = 0, caught = 0, wrapped = 0;
        for (let by = 0; by < a.bh; by++) for (let bx = 0; bx < a.bw; bx++) {
          const c = a.changed[by * a.bw + bx], inAny = polys.some((p) => inside([bx + 0.5, by + 0.5], p));
          changed += c; if (inAny) { wrapped++; caught += c; }
        }
        const found = changed ? caught / changed : 0, tidy = wrapped ? caught / wrapped : 0;
        const f1 = found + tidy ? (2 * found * tidy) / (found + tidy) : 0;
        const stars = f1 >= 0.45 ? 3 : f1 >= 0.3 ? 2 : f1 >= 0.12 ? 1 : 0;
        api.award("lasso", Math.round(f1 * 1000));
        api.done({ got: stars, total: 3, stars, line: `Your loops caught <b>${Math.round(found * 100)} %</b> of the cut forest, and <b>${Math.round(tidy * 100)} %</b> of what you circled really changed` });
      };
      api.say("Draw loops around the places that glow: press on the map and drag around them, like a lasso. Clearings follow the roads!");
      render();
    },
  };
})();

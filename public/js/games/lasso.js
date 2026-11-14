/* SARbit game "lasso": catch the glowing patches (e.g. forest clearings along roads) with loops.
   A loop catches every patch that is at least half inside it, right away, so the player sees what each loop got.
   Tidy loops (mostly glow inside) earn a bonus; a giant loop around everything doesn't count.
   content.json: "game": {"type": "lasso", "loops": 4, "roads": "roads.geojson"} (roads optional: else OSM roads) */
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
  const PTS = { patch: 150, tidy: 50 }, HALF = 0.5, TOO_BIG = 0.25;   // a loop over > 25 % of the picture is too big

  (window.SARbitGames = window.SARbitGames || {}).lasso = {
    start(api) {
      const M = api.M, map = api.map, el = map.getContainer(), a = api.analysis(), targets = a.targets;
      const maxLoops = api.cfg.loops || Math.max(3, Math.ceil(targets.length / 2));
      const loops = [];          // each: { shape, ids: [patch ids caught by this loop] }
      const caught = new Set();  // patch ids
      let drawing = null, caughtLayer = null;

      if (api.cfg.roads) fetch(M.base + api.cfg.roads).then((r) => r.json()).then((g) => {
        api.layer(L.geoJSON(g, { pane: "osm", interactive: false, attribution: "© OpenStreetMap contributors", style: (f) => ({
          color: /trunk|primary/.test(f.properties.highway) ? "#ffe14a" : "#ffffff",
          weight: /trunk|primary/.test(f.properties.highway) ? 4 : 1.5, opacity: 0.8 }) }));
      }).catch(() => {});
      else api.setLayer("roads", true);

      function drawCaught() {   // caught patches turn green, block by block
        const cv = document.createElement("canvas"); cv.width = a.bw; cv.height = a.bh;
        const g = cv.getContext("2d"), img = g.createImageData(a.bw, a.bh);
        targets.forEach((t) => caught.has(t.id) && t.cells.forEach((j) => {
          img.data.set([75, 224, 138, 160], j * 4);
        }));
        g.putImageData(img, 0, 0);
        if (caughtLayer) map.removeLayer(caughtLayer);
        caughtLayer = api.layer(L.imageOverlay(cv.toDataURL(), M.bounds, { className: "pixel-layer", interactive: false }));
      }

      map.dragging.disable();
      const ll = (e) => map.mouseEventToLatLng(e.touches ? e.touches[0] : e);
      const down = (e) => {
        if (loops.length >= maxLoops || caught.size === targets.length || e.target.closest(".leaflet-control")) return;
        e.preventDefault();
        drawing = { latlngs: [ll(e)] };
        drawing.shape = L.polyline(drawing.latlngs, { color: "#7cf3c7", weight: 4, interactive: false }).addTo(map);
        drawing.start = L.circleMarker(drawing.latlngs[0], { radius: 7, color: "#7cf3c7", weight: 3, fillOpacity: 0.3, interactive: false }).addTo(map);
      };
      const move = (e) => {
        if (!drawing) return;
        e.preventDefault();
        drawing.latlngs.push(ll(e)); drawing.shape.setLatLngs(drawing.latlngs);
      };
      const up = () => {
        if (!drawing) return;
        const d = drawing; drawing = null;
        map.removeLayer(d.shape); map.removeLayer(d.start);
        if (d.latlngs.length < 8) return api.say("Draw a bigger loop: press, drag all the way around a glowing patch, and let go.");
        closeLoop(d.latlngs);
      };
      el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      el.style.touchAction = "none";
      M.cleanup = () => {
        el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up); el.style.touchAction = ""; map.dragging.enable();
      };

      function closeLoop(latlngs) {
        const poly = latlngs.map((p) => { const [x, y] = api.toBlock(p); return [x + 0.5, y + 0.5]; });
        const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
        let wrapped = 0, glowing = 0;
        for (let by = Math.max(0, Math.floor(Math.min(...ys))); by <= Math.min(a.bh - 1, Math.ceil(Math.max(...ys))); by++)
          for (let bx = Math.max(0, Math.floor(Math.min(...xs))); bx <= Math.min(a.bw - 1, Math.ceil(Math.max(...xs))); bx++)
            if (inside([bx + 0.5, by + 0.5], poly)) { wrapped++; glowing += a.changed[by * a.bw + bx]; }
        const centre = L.latLngBounds(latlngs).getCenter();
        if (wrapped > a.bw * a.bh * TOO_BIG) {
          api.sfx("miss"); api.react("oops"); api.floatText(centre, "too big!", "bad");
          return api.say("Whoa, that loop is huge! A forest ranger needs the exact places. Draw smaller loops right around the glow.");
        }
        const ids = targets.filter((t) => !caught.has(t.id) &&
          t.cells.filter((j) => inside([(j % a.bw) + 0.5, ((j / a.bw) | 0) + 0.5], poly)).length >= t.size * HALF).map((t) => t.id);
        const tidy = wrapped ? glowing / wrapped : 0;
        const shape = api.layer(L.polygon(latlngs, { color: ids.length ? "#7cf3c7" : "#9aa6cf", weight: 3,
          fillColor: "#7cf3c7", fillOpacity: ids.length ? 0.1 : 0.03, interactive: false }));
        loops.push({ shape, ids });
        ids.forEach((id) => caught.add(id));
        if (ids.length) {
          const pts = ids.length * (PTS.patch + (tidy >= 0.4 ? PTS.tidy : 0));
          api.award(`loop${loops.length}`, pts, centre);
          api.sfx("hit"); api.react("happy"); drawCaught();
          api.say(`Caught ${ids.length === 1 ? "a clearing" : `${ids.length} clearings`}!` +
            (tidy >= 0.4 ? " Nice tight loop: +50 tidy bonus each." : " Tip: tighter loops around the glow get a tidy bonus.") +
            (caught.size === targets.length ? " That's all of them! 🎉" : ""));
          if (caught.size === targets.length) api.sfx("win");
        } else {
          api.sfx("miss"); api.react("oops"); api.floatText(centre, "empty loop", "meh");
          api.say(glowing ? "That loop only got the edge of a patch. Go all the way around the glow!" : "Nothing glowing inside that loop. Look for strong red near the roads!");
        }
        render();
      }

      function render() {
        const left = maxLoops - loops.length, done = !left || caught.size === targets.length;
        api.kit.innerHTML = `<p class="quiz-q">Catch the cut forest! Draw a loop around each glowing patch. Caught <b>${caught.size}</b> of <b>${targets.length}</b>.</p>
          <p class="hearts">${"⭕".repeat(loops.length)}${"◌".repeat(left)}</p>
          <p class="muted">Yellow line = the BR-163 highway; white lines = side roads. Clearings grow along the roads.</p>
          <div class="actions"><button id="ls-undo" class="ghost small" ${loops.length ? "" : "disabled"}>↩ Undo loop</button></div>`;
        api.kit.querySelector("#ls-undo").onclick = () => {
          const d = loops.pop(); if (!d) return;
          map.removeLayer(d.shape); d.ids.forEach((id) => caught.delete(id)); drawCaught(); render();
        };
        api.next(done ? "Score it ⭐" : "Finish early ⭐", true);
      }

      M.finishGame = () => {
        const n = targets.length, got = caught.size;
        const stars = got === n ? 3 : got >= n / 2 ? 2 : got >= 1 ? 1 : 0;
        api.done({ got, total: n, stars, line: `You caught <b>${got}</b> of <b>${n}</b> clearings with <b>${loops.length}</b> ${loops.length === 1 ? "loop" : "loops"}` });
      };
      api.say(`I see ${targets.length} big patches of cut forest. You have ${maxLoops} loops: press on the map and drag around a glowing patch, like a lasso. One loop can catch more than one!`);
      render();
    },
  };
})();

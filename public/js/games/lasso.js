/* SARbit game "lasso": catch the glowing patches (e.g. forest clearings along roads) with loops.
   A loop catches every patch that is at least half inside it, right away, so the player sees what each loop got.
   Tidy loops (mostly glow inside) earn a bonus; a giant loop around everything doesn't count.
   Two modes, so the map can still move: ✏️ Draw (drag = loop) and ✋ Move (drag = pan). Holding Space also pans,
   and two fingers always pinch / pan on a phone.
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
  const STEP_PX = 4, MIN_PATH_PX = 80;   // add a point every 4 px; a loop needs at least 80 px of drawing

  (window.SARbitGames = window.SARbitGames || {}).lasso = {
    start(api) {
      const M = api.M, map = api.map, el = map.getContainer(), a = api.analysis(), targets = a.targets;
      const maxLoops = api.cfg.loops || Math.max(3, Math.ceil(targets.length / 2));
      const loops = [];          // each: { shape, ids, key, pts }
      const caught = new Set();  // patch ids
      const pointers = new Set();
      let drawing = null, caughtLayer = null, hintLayer = null, mode = "draw", spaceHeld = false, loopNo = 0;

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

      // ---- Draw / Move ----
      const drawingOn = () => mode === "draw" && !spaceHeld;
      function applyMode() {
        if (drawingOn()) { map.stop(); map.dragging.disable(); el.style.cursor = "crosshair"; }   // stop() ends a pan still gliding
        else { cancelDrawing(); map.dragging.enable(); el.style.cursor = ""; }
        const d = api.kit.querySelector("#ls-draw"), m = api.kit.querySelector("#ls-move");
        if (d) { d.classList.toggle("on", drawingOn()); m.classList.toggle("on", !drawingOn()); }
      }
      function setMode(m) { mode = m; applyMode(); }

      // ---- drawing a loop ----
      const ll = (e) => map.mouseEventToLatLng(e);
      const px = (e) => map.mouseEventToContainerPoint(e);
      function cancelDrawing() {
        if (!drawing) return;
        map.removeLayer(drawing.shape); map.removeLayer(drawing.start); drawing = null;
      }
      const down = (e) => {
        pointers.add(e.pointerId);
        if (pointers.size > 1) return cancelDrawing();   // two fingers: Leaflet pinches and pans, no loop
        if (!drawingOn() || (e.pointerType === "mouse" && e.button !== 0) || e.target.closest(".leaflet-control")) return;
        if (caught.size === targets.length) return;
        if (loops.length >= maxLoops) {
          api.react("oops");
          return api.say("No loops left! Press Undo loop to try one again, or ⭐ Score it.");
        }
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
        const p = ll(e);
        drawing = { id: e.pointerId, latlngs: [p], last: px(e), path: 0 };
        drawing.shape = L.polygon([p], { color: "#7cf3c7", weight: 4, fillColor: "#7cf3c7", fillOpacity: 0.12,
          dashArray: null, interactive: false }).addTo(map);
        drawing.start = L.circleMarker(p, { radius: 7, color: "#7cf3c7", weight: 3, fillOpacity: 0.3, interactive: false }).addTo(map);
      };
      const move = (e) => {
        if (!drawing || e.pointerId !== drawing.id) return;
        e.preventDefault();
        const q = px(e), d = q.distanceTo(drawing.last);
        if (d < STEP_PX) return;
        drawing.path += d; drawing.last = q;
        drawing.latlngs.push(ll(e)); drawing.shape.setLatLngs(drawing.latlngs);   // drawn closed, so the loop is always a loop
      };
      const up = (e) => {
        pointers.delete(e.pointerId);
        if (!drawing || e.pointerId !== drawing.id) return;
        const d = drawing; drawing = null;
        map.removeLayer(d.shape); map.removeLayer(d.start);
        if (e.type === "pointercancel") return;
        if (d.path < MIN_PATH_PX || d.latlngs.length < 6)
          return api.say("Draw a bigger loop: press, drag all the way around a glowing patch, and let go. (To move the map, press ✋ Move map.)");
        closeLoop(d.latlngs);
      };
      const key = (e) => {
        if (e.code !== "Space" || /input|textarea/i.test((e.target.tagName || ""))) return;
        e.preventDefault();
        const held = e.type === "keydown";
        if (held !== spaceHeld) { spaceHeld = held; applyMode(); }
      };
      el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
      window.addEventListener("keydown", key); window.addEventListener("keyup", key);
      M.cleanup = () => {
        cancelDrawing(); clearHint();
        el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key); window.removeEventListener("keyup", key);
        el.style.cursor = ""; map.dragging.enable();
      };

      function setPoints() { const p = document.getElementById("m-points"); if (p) p.textContent = M.points; }

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
          return api.say("Whoa, that loop is huge! A forest ranger needs the exact places. Draw smaller loops right around the glow. (That one didn't use up a loop.)");
        }
        const ids = targets.filter((t) => !caught.has(t.id) &&
          t.cells.filter((j) => inside([(j % a.bw) + 0.5, ((j / a.bw) | 0) + 0.5], poly)).length >= t.size * HALF).map((t) => t.id);
        const tidy = wrapped ? glowing / wrapped : 0;
        const shape = api.layer(L.polygon(latlngs, { color: ids.length ? "#7cf3c7" : "#9aa6cf", weight: 3,
          fillColor: "#7cf3c7", fillOpacity: ids.length ? 0.1 : 0.03, interactive: false }));
        const loop = { shape, ids, key: `loop${++loopNo}`, pts: 0 };
        loops.push(loop);
        ids.forEach((id) => caught.add(id));
        clearHint();
        if (ids.length) {
          loop.pts = ids.length * (PTS.patch + (tidy >= 0.4 ? PTS.tidy : 0));
          api.award(loop.key, loop.pts, centre);
          api.sfx("hit"); api.react("happy"); drawCaught();
          api.say(`Caught ${ids.length === 1 ? "a clearing" : `${ids.length} clearings`}!` +
            (tidy >= 0.4 ? " Nice tight loop: +50 tidy bonus each." : " Tip: tighter loops around the glow get a tidy bonus.") +
            (caught.size === targets.length ? " That's all of them! 🎉" : ""));
          if (caught.size === targets.length) { api.sfx("win"); setMode("move"); }
        } else {
          api.sfx("miss"); api.react("oops"); api.floatText(centre, "empty loop", "meh");
          api.say(glowing ? "That loop only got the edge of a patch. Go all the way around the glow! (Undo loop gives it back.)"
            : "Nothing glowing inside that loop. Look for strong red near the roads! (Undo loop gives it back.)");
        }
        render();
      }

      function undo() {
        const d = loops.pop(); if (!d) return;
        map.removeLayer(d.shape); d.ids.forEach((id) => caught.delete(id));
        if (d.pts && M.got[d.key]) { delete M.got[d.key]; M.points -= d.pts; setPoints(); }   // the points go back too
        drawCaught(); render();
      }

      // 💡 hint: ring the biggest patch not caught yet and fly there, so off-screen ones can be found too
      function clearHint() { if (hintLayer) { map.removeLayer(hintLayer); hintLayer = null; } }
      function hint() {
        const t = targets.find((x) => !caught.has(x.id)); if (!t) return;
        let sx = 0, sy = 0; t.cells.forEach((j) => { sx += (j % a.bw) + 0.5; sy += ((j / a.bw) | 0) + 0.5; });
        const c = api.toLatLng(sx / t.cells.length, sy / t.cells.length);
        const r = Math.sqrt(t.cells.length) * 0.9;   // in blocks, a little bigger than the patch
        const edge = api.toLatLng(sx / t.cells.length + r, sy / t.cells.length);
        clearHint();
        hintLayer = L.circle(c, { radius: c.distanceTo(edge), color: "#ffe14a", weight: 3, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
        if (!map.getBounds().pad(-0.1).contains(c)) map.panTo(c);
        api.say("Look inside the yellow ring: draw your loop around the red glow there.");
      }

      function render() {
        const left = maxLoops - loops.length, done = !left || caught.size === targets.length;
        api.kit.innerHTML = `<p class="quiz-q">Catch the cut forest! Draw a loop around each glowing patch. Caught <b>${caught.size}</b> of <b>${targets.length}</b>.</p>
          <p class="hearts">${"⭕".repeat(loops.length)}${"◌".repeat(left)}</p>
          <div class="seg" role="group" aria-label="What dragging the map does">
            <button id="ls-draw" class="ghost small">✏️ Draw loops</button><button id="ls-move" class="ghost small">✋ Move map</button>
          </div>
          <p class="muted small">Tip: hold <b>Space</b> (or use two fingers) to move the map while drawing.</p>
          <p class="muted">Yellow line = the BR-163 highway; white lines = side roads. Clearings grow along the roads.</p>
          <div class="actions">
            <button id="ls-undo" class="ghost small" ${loops.length ? "" : "disabled"}><img class="ico" src="art/ui-undo.webp" alt="">Undo loop</button>
            <button id="ls-hint" class="ghost small" ${caught.size === targets.length ? "disabled" : ""}><img class="ico" src="art/ui-hint.webp" alt="">Hint</button>
          </div>`;
        api.kit.querySelector("#ls-undo").onclick = undo;
        api.kit.querySelector("#ls-hint").onclick = hint;
        api.kit.querySelector("#ls-draw").onclick = () => setMode("draw");
        api.kit.querySelector("#ls-move").onclick = () => setMode("move");
        applyMode();
        api.next(done ? "Score it ⭐" : "Finish early ⭐", true);
      }

      M.finishGame = () => {
        const n = targets.length, got = caught.size;
        const stars = got === n ? 3 : got >= n / 2 ? 2 : got >= 1 ? 1 : 0;
        api.done({ got, total: n, stars, line: `You caught <b>${got}</b> of <b>${n}</b> clearings with <b>${loops.length}</b> ${loops.length === 1 ? "loop" : "loops"}` });
      };
      api.say(`I see ${targets.length} big patches of cut forest. You have ${maxLoops} loops: press on the map and drag around a glowing patch, like a lasso. One loop can catch more than one! To look around, press ✋ Move map.`);
      render();
    },
  };
})();

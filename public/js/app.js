/* SARbit · radar cleanup. Plain JS + Leaflet. Data: /missions/ (made by pipeline/, see public/missions/README.md). */
(() => {
  "use strict";

  const TOPICS = {
    floods: { color: "#5aa8ff", label: "Floods & water" },
    forest: { color: "#4be08a", label: "Forests" },
    agriculture: { color: "#ffc24a", label: "Agriculture" },
    land: { color: "#ff8a3d", label: "Land & fire" },
    marine: { color: "#c08cff", label: "Oceans & coasts" },
  };
  const GRID = 12;
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const ESRI_ATTR = "Imagery © Esri · Radar: NASA-ISRO NISAR (ASF DAAC)";

  // ---------- small helpers ----------
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, kids = []) => {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => (k === "text" ? (e.textContent = v) : e.setAttribute(k, v)));
    kids.forEach((k) => e.appendChild(k));
    return e;
  };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("sarbit." + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("sarbit." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const show = (id) => {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    setTimeout(() => { worldMap && worldMap.invalidateSize(); missionMap && missionMap.invalidateSize(); }, 50);
  };
  const loadImage = (src) => new Promise((ok, fail) => {
    const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src;
  });
  const pixels = (img) => {
    const c = el("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };

  // ---------- the alien (SVG, swap for illustrated art later) ----------
  const ALIEN = `
  <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><g class="float">
    <line x1="100" y1="38" x2="100" y2="14" stroke="#7cf3c7" stroke-width="4"/>
    <path d="M84 16 Q100 0 116 16" fill="none" stroke="#7cf3c7" stroke-width="4"/>
    <circle cx="100" cy="12" r="4" fill="#fff"/>
    <ellipse cx="100" cy="82" rx="52" ry="46" fill="#7cf3c7"/>
    <ellipse cx="80" cy="78" rx="15" ry="18" fill="#0b1020"/><ellipse cx="120" cy="78" rx="15" ry="18" fill="#0b1020"/>
    <circle cx="85" cy="72" r="5" fill="#fff"/><circle cx="125" cy="72" r="5" fill="#fff"/>
    <path d="M86 104 Q100 114 114 104" fill="none" stroke="#0b1020" stroke-width="4" stroke-linecap="round"/>
    <ellipse cx="100" cy="150" rx="78" ry="20" fill="#5aa8ff"/>
    <ellipse cx="100" cy="142" rx="44" ry="12" fill="#b9d8ff" opacity=".8"/>
    <circle cx="52" cy="152" r="4" fill="#ffc24a"/><circle cx="100" cy="160" r="4" fill="#ff5a5a"/><circle cx="148" cy="152" r="4" fill="#4be08a"/>
  </g></svg>`;
  ["#alien-intro", "#alien-guide", "#alien-end"].forEach((s) => ($(s).innerHTML = ALIEN));

  // ---------- state ----------
  let missions = [];
  let player = store.get("player", "");
  let scores = store.get("scores", {});   // { missionId: best points }
  let worldMap = null, missionMap = null;
  let M = null;                            // the open mission

  const total = () => Object.values(scores).reduce((a, b) => a + b, 0);
  const updateHud = () => {
    $("#hud").hidden = !player;
    $("#hud-name").textContent = player;
    $("#hud-score").textContent = total();
  };

  // ---------- intro ----------
  $("#name-input").value = player;
  $("#name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    player = $("#name-input").value.trim().slice(0, 20) || "Cadet";
    store.set("player", player);
    updateHud(); openWorld();
  });

  // ---------- world map ----------
  async function openWorld() {
    show("screen-world");
    if (!missions.length) missions = await (await fetch("missions/index.json")).json();
    if (!worldMap) {
      worldMap = L.map("world-map", { worldCopyJump: true, minZoom: 2 }).setView([20, 20], 2);
      L.tileLayer(ESRI, { attribution: ESRI_ATTR, maxZoom: 18 }).addTo(worldMap);
    }
    worldMap.eachLayer((l) => l instanceof L.CircleMarker && worldMap.removeLayer(l));
    const list = $("#mission-list"); list.innerHTML = "";
    missions.forEach((m) => {
      const t = TOPICS[m.topic] || { color: "#fff", label: m.topic };
      const done = m.id in scores;
      L.circleMarker([m.lat, m.lon], { radius: 9, color: "#fff", weight: 2, fillColor: t.color, fillOpacity: done ? .4 : .95 })
        .addTo(worldMap).bindTooltip(`${m.title} · ${t.label}`).on("click", () => openMission(m.id));
      const li = el("li", { class: done ? "done" : "" }, [
        el("span", { class: "chip", style: `background:${t.color}` }),
        el("span", { text: m.title }),
        el("span", { class: "pts", text: done ? `★ ${scores[m.id]}` : "" }),
      ]);
      li.addEventListener("click", () => openMission(m.id));
      list.appendChild(li);
    });
    drawBoard();
  }

  function drawBoard() {
    const board = store.get("board", []);
    $("#board-list").innerHTML = board.length
      ? board.map((b) => `<li><b>${b.name.replace(/[<>&]/g, "")}</b> · ${b.score}</li>`).join("")
      : "<li>No finished runs yet</li>";
  }

  // ---------- mission ----------
  async function openMission(id) {
    show("screen-mission");
    const base = `missions/${id}/`;
    const info = await (await fetch(base + "mission.json")).json();
    const grid = await (await fetch(base + "grid.geojson")).json();
    const [w, s, e, n] = info.bbox;
    M = { id, info, base, bounds: L.latLngBounds([s, w], [n, e]), slots: [null, null, null], layers: {},
          picked: null, overlay: null, swipe: null, reveal: null, revealed: false,
          hits: new Set(grid.features.filter((f) => f.properties.hit === 1).map((f) => `${f.properties.row},${f.properties.col}`)),
          share: Object.fromEntries(grid.features.map((f) => [`${f.properties.row},${f.properties.col}`, f.properties.share || 0])),
          grid };

    $("#m-title").textContent = info.title || id;
    $("#m-place").textContent = info.place || "";
    $("#m-dates").textContent = `Before ${info.before.date} · After ${info.after.date} · channels ${info.channels.CO}/${info.channels.CX}`;
    $("#result").hidden = true; $("#btn-reveal").disabled = false;
    setGuide("Drag a radar layer into a colour slot (or tap a layer, then tap a slot).");

    if (!missionMap) {
      missionMap = L.map("mission-map", { zoomSnap: 0.25 });
      L.tileLayer(ESRI, { attribution: ESRI_ATTR, maxZoom: 18 }).addTo(missionMap);
    }
    missionMap.eachLayer((l) => !(l instanceof L.TileLayer) && missionMap.removeLayer(l));
    missionMap.fitBounds(M.bounds);
    stopSwipe();

    // the building blocks: grey layers from mission.json
    const { CO, CX } = info.channels;
    const grey = CO === CX;
    const defs = [
      ["before", "CO", `Before · ${CO}`], ["before", "CX", `Before · ${CX}`], ["before", "RATIO", `Before · ${CO}−${CX}`],
      ["after", "CO", `After · ${CO}`], ["after", "CX", `After · ${CX}`], ["after", "RATIO", `After · ${CO}−${CX}`],
    ].filter(([, k]) => !grey || k === "CO");
    const pal = $("#palette"); pal.innerHTML = "";
    await Promise.all(defs.map(async ([date, kind, label]) => {
      const key = `${date}_${kind}`, src = base + info.layers[date][kind];
      M.layers[key] = { key, label, date, src, data: pixels(await loadImage(src)) };
    }));
    defs.forEach(([date, kind]) => pal.appendChild(tile(M.layers[`${date}_${kind}`])));
    document.querySelectorAll(".slot").forEach((s) => renderSlot(+s.dataset.ch));
    composite();
  }

  function tile(layer) {
    const t = el("div", { class: "tile", draggable: "true", "data-key": layer.key }, [
      el("img", { src: layer.src, alt: layer.label }), el("span", { text: layer.label }),
    ]);
    t.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", layer.key));
    t.addEventListener("click", () => {
      M.picked = M.picked === layer.key ? null : layer.key;
      document.querySelectorAll(".tile").forEach((x) => x.classList.toggle("picked", x.dataset.key === M.picked));
      if (M.picked) setGuide(`Now tap a colour slot for “${layer.label}”.`);
    });
    return t;
  }

  document.querySelectorAll(".slot").forEach((slot) => {
    const ch = +slot.dataset.ch;
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("over"); });
    slot.addEventListener("dragleave", () => slot.classList.remove("over"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault(); slot.classList.remove("over");
      assign(ch, e.dataTransfer.getData("text/plain"));
    });
    slot.addEventListener("click", () => {
      if (M && M.picked) { assign(ch, M.picked); M.picked = null; document.querySelectorAll(".tile").forEach((x) => x.classList.remove("picked")); }
      else if (M && M.slots[ch]) assign(ch, null);   // tap a filled slot to empty it
    });
  });

  function assign(ch, key) {
    if (!M || (key && !M.layers[key])) return;
    M.slots[ch] = key; renderSlot(ch); composite(); coach();
  }

  function renderSlot(ch) {
    const body = document.querySelector(`.slot[data-ch="${ch}"] .slot-body`);
    const key = M && M.slots[ch];
    body.innerHTML = key ? `<img src="${M.layers[key].src}" alt=""><div>${M.layers[key].label}</div>` : "drop here";
    document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("used", M.slots.includes(t.dataset.key)));
  }

  function coach() {
    const used = M.slots.filter(Boolean).map((k) => M.layers[k].date);
    if (!used.length) return setGuide("Drag a radar layer into a colour slot.");
    if (new Set(used).size === 1)
      return setGuide("All your colours come from the same date, so nothing can glow yet. Put one BEFORE and one AFTER layer in different colours.");
    setGuide("See the colours? Places that changed between the two dates glow. Try the contrast slider, then reveal!");
  }
  const setGuide = (t) => ($("#guide-text").textContent = t);

  // the player's mix: each slot's grey layer becomes one colour channel
  function composite() {
    const first = Object.values(M.layers)[0].data;
    const W = first.width, H = first.height, out = new ImageData(W, H), o = out.data;
    const k = +$("#contrast").value;
    const src = M.slots.map((key) => (key ? M.layers[key].data.data : null));
    for (let i = 0; i < W * H * 4; i += 4) {
      let a = 0;
      for (let c = 0; c < 3; c++) {
        const s = src[c];
        if (!s) { o[i + c] = 0; continue; }
        const v = (s[i] - 128) * k + 128;
        o[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        if (s[i + 3] > a) a = s[i + 3];
      }
      o[i + 3] = a;
    }
    M.mix = out;
    const cv = el("canvas"); cv.width = W; cv.height = H; cv.getContext("2d").putImageData(out, 0, 0);
    const url = cv.toDataURL("image/png");
    if (M.overlay) M.overlay.setUrl(url);
    else M.overlay = L.imageOverlay(url, M.bounds, { opacity: 1 }).addTo(missionMap);
  }
  $("#contrast").addEventListener("input", () => M && composite());

  // score: does the player's mix glow WHERE the change really is? Pearson r between the mix's colourfulness per
  // grid cell and the real changed share per cell (from the answer key). Scale-free, so contrast can't game it.
  function score() {
    const { width: W, height: H, data: d } = M.mix;
    const sum = {}, cnt = {};
    for (let y = 0; y < H; y++) {
      const r = Math.min(GRID - 1, Math.floor((y * GRID) / H));
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!d[i + 3]) continue;
        const c = Math.min(GRID - 1, Math.floor((x * GRID) / W)), key = `${r},${c}`;
        const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
        sum[key] = (sum[key] || 0) + sat; cnt[key] = (cnt[key] || 0) + 1;
      }
    }
    const keys = Object.keys(sum), xs = keys.map((k) => sum[k] / cnt[k]), ys = keys.map((k) => M.share[k] || 0);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
    const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    let hs = 0, hn = 0, ms = 0, mn = 0;
    keys.forEach((k, i) => { if (M.hits.has(k)) { hs += xs[i]; hn++; } else { ms += xs[i]; mn++; } });
    return { r, glow: hn ? hs / hn : 0, rest: mn ? ms / mn : 0, points: Math.max(0, Math.min(1000, Math.round(((r - 0.25) / 0.5) * 1000))) };   // r <= 0.25 (one date, structure only) = 0; r >= 0.75 = full marks
  }

  $("#btn-reveal").addEventListener("click", () => {
    if (!M || M.revealed) return;
    stopSwipe();
    const s = score();
    M.revealed = true; $("#btn-reveal").disabled = true;
    M.reveal = L.layerGroup([
      L.imageOverlay(M.base + M.info.change_overlay, M.bounds, { opacity: .9 }),
      L.geoJSON(M.grid, {
        filter: (f) => f.properties.hit === 1,
        style: { color: "#ffc24a", weight: 1.5, fill: false },
      }),
    ]).addTo(missionMap);
    scores[M.id] = Math.max(scores[M.id] || 0, s.points); store.set("scores", scores); updateHud();
    const verdict = s.points >= 700 ? "Brilliant! The change glows exactly where it happened."
      : s.points >= 300 ? "Good mix: the change shows. Can a different layer or contrast make it glow more?"
      : "The change is hiding in your mix. Try a BEFORE layer and an AFTER layer of the same channel in two colours.";
    $("#result").hidden = false;
    $("#result").innerHTML = `<div class="big">★ ${s.points}</div>
      <p>${verdict}</p>
      <p class="muted">Red = what really changed (NISAR). Yellow squares = the ${M.hits.size} cells of the answer key.
      Your mix matches the real change map ${Math.max(0, Math.round(s.r * 100))} %
      (glow ${s.glow.toFixed(0)} on changed cells, ${s.rest.toFixed(0)} elsewhere).</p>
      <div class="actions"><button id="btn-retry" class="ghost">Try another mix</button><button id="btn-next">Next mission</button></div>`;
    $("#btn-retry").onclick = () => { missionMap.removeLayer(M.reveal); M.revealed = false; $("#btn-reveal").disabled = false; $("#result").hidden = true; };
    $("#btn-next").onclick = openWorld;
  });

  // before ⇄ after swipe with the ready-made pictures
  function stopSwipe() {
    if (M && M.swipe) { M.swipe.forEach((l) => missionMap.removeLayer(l)); M.swipe = null; }
    $("#swipe-bar").hidden = true;
    if (M && M.overlay) M.overlay.setOpacity(1);
  }
  $("#btn-swipe").addEventListener("click", () => {
    if (!M) return;
    if (M.swipe) return stopSwipe();
    const after = L.imageOverlay(M.base + M.info.after.image, M.bounds).addTo(missionMap);
    const before = L.imageOverlay(M.base + M.info.before.image, M.bounds).addTo(missionMap);
    M.swipe = [after, before];
    M.overlay.setOpacity(0);
    $("#swipe-bar").hidden = false;
    const clip = () => (before.getElement().style.clipPath = `inset(0 ${100 - $("#swipe").value}% 0 0)`);
    before.once("load", clip); clip();
    $("#swipe").oninput = clip;
    setGuide("Slide: left of the line is BEFORE, right is AFTER. Spot the difference, then build a mix that makes it glow.");
  });

  $("#btn-back").addEventListener("click", openWorld);

  // ---------- end ----------
  function finish() {
    const board = store.get("board", []);
    board.push({ name: player, score: total() });
    board.sort((a, b) => b.score - a.score);
    store.set("board", board.slice(0, 10));
    $("#end-text").textContent = `${player}, you cleaned ${Object.keys(scores).length} of ${missions.length} places and scored ★ ${total()}.`;
    show("screen-end");
  }
  $("#btn-finish").addEventListener("click", finish);
  $("#btn-again").addEventListener("click", () => { scores = {}; store.set("scores", scores); updateHud(); openWorld(); });

  updateHud();
})();

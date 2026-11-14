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

  // ---------- mission: 1 look · 2 glow · 3 mark · 4 check ----------
  // Easy mode explains everything and gives hints; a Hard mode (no hints, 12 × 12 board) comes later.
  const MODE = store.get("mode", "easy");
  const STORIES = {   // one line per mission until the team's texts land in mission.json (story)
    W2: "In January 2026 heavy rain made the Limpopo River in Mozambique burst its banks and flood the valley.",
    W1: "In October 2026 storms poured rain on the coast near Gandia, Spain, and fields filled with water.",
    D1: "Along the BR-163 highway in the Amazon rainforest, people cut down forest in the dry season of 2026.",
    D3: "A giant nickel mine in Weda Bay, Indonesia, clears rainforest to dig up metal used in batteries.",
    A1: "In Punjab, India, farmers flood their rice fields in June, the rice grows tall, then it is harvested in autumn.",
    A3: "In the Jezreel Valley in Israel, summer crops grow in June and are harvested by October.",
    L3: "The Great Salt Lake in Utah is shrinking. Between summer and autumn its marshes and shores change.",
    M3: "In the Mississippi River Delta, the marshes along the coast are slowly turning into open water.",
  };
  const WATERY = { floods: true, marine: true, land: true };   // topics the co-pol (HH / VV) glasses see best
  const INFO = {
    radar: () => "My radar sends invisible waves down to Earth and listens for the echo, like a bat. " +
      "Strong echo = bright, weak echo = dark. It even works at night and through clouds!",
    swipe: () => "Drag the slider on the map. Left of the line is BEFORE, right of the line is AFTER. " +
      "Move it back and forth and look for places that change.",
    cards: () => "Both cards are radar pictures of the SAME place. BEFORE was taken before the event, AFTER was taken after it.",
    buckets: () => "I paint the BEFORE picture red and the AFTER picture blue-green. Where nothing changed, the two " +
      "colours mix into grey. Where something changed, one colour wins, so the change GLOWS!",
    glasses: () => {
      const { CO, CX } = M.info.channels;
      return CO === "VV"
        ? "Radar waves can wiggle flat or standing up. VV = sent standing up, heard standing up: calm water and oil look " +
          "dark, great for the sea. VH = sent standing up, heard lying flat: only leaves and branches twist the wave like that."
        : `Radar waves can wiggle lying flat or standing up. ${CO} = sent flat (H = horizontal) and heard flat: smooth ` +
          `water bounces it away, so water looks dark. Great for floods! ${CX} = sent flat, heard standing up ` +
          `(V = vertical): only leaves and branches twist the wave like that, so it's great for trees and crops.`;
    },
    squares: () => "Paint every square where you see glow. Right squares earn points, wrong squares cost a little." +
      (MODE === "easy" ? " Stuck? Press 💡 Hint." : ""),
  };
  document.querySelectorAll("button.info").forEach((b) => b.addEventListener("click", () => {
    say(INFO[b.dataset.info]()); const g = $(".guide"); g.classList.add("flash"); setTimeout(() => g.classList.remove("flash"), 600);
  }));
  const KID = 6;   // the kids' board: 6 × 6 squares, each = 2 × 2 cells of the 12 × 12 answer key
  const WHY = {
    floods: "Water is smooth like a mirror, so the radar bounces away and flooded places turn dark.",
    forest: "Trees scatter the radar back to me. Where trees were cut, the signal drops and it gets darker.",
    agriculture: "Growing crops scatter lots of radar; after the harvest the field is flat and gets darker.",
    land: "When a shore or a marsh turns from wet to dry, or dry to wet, its radar brightness changes.",
    marine: "Calm water and oil make the sea smoother, so it turns darker to my radar.",
  };

  async function openMission(id) {
    show("screen-mission");
    const base = `missions/${id}/`;
    const info = await (await fetch(base + "mission.json")).json();
    const grid = await (await fetch(base + "grid.geojson")).json();
    const [w, s, e, n] = info.bbox;
    const { CO, CX } = info.channels;
    M = { id, info, base, bounds: L.latLngBounds([s, w], [n, e]), step: 1, layers: {},
          buckets: { red: null, cyan: null }, glasses: info.change_rule.channel === 1 && CO !== CX ? "CX" : "CO",
          picked: null, overlay: null, swipe: null, cells: [], marked: new Set(), extra: [] };

    // 12 × 12 answer key -> 6 × 6 kids' board (a square changed if ≥ 20 % of it changed)
    const big = {};
    grid.features.forEach((f) => {
      const p = f.properties, k = `${Math.floor(p.row / 2)},${Math.floor(p.col / 2)}`;
      const b = L.geoJSON(f).getBounds();
      big[k] = big[k] ? { bounds: big[k].bounds.extend(b), share: big[k].share + (p.share || 0) / 4 } : { bounds: b, share: (p.share || 0) / 4 };
    });
    M.truth = new Set(Object.keys(big).filter((k) => big[k].share >= 0.2));
    if (!M.truth.size) {   // tiny change: take the most-changed squares
      Object.keys(big).sort((a, b) => big[b].share - big[a].share).slice(0, 3).forEach((k) => M.truth.add(k));
    }
    M.big = big;

    $("#m-title").textContent = info.title || id;
    $("#m-place").textContent = info.place || "";
    $("#m-story").textContent = info.story || STORIES[id] || "";
    $(".d-before").textContent = info.before.date; $(".d-after").textContent = info.after.date;
    document.querySelectorAll(".glasses button[data-ch]").forEach((bt) => {
      bt.textContent = bt.dataset.ch === "CO" ? `${CO} 💧 water` : `${CX} 🌿 plants`;
      bt.hidden = bt.dataset.ch === "CX" && CO === CX;
    });

    if (!missionMap) {
      missionMap = L.map("mission-map", { zoomSnap: 0.25 });
      L.tileLayer(ESRI, { attribution: ESRI_ATTR, maxZoom: 18 }).addTo(missionMap);
    }
    missionMap.eachLayer((l) => !(l instanceof L.TileLayer) && missionMap.removeLayer(l));
    missionMap.fitBounds(M.bounds);
    missionMap.dragging.enable();

    await Promise.all(["before", "after"].flatMap((d) => (CO === CX ? ["CO"] : ["CO", "CX"]).map(async (ch) => {
      const src = base + info.layers[d][ch];
      M.layers[`${d}_${ch}`] = { src, data: pixels(await loadImage(src)) };
    })));
    goStep(1);
  }

  function goStep(step) {
    M.step = step;
    document.querySelectorAll(".steps li").forEach((li) => {
      li.classList.toggle("now", +li.dataset.step === step); li.classList.toggle("past", +li.dataset.step < step);
    });
    $("#glow-kit").hidden = step !== 2; $("#mark-kit").hidden = step !== 3; $("#result").hidden = step !== 4;
    $("#btn-prev").hidden = step === 1 || step === 4;
    document.querySelectorAll("[data-step-only]").forEach((b) => (b.hidden = +b.dataset.stepOnly !== step));
    $("#btn-hint").hidden = MODE !== "easy";
    stopSwipe(); clearCells(); M.extra.forEach((l) => missionMap.removeLayer(l)); M.extra = [];
    missionMap.dragging.enable();

    if (step === 1) {
      startSwipe();
      say("Slide the bar on the map: left = BEFORE, right = AFTER. Can you spot what changed? Tap a ? if you want me to explain.");
      next("Next: make it glow ✨", true);
    }
    if (step === 2) {
      refreshCards(); composite(); glowHint();
    }
    if (step === 3) {
      composite(); drawCells();
      missionMap.dragging.disable();
      say("Paint the squares where it glows: click and drag, or tap. Tap a square again to un-mark it." +
          (MODE === "easy" ? " Not sure? Press 💡 Hint and I'll blink a square for you." : ""));
      updateMarked();
    }
    if (step === 4) check();
  }

  function next(label, enabled) { const b = $("#btn-next"); b.textContent = label; b.disabled = !enabled; }
  const say = (t) => ($("#guide-text").textContent = t);
  $("#btn-next").addEventListener("click", () => (M.step === 4 ? openWorld() : goStep(M.step + 1)));
  $("#btn-prev").addEventListener("click", () => goStep(Math.max(1, M.step - 1)));
  $("#btn-back").addEventListener("click", openWorld);

  // step 1 · before ⇄ after swipe with the ready-made pictures
  function startSwipe() {
    const after = L.imageOverlay(M.base + M.info.after.image, M.bounds).addTo(missionMap);
    const before = L.imageOverlay(M.base + M.info.before.image, M.bounds).addTo(missionMap);
    M.swipe = [after, before];
    if (M.overlay) M.overlay.setOpacity(0);
    $("#swipe-bar").hidden = false;
    const clip = () => before.getElement() && (before.getElement().style.clipPath = `inset(0 ${100 - $("#swipe").value}% 0 0)`);
    before.once("load", clip); clip();
    $("#swipe").oninput = clip;
  }
  function stopSwipe() {
    if (M && M.swipe) { M.swipe.forEach((l) => missionMap.removeLayer(l)); M.swipe = null; }
    $("#swipe-bar").hidden = true;
    if (M && M.overlay) M.overlay.setOpacity(1);
  }

  // step 2 · two cards into two buckets
  function refreshCards() {
    document.querySelectorAll(".card").forEach((c) => {
      c.querySelector("img").src = M.layers[`${c.dataset.date}_${M.glasses}`].src;
      c.classList.toggle("used", Object.values(M.buckets).includes(c.dataset.date));
      c.classList.toggle("picked", M.picked === c.dataset.date);
    });
    document.querySelectorAll(".bucket").forEach((b) => {
      const d = M.buckets[b.dataset.bucket];
      b.querySelector(".bucket-body").innerHTML = d
        ? `<img src="${M.layers[`${d}_${M.glasses}`].src}" alt=""><div>${d.toUpperCase()}</div>` : "drop a card";
    });
    document.querySelectorAll(".glasses button[data-ch]").forEach((bt) => bt.classList.toggle("on", bt.dataset.ch === M.glasses));
  }
  function glassesTip() {
    const { CO, CX } = M.info.channels, watery = WATERY[M.info.topic];
    const best = watery ? `${CO} 💧` : `${CX} 🌿`, now = M.glasses === "CO" ? `${CO} 💧` : `${CX} 🌿`;
    if (CO === CX) return "";
    return best === now ? ` Your ${now} glasses are the best ones for this mission.`
      : ` Tip: this mission is about ${watery ? "water" : "plants"}, so try the ${best} glasses!`;
  }
  function glowHint() {
    const { red, cyan } = M.buckets;
    if (!red || !cyan) {
      say(!red && !cyan
        ? "Drag the BEFORE card into the RED bucket. (Or tap the card, then tap the bucket.)"
        : "Now drag the other card into the empty bucket.");
      return next("Next: mark the glow ✏️", false);
    }
    say((red === "before"
      ? "It glows! RED = it got darker, BLUE-GREEN = it got brighter, GREY = nothing changed."
      : "It glows! BLUE-GREEN = it got darker, RED = it got brighter, GREY = nothing changed.") + glassesTip());
    next("Next: mark the glow ✏️", true);
  }
  function drop(bucket, date) {
    if (!date) return;
    const other = bucket === "red" ? "cyan" : "red";
    if (M.buckets[other] === date) M.buckets[other] = null;   // a card can only be in one bucket
    M.buckets[bucket] = date; M.picked = null;
    refreshCards(); composite(); glowHint();
  }
  document.querySelectorAll(".card").forEach((c) => {
    c.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", c.dataset.date));
    c.addEventListener("click", () => { M.picked = M.picked === c.dataset.date ? null : c.dataset.date; refreshCards(); });
  });
  document.querySelectorAll(".bucket").forEach((b) => {
    b.addEventListener("dragover", (e) => { e.preventDefault(); b.classList.add("over"); });
    b.addEventListener("dragleave", () => b.classList.remove("over"));
    b.addEventListener("drop", (e) => { e.preventDefault(); b.classList.remove("over"); drop(b.dataset.bucket, e.dataTransfer.getData("text/plain")); });
    b.addEventListener("click", () => M.picked && drop(b.dataset.bucket, M.picked));
  });
  document.querySelectorAll(".glasses button[data-ch]").forEach((bt) => bt.addEventListener("click", () => {
    M.glasses = bt.dataset.ch; refreshCards(); composite(); glowHint();
  }));

  // the glow picture: red = the card in the red bucket, green + blue = the card in the blue-green bucket
  function composite() {
    const layer = (d) => (d ? M.layers[`${d}_${M.glasses}`].data : null);
    const R = layer(M.buckets.red), C = layer(M.buckets.cyan), any = R || C;
    let url;
    if (!any) url = M.base + M.info.after.image;   // nothing mixed yet: show the plain after picture
    else {
      const W = any.width, H = any.height, out = new ImageData(W, H), o = out.data, k = 1.4;
      const st = (v) => { v = (v - 128) * k + 128; return v < 0 ? 0 : v > 255 ? 255 : v; };
      for (let i = 0; i < W * H * 4; i += 4) {
        const r = R ? st(R.data[i]) : 0, c = C ? st(C.data[i]) : 0;
        o[i] = r; o[i + 1] = c; o[i + 2] = c;
        o[i + 3] = Math.max(R ? R.data[i + 3] : 0, C ? C.data[i + 3] : 0);
      }
      const cv = el("canvas"); cv.width = W; cv.height = H; cv.getContext("2d").putImageData(out, 0, 0);
      url = cv.toDataURL("image/png");
    }
    if (M.overlay) { M.overlay.setUrl(url); M.overlay.setOpacity(1); }
    else M.overlay = L.imageOverlay(url, M.bounds).addTo(missionMap);
  }

  // step 3 · paint squares
  let painting = false, paintTo = true;
  document.addEventListener("mouseup", () => (painting = false));
  document.addEventListener("touchend", () => (painting = false));
  const cellStyle = (on) => ({ color: on ? "#ffe14a" : "#ffffff", weight: on ? 2 : 0.6, opacity: on ? 1 : 0.5,
                               fillColor: "#ffe14a", fillOpacity: on ? 0.35 : 0.01 });
  function drawCells() {
    Object.entries(M.big).forEach(([k, c]) => {
      const r = L.rectangle(c.bounds, cellStyle(M.marked.has(k))).addTo(missionMap);
      const set = (on) => {
        on ? M.marked.add(k) : M.marked.delete(k); r.setStyle(cellStyle(on)); updateMarked();
        r.getElement() && r.getElement().classList.remove("hint-pulse");
      };
      r.on("mousedown", (e) => { L.DomEvent.stop(e); painting = true; paintTo = !M.marked.has(k); set(paintTo); });
      r.on("mouseover", () => painting && set(paintTo));
      M.cells.push(r);
    });
  }
  function clearCells() { M.cells.forEach((r) => missionMap.removeLayer(r)); M.cells = []; }
  $("#btn-hint").addEventListener("click", () => {
    const keys = Object.keys(M.big), left = [...M.truth].filter((k) => !M.marked.has(k));
    M.cells.forEach((r) => r.getElement() && r.getElement().classList.remove("hint-pulse"));
    if (!left.length) return say("You found every changed square! Press Check ✅ (and un-mark squares that don't glow).");
    const k = left.sort((a, b) => M.big[b].share - M.big[a].share)[0];
    const r = M.cells[keys.indexOf(k)];
    r.setStyle({ color: "#7cf3c7", weight: 4, opacity: 1, fillOpacity: 0.15, fillColor: "#7cf3c7" });
    r.getElement().classList.add("hint-pulse");
    say(`Look at the blinking square: it glows, so something changed there. Paint it! (${left.length} changed ${left.length === 1 ? "square" : "squares"} still to find)`);
  });
  function updateMarked() { $("#marked").textContent = M.marked.size; next("Check! ✅", M.marked.size > 0); }
  $("#btn-clear").addEventListener("click", () => { M.marked.clear(); clearCells(); drawCells(); updateMarked(); });

  // step 4 · check: points come from the squares
  function check() {
    const found = [...M.marked].filter((k) => M.truth.has(k)).length;
    const wrong = M.marked.size - found, total = M.truth.size;
    const points = Math.max(0, Math.round((1000 * (found - 0.5 * wrong)) / total));
    M.extra.push(L.imageOverlay(M.base + M.info.change_overlay, M.bounds, { opacity: 0.9 }).addTo(missionMap));
    Object.entries(M.big).forEach(([k, c]) => {
      const hit = M.truth.has(k), mine = M.marked.has(k);
      if (!hit && !mine) return;
      const color = hit && mine ? "#4be08a" : hit ? "#ffe14a" : "#ff5a5a";
      M.extra.push(L.rectangle(c.bounds, { color, weight: 3, fillColor: color, fillOpacity: hit && mine ? 0.25 : 0.08 }).addTo(missionMap));
    });
    scores[M.id] = Math.max(scores[M.id] || 0, points); store.set("scores", scores); updateHud();
    const cheer = points >= 800 ? "Amazing radar eyes! 🚀" : points >= 400 ? "Nice work, cadet! 👍" : "Good try! Look for the glow and try again. 💪";
    $("#result").innerHTML = `<div class="big">★ ${points}</div>
      <p class="score-line"><b>${cheer}</b><br>You found <b>${found}</b> of <b>${total}</b> changed squares${wrong ? `, and <b>${wrong}</b> ${wrong === 1 ? "square was" : "squares were"} wrong` : ""}.</p>
      <div class="legend"><span><i style="background:#4be08a"></i>found</span><span><i style="background:#ffe14a"></i>missed</span><span><i style="background:#ff5a5a"></i>wrong</span><span><i style="background:#ff2828"></i>real change</span></div>
      <p class="muted">Why? ${WHY[M.info.topic] || ""}</p>
      <button id="btn-retry" class="ghost small">Try again</button>`;
    $("#btn-retry").onclick = () => { M.marked.clear(); goStep(3); };
    const missed = total - found;
    say((missed ? `The yellow squares are changes you missed: look, they glow too! ` : "You found every change! ") +
        `${WHY[M.info.topic] || ""}`);
    next("Next mission 🌍", true);
  }

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

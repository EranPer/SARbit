/* SARbit · radar cleanup. Plain JS + Leaflet. Data: /missions/ (made by pipeline/, see public/missions/README.md).
   A mission = 1 Look (swipe) · 2 Glow (before/after into red/blue-green) · 3 Find (tap the glowing spots) · 4 Score. */
(() => {
  "use strict";

  const TOPICS = {
    floods: { color: "#5aa8ff", label: "Floods & water" },
    forest: { color: "#4be08a", label: "Forests" },
    agriculture: { color: "#ffc24a", label: "Agriculture" },
    land: { color: "#ff8a3d", label: "Land & shores" },
    marine: { color: "#c08cff", label: "Oceans & coasts" },
  };
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
  const starText = (n) => "★".repeat(n) + `<span class="off">${"★".repeat(3 - n)}</span>`;

  // ---------- sound (made in the browser, no files) ----------
  let muted = store.get("muted", false), actx = null;
  const SFX = { hit: [[660, .09], [990, .16]], miss: [[170, .25, "square"]], glow: [[520, .08], [780, .14]],
                meh: [[440, .12, "triangle"]], win: [[523, .1], [659, .1], [784, .1], [1047, .3]] };
  function sfx(name) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      let t = actx.currentTime;
      SFX[name].forEach(([f, d, type]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type || "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d); t += d * 0.85;
      });
    } catch { /* no audio */ }
  }
  const soundBtn = () => ($("#btn-sound").textContent = muted ? "🔇" : "🔊");
  $("#btn-sound").addEventListener("click", () => { muted = !muted; store.set("muted", muted); soundBtn(); });
  soundBtn();

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
  function react(kind) {
    const a = $("#alien-guide"); a.classList.remove("happy", "oops"); void a.offsetWidth; a.classList.add(kind);
  }

  // ---------- state ----------
  let missions = [];
  let player = store.get("player", "");
  let scores = store.get("scores", {});   // { missionId: best points }
  let stars = store.get("stars", {});     // { missionId: best stars 0-3 }
  let worldMap = null, missionMap = null;
  let M = null;                            // the open mission

  const total = () => Object.values(scores).reduce((a, b) => a + b, 0);
  const totalStars = () => Object.values(stars).reduce((a, b) => a + b, 0);
  const updateHud = () => {
    $("#hud").hidden = !player;
    $("#hud-name").textContent = player;
    $("#hud-score").textContent = total();
    $("#hud-stars").textContent = totalStars();
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
      const done = m.id in scores, st = stars[m.id] || 0;
      L.circleMarker([m.lat, m.lon], { radius: 9, color: "#fff", weight: 2, fillColor: t.color, fillOpacity: done ? .45 : .95 })
        .addTo(worldMap).bindTooltip(`${m.title} · ${t.label}${done ? ` · ${"★".repeat(st)}` : ""}`).on("click", () => openMission(m.id));
      const li = el("li", { class: done ? "done" : "" }, [
        el("span", { class: "chip", style: `background:${t.color}` }),
        el("span", { text: m.title }),
      ]);
      const s = el("span", { class: "pts stars" }); s.innerHTML = done ? starText(st) : "";
      li.appendChild(s);
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

  // ---------- mission: 1 look · 2 glow · 3 find · 4 score ----------
  // Easy mode explains everything and gives hints; a Hard mode (no hints, fine grid) comes later.
  const MODE = store.get("mode", "easy");
  const BLOCK = 8;           // the answer is worked out on 8 × 8-pixel blocks (≈ 150-300 m on the ground)
  const DB_PER_GREY = 6.375; // grey layers: 6.375 grey levels per dB (see public/missions/README.md)
  const CHANGE_DB = 3;       // a block changed if its brightness moved ≥ 3 dB, darker or brighter
  const MAX_TARGETS = 8, MIN_TARGETS = 3, HEARTS = 3, TAP_REACH = 3;   // reach in blocks, forgiving for fingers
  const PTS = { glow: 50, glasses: 100, spot: 150, speed: 50 };
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
  const WHY = {
    floods: "Water is smooth like a mirror, so the radar bounces away and flooded places turn dark.",
    forest: "Trees scatter the radar back to me. Where trees were cut, the signal drops and it gets darker.",
    agriculture: "Growing crops scatter lots of radar; after the harvest the field is flat and the echo changes.",
    land: "When a shore or a marsh turns from wet to dry, or dry to wet, its radar brightness changes.",
    marine: "Calm water and oil make the sea smoother, so it turns darker to my radar.",
  };
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
    spots: () => `Tap the places that glow. Each glowing spot you find = ${PTS.spot} points, and the faster the better. ` +
      `Tapping where nothing changed costs a heart ❤️.` + (MODE === "easy" ? " Stuck? Press 💡 Hint." : ""),
  };
  const say = (t) => ($("#guide-text").textContent = t);
  const PLAYTEST = location.hash.includes("playtest");
  function log(ev, data = {}) {
    if (!PLAYTEST || !M) return;
    (M.log = M.log || []).push({ t: Math.round((Date.now() - M.opened) / 100) / 10, ev, ...data });
  }
  document.querySelectorAll("button.info").forEach((b) => b.addEventListener("click", () => {
    say(INFO[b.dataset.info]()); const g = $(".guide"); g.classList.add("flash"); setTimeout(() => g.classList.remove("flash"), 600);
  }));

  async function openMission(id) {
    show("screen-mission");
    const base = `missions/${id}/`;
    const info = await (await fetch(base + "mission.json")).json();
    const [w, s, e, n] = info.bbox;
    const { CO, CX } = info.channels;
    M = { id, info, base, bounds: L.latLngBounds([s, w], [n, e]), step: 1, layers: {}, opened: Date.now(), log: [],
          buckets: { red: null, cyan: null }, glasses: "CO",
          best: info.change_rule.channel === 1 && CO !== CX ? "CX" : "CO",
          picked: null, overlay: null, swipe: null, extra: [], points: 0, got: {}, ana: null, found: new Set(), hearts: HEARTS };

    $("#m-title").textContent = info.title || id;
    $("#m-place").textContent = info.place || "";
    $("#m-story").textContent = info.story || STORIES[id] || "";
    $(".d-before").textContent = info.before.date; $(".d-after").textContent = info.after.date;
    document.querySelectorAll(".glasses button[data-ch]").forEach((bt) => {
      bt.textContent = bt.dataset.ch === "CO" ? `${CO} 💧 water` : `${CX} 🌿 plants`;
      bt.hidden = bt.dataset.ch === "CX" && CO === CX;
    });
    setPoints();

    if (!missionMap) {
      missionMap = L.map("mission-map", { zoomSnap: 0.25 });
      L.tileLayer(ESRI, { attribution: ESRI_ATTR, maxZoom: 18 }).addTo(missionMap);
      missionMap.on("click", (ev) => M && M.step === 3 && tap(ev.latlng));
    }
    missionMap.eachLayer((l) => !(l instanceof L.TileLayer) && missionMap.removeLayer(l));
    M.overlay = null;
    missionMap.fitBounds(M.bounds);

    await Promise.all(["before", "after"].flatMap((d) => (CO === CX ? ["CO"] : ["CO", "CX"]).map(async (ch) => {
      const src = base + info.layers[d][ch];
      M.layers[`${d}_${ch}`] = { src, data: pixels(await loadImage(src)) };
    })));
    goStep(1);
  }

  function setPoints() { $("#m-points").textContent = M.points; }
  function award(key, pts, at) {
    if (M.got[key]) return;
    M.got[key] = true; M.points += pts; setPoints();
    if (at) floatText(at, `+${pts}`, "good");
  }

  function goStep(step) {
    M.step = step;
    document.querySelectorAll(".steps li").forEach((li) => {
      li.classList.toggle("now", +li.dataset.step === step); li.classList.toggle("past", +li.dataset.step < step);
    });
    $("#glow-kit").hidden = step !== 2; $("#find-kit").hidden = step !== 3; $("#result").hidden = step !== 4;
    $("#btn-prev").hidden = step !== 2;
    document.querySelectorAll("[data-step-only]").forEach((b) => (b.hidden = +b.dataset.stepOnly !== step));
    $("#btn-hint2").hidden = MODE !== "easy";
    $("#map-hud").hidden = step !== 3;
    log("step", { step });
    $("#mission-map").classList.toggle("find-mode", step === 3);
    stopSwipe(); M.extra.forEach((l) => missionMap.removeLayer(l)); M.extra = []; M.foundLayer = null;

    if (step === 1) {
      startSwipe();
      say("Slide the bar on the map: left = BEFORE, right = AFTER. Can you spot what changed? Tap a ? if you want me to explain.");
      next("Next: make it glow ✨", true);
    }
    if (step === 2) { refreshCards(); composite(); glowHint(); }
    if (step === 3) startFind();
    if (step === 4) score();
    if (step !== 4) $("#playtest").hidden = true;
  }

  function next(label, enabled) { const b = $("#btn-next"); b.textContent = label; b.disabled = !enabled; }
  $("#btn-next").addEventListener("click", () => {
    if (M.step === 2 && M.glasses === M.best) award("glasses", PTS.glasses);
    if (M.step === 4) return openWorld();
    goStep(M.step + 1);
  });
  $("#btn-prev").addEventListener("click", () => goStep(Math.max(1, M.step - 1)));
  $("#btn-back").addEventListener("click", openWorld);

  // ---------- step 1 · before ⇄ after swipe ----------
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

  // ---------- step 2 · two cards into two buckets ----------
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
    const { CO, CX } = M.info.channels;
    if (CO === CX) return "";
    const label = (c) => (c === "CO" ? `${CO} 💧` : `${CX} 🌿`);
    return M.glasses === M.best
      ? ` Your ${label(M.best)} glasses are the best ones here: +${PTS.glasses} bonus when you go on!`
      : ` Tip: this mission is about ${WATERY[M.info.topic] ? "water" : "plants"}. Which glasses make more of it glow? (+${PTS.glasses} bonus for the best ones)`;
  }
  function glowHint() {
    const { red, cyan } = M.buckets;
    if (!red || !cyan) {
      say(!red && !cyan
        ? "Drag the BEFORE card into the RED bucket. (Or tap the card, then tap the bucket.)"
        : "Now drag the other card into the empty bucket.");
      return next("Next: find the glowing spots 🎯", false);
    }
    award("glow", PTS.glow);
    say((red === "before"
      ? "It glows! RED = it got darker, BLUE-GREEN = it got brighter, GREY = nothing changed."
      : "It glows! BLUE-GREEN = it got darker, RED = it got brighter, GREY = nothing changed.") + glassesTip());
    next("Next: find the glowing spots 🎯", true);
  }
  function drop(bucket, date) {
    if (!date) return;
    const other = bucket === "red" ? "cyan" : "red", first = !(M.buckets.red && M.buckets.cyan);
    if (M.buckets[other] === date) M.buckets[other] = null;   // a card can only be in one bucket
    M.buckets[bucket] = date; M.picked = null; log("drop", { bucket, date });
    refreshCards(); composite(); glowHint();
    if (first && M.buckets.red && M.buckets.cyan) { sfx("glow"); react("happy"); }
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
    M.glasses = bt.dataset.ch; log("glasses", { ch: bt.dataset.ch }); refreshCards(); composite(); glowHint();
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

  // ---------- step 3 · find the glowing spots ----------
  // The answer comes from the SAME layers the player sees, so whatever glows can be found.
  function analyse(ch) {
    const B = M.layers[`before_${ch}`].data, A = M.layers[`after_${ch}`].data, W = B.width, H = B.height;
    const bw = Math.floor(W / BLOCK), bh = Math.floor(H / BLOCK), changed = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, n = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
        const i = (y * W + x) * 4;
        if (!B.data[i + 3] || !A.data[i + 3]) continue;
        s += A.data[i] - B.data[i]; n++;
      }
      if (n > (BLOCK * BLOCK) / 2 && Math.abs(s / n) / DB_PER_GREY >= CHANGE_DB) changed[by * bw + bx] = 1;
    }
    const labels = new Int32Array(bw * bh), blobs = [];
    for (let i = 0; i < bw * bh; i++) {
      if (!changed[i] || labels[i]) continue;
      const id = blobs.length + 1, stack = [i], cells = []; labels[i] = id;
      let sx = 0, sy = 0;
      while (stack.length) {
        const j = stack.pop(), x = j % bw, y = (j / bw) | 0;
        cells.push(j); sx += x; sy += y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const k = yy * bw + xx;
          if (changed[k] && !labels[k]) { labels[k] = id; stack.push(k); }
        }
      }
      blobs.push({ id, cells, size: cells.length, cx: sx / cells.length, cy: sy / cells.length });
    }
    blobs.sort((a, b) => b.size - a.size);
    const minSize = Math.max(6, Math.round(bw * bh * 0.0015));
    let targets = blobs.filter((b) => b.size >= minSize).slice(0, MAX_TARGETS);
    if (targets.length < MIN_TARGETS) targets = blobs.slice(0, MIN_TARGETS);
    return { W, H, bw, bh, labels, targets, targetIds: new Set(targets.map((t) => t.id)) };
  }

  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  function toBlock(ll) {
    const b = M.bounds, a = M.ana;
    const fx = (ll.lng - b.getWest()) / (b.getEast() - b.getWest());
    const fy = (mercY(b.getNorth()) - mercY(ll.lat)) / (mercY(b.getNorth()) - mercY(b.getSouth()));
    return [Math.floor(fx * a.bw), Math.floor(fy * a.bh)];
  }
  function toLatLng(bx, by) {   // block coordinates (may be fractional) -> lat/lng
    const b = M.bounds, a = M.ana, n = mercY(b.getNorth()), s = mercY(b.getSouth());
    const lng = b.getWest() + (bx / a.bw) * (b.getEast() - b.getWest());
    const my = n - (by / a.bh) * (n - s);
    return L.latLng(((Math.atan(Math.exp(my)) - Math.PI / 4) * 360) / Math.PI, lng);
  }

  function startFind() {
    composite();
    M.ana = analyse(M.glasses);
    M.found = new Set(); M.hearts = HEARTS; M.t0 = Date.now(); M.hintLayer = null;
    $("#targets").textContent = $("#hud-targets").textContent = M.ana.targets.length;
    if (window.innerWidth <= 820) setTimeout(() => $(".mission-map-wrap").scrollIntoView({ behavior: "smooth" }), 600);
    drawFound(false); updateFind();
    say(`I can see ${M.ana.targets.length} big glowing spots. Tap right on them! Careful: tapping where nothing glows costs a heart.` +
        (MODE === "easy" ? " Stuck? Press 💡 Hint." : ""));
    next("Score it ⭐", true);
  }
  function updateFind() {
    const hearts = "❤️".repeat(M.hearts) + "🤍".repeat(HEARTS - M.hearts);
    $("#found").textContent = $("#hud-found").textContent = M.found.size;
    $("#hearts").textContent = $("#hud-hearts").textContent = hearts;
  }

  // a pixel-y layer showing found spots (green) and, at the end, missed ones (yellow)
  function drawFound(showMissed) {
    const a = M.ana, cv = el("canvas"); cv.width = a.bw; cv.height = a.bh;
    const g = cv.getContext("2d"), img = g.createImageData(a.bw, a.bh);
    a.targets.forEach((t) => {
      const got = M.found.has(t.id);
      if (!got && !showMissed) return;
      const [r, gr, b] = got ? [75, 224, 138] : [255, 225, 74];
      t.cells.forEach((j) => { const i = j * 4; img.data[i] = r; img.data[i + 1] = gr; img.data[i + 2] = b; img.data[i + 3] = 150; });
    });
    g.putImageData(img, 0, 0);
    if (M.foundLayer) missionMap.removeLayer(M.foundLayer);
    M.foundLayer = L.imageOverlay(cv.toDataURL(), M.bounds, { className: "pixel-layer", interactive: false }).addTo(missionMap);
    M.extra.push(M.foundLayer);
  }

  function tap(ll) {
    if (M.hearts <= 0) return;
    const a = M.ana, [bx, by] = toBlock(ll);
    let best = null, bestD = 1e9, nearChange = false, nearFound = false;
    for (let dy = -TAP_REACH; dy <= TAP_REACH; dy++) for (let dx = -TAP_REACH; dx <= TAP_REACH; dx++) {
      const x = bx + dx, y = by + dy;
      if (x < 0 || y < 0 || x >= a.bw || y >= a.bh) continue;
      const id = a.labels[y * a.bw + x];
      if (!id) continue;
      nearChange = true;
      if (!a.targetIds.has(id)) continue;
      if (M.found.has(id)) { nearFound = true; continue; }
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = id; }
    }
    log("tap", { result: best ? "hit" : nearFound ? "again" : nearChange ? "tiny" : "miss" });
    if (best) {
      M.found.add(best);
      const secs = (Date.now() - M.t0) / 1000, speed = Math.round(PTS.speed * Math.max(0, 1 - secs / 90));
      award(`spot${best}`, PTS.spot + speed, ll);
      sfx("hit"); react("happy"); drawFound(false); clearHint(); updateFind();
      const left = a.targets.length - M.found.size;
      say(left ? `Got it! ${left} more glowing ${left === 1 ? "spot" : "spots"} to find.` : "You found them all! Amazing radar eyes! Press Score it ⭐");
      if (!left) sfx("win");
    } else if (nearFound) {
      floatText(ll, "already found", "meh"); sfx("meh");
    } else if (nearChange) {
      floatText(ll, "tiny change", "meh"); sfx("meh");
      say("That glows a little, but it's a tiny change. Look for the BIG glowing spots!");
    } else {
      M.hearts -= 1; updateFind(); floatText(ll, "−❤️", "bad"); sfx("miss"); react("oops");
      const map = $("#mission-map"); map.classList.remove("shake"); void map.offsetWidth; map.classList.add("shake");
      say(M.hearts ? "Nothing changed there: it's grey. Look for strong red or blue-green!" : "Out of hearts! Let's see how you did.");
      if (!M.hearts) setTimeout(() => M.step === 3 && goStep(4), 900);
    }
  }

  function floatText(ll, text, cls) {
    const p = missionMap.latLngToContainerPoint(ll), d = el("div", { class: `float-pts ${cls}` });
    d.textContent = text; d.style.left = `${p.x}px`; d.style.top = `${p.y}px`;
    $(".mission-map-wrap").appendChild(d); setTimeout(() => d.remove(), 1300);
  }

  function clearHint() { if (M.hintLayer) { missionMap.removeLayer(M.hintLayer); M.hintLayer = null; } }
  $("#btn-hint2").addEventListener("click", () => {
    if (!M || M.step !== 3) return;
    log("hint");
    const left = M.ana.targets.filter((t) => !M.found.has(t.id));
    if (!left.length) return say("You found every glowing spot! Press Score it ⭐");
    const t = left[0];   // biggest spot still hidden
    clearHint();
    const c = toLatLng(t.cx + 0.5, t.cy + 0.5), edge = toLatLng(t.cx + 0.5 + Math.sqrt(t.size) / 1.6 + 2, t.cy + 0.5);
    M.hintLayer = L.circle(c, { radius: Math.max(150, c.distanceTo(edge)), color: "#7cf3c7", weight: 4, fillOpacity: 0.08,
                                className: "hint-ring", interactive: false }).addTo(missionMap);
    M.extra.push(M.hintLayer);
    say("Look inside the blinking circle: something glows there. Tap it!");
  });

  // ---------- step 4 · score ----------
  function score() {
    const n = M.ana ? M.ana.targets.length : 0, f = M.found.size;
    const st = !n ? 0 : f === n ? 3 : f >= n / 2 ? 2 : f >= 1 ? 1 : 0;
    if (M.ana) drawFound(true);
    M.extra.push(L.imageOverlay(M.base + M.info.change_overlay, M.bounds, { opacity: 0.55, interactive: false }).addTo(missionMap));
    scores[M.id] = Math.max(scores[M.id] || 0, M.points); store.set("scores", scores);
    stars[M.id] = Math.max(stars[M.id] || 0, st); store.set("stars", stars); updateHud();
    if (st === 3) sfx("win");
    const cheer = st === 3 ? "Perfect! Amazing radar eyes! 🚀" : st === 2 ? "Great work, cadet! 👍" : st === 1 ? "Good start! 💪" : "Let's try again! 💪";
    $("#result").innerHTML = `<div class="stars">${starText(st)}</div><div class="big">${M.points} points</div>
      <p class="score-line"><b>${cheer}</b><br>You found <b>${f}</b> of <b>${n}</b> glowing spots${M.got.glasses ? ", and picked the best radar glasses" : ""}.</p>
      <div class="legend"><span><i style="background:#4be08a"></i>found</span><span><i style="background:#ffe14a"></i>missed</span><span><i style="background:#ff2828"></i>what NISAR measured</span></div>
      <p class="muted">Why? ${WHY[M.info.topic] || ""}</p>
      <button id="btn-retry" class="ghost small">Play this mission again</button>`;
    $("#btn-retry").onclick = () => openMission(M.id);
    if (PLAYTEST) playtestNotes(n, f, st);
    react(st >= 2 ? "happy" : "oops");
    say((f < n ? "The yellow spots are the ones you missed: they glow too! " : "You found every spot! ") + (WHY[M.info.topic] || ""));
    next("Next mission 🌍", true);
  }

  // one line per mission, kept on this device until copied
  function playtestNotes(n, f, st) {
    const L_ = M.log, at = (s) => (L_.find((e) => e.ev === "step" && e.step === s) || {}).t;
    const taps = (r) => L_.filter((e) => e.ev === "tap" && e.result === r).length;
    const line = `${new Date().toLocaleTimeString()} ${M.id}: ${st}★ ${M.points}pts, found ${f}/${n}, ` +
      `taps hit ${taps("hit")} miss ${taps("miss")} tiny ${taps("tiny")} again ${taps("again")}, ` +
      `hints ${L_.filter((e) => e.ev === "hint").length}, glasses switches ${L_.filter((e) => e.ev === "glasses").length}` +
      ` (best ${M.glasses === M.best ? "yes" : "no"}), drops ${L_.filter((e) => e.ev === "drop").length}, ` +
      `time look ${at(2) ?? "-"}s, glow ${at(3) != null && at(2) != null ? (at(3) - at(2)).toFixed(1) : "-"}s, ` +
      `find ${at(4) != null && at(3) != null ? (at(4) - at(3)).toFixed(1) : "-"}s, hearts left ${M.hearts}`;
    const all = store.get("playtest", []); all.push(line); store.set("playtest", all);
    const box = $("#playtest"); box.hidden = false;
    box.innerHTML = `<b>Playtest notes (${all.length} missions)</b><textarea readonly>${all.join("\n")}</textarea>
      <button id="btn-pt-copy" class="ghost small">📋 Copy playtest notes</button>
      <button id="btn-pt-clear" class="ghost small">Clear</button>`;
    $("#btn-pt-copy").onclick = () => { const ta = box.querySelector("textarea"); ta.select();
      (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).catch(() => document.execCommand("copy"));
      $("#btn-pt-copy").textContent = "Copied ✓"; };
    $("#btn-pt-clear").onclick = () => { store.set("playtest", []); box.hidden = true; };
  }

  // ---------- end ----------
  function finish() {
    const board = store.get("board", []);
    board.push({ name: player, score: total() });
    board.sort((a, b) => b.score - a.score);
    store.set("board", board.slice(0, 10));
    $("#end-text").textContent = `${player}, you cleaned ${Object.keys(scores).length} of ${missions.length} places, earned ⭐ ${totalStars()} stars and ${total()} points.`;
    show("screen-end");
  }
  $("#btn-finish").addEventListener("click", finish);
  $("#btn-again").addEventListener("click", () => {
    scores = {}; stars = {}; store.set("scores", scores); store.set("stars", stars); updateHud(); openWorld();
  });

  updateHud();
  if (location.hash.includes("debug")) window.SARBIT = { get M() { return M; }, get map() { return missionMap; }, openMission };
})();

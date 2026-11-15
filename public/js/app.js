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
  const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // NASA's everyday camera (VIIRS true colour, ~375 m) for one date, served by NASA GIBS without a key
  const GIBS = (date) => "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/" +
    `default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
  // the sharp one (Landsat + Sentinel-2, 30 m) for clear days: content.json "camera": {"layer": "hls", "date": ...}
  const HLS = (date) => "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/" +
    `default/${date}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png`;

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
  const starText = (n) => '<img src="art/star-on.webp" alt="★">'.repeat(n) + '<img class="off" src="art/star-off.webp" alt="☆">'.repeat(3 - n);
  const ART = (name) => `<img class="ico" src="art/${name}.webp" alt="">`;

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
  const soundBtn = () => ($("#btn-sound").innerHTML = `<img class="ico" src="art/ui-${muted ? "mute" : "sound"}.webp" alt="${muted ? "sound off" : "sound on"}">`);
  $("#btn-sound").addEventListener("click", () => { muted = !muted; store.set("muted", muted); soundBtn(); });
  soundBtn();

  // ---------- the alien (art: Grok Imagine, see CLAUDE.md) ----------
  // faces: wave (hello), think, point (look at the map), surprised, happy, oops
  const FACES = ["wave", "think", "point", "surprised", "happy", "oops"];
  FACES.forEach((f) => (new Image().src = `art/alien-${f}.webp`));   // preload, so a face swap never blinks
  function face(sel, f) {
    const a = $(sel), img = a.querySelector("img") || a.appendChild(el("img", { alt: "SARbit the alien" }));
    img.src = `art/alien-${f}.webp`; a.dataset.face = f;
  }
  face("#alien-intro", "full"); face("#alien-end", "happy"); face("#alien-guide", "wave");
  let calm = "wave", faceTimer = null;
  function setCalm(f) { calm = f; if (!faceTimer) face("#alien-guide", f); }
  function react(kind) {   // happy / oops for a moment, then back to the calm face of this step
    const a = $("#alien-guide"); face("#alien-guide", kind === "happy" ? "happy" : "oops");
    a.classList.remove("happy", "oops"); void a.offsetWidth; a.classList.add(kind);
    clearTimeout(faceTimer); faceTimer = setTimeout(() => { faceTimer = null; face("#alien-guide", calm); }, 2200);
  }

  // ---------- state ----------
  let missions = [];
  // players: several cadets can share one device, each with their own points and stars
  // sarbit.players = { name: { scores: { missionId: best points }, stars: { missionId: best 0-3 }, seen: time } }
  let players = store.get("players", null);
  if (!players) {   // carry over the one-player version
    players = {};
    const old = store.get("player", "");
    if (old) players[old] = { scores: store.get("scores", {}), stars: store.get("stars", {}), seen: Date.now() };
    store.set("players", players);
  }
  let player = store.get("player", ""), scores = {}, stars = {};
  function usePlayer(name) {
    player = name; store.set("player", name);
    players[name] = players[name] || { scores: {}, stars: {}, seen: 0 };
    scores = players[name].scores; stars = players[name].stars;
    savePlayer(); updateHud();
  }
  function savePlayer() { if (player) { players[player] = { scores, stars, seen: Date.now() }; store.set("players", players); } }
  const esc = (x) => String(x ?? "").replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch]));
  let worldMap = null, missionMap = null;
  let M = null;                            // the open mission

  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const total = () => sum(scores);
  const totalStars = () => sum(stars);
  const updateHud = () => {
    $("#hud").hidden = !player;
    $("#hud-name").innerHTML = `${ART("ui-player")}${esc(player)}`;
    $("#hud-score").textContent = total();
    $("#hud-stars").textContent = totalStars();
  };

  // ---------- intro: who's playing? ----------
  function renderPlayers() {
    const names = Object.keys(players).sort((a, b) => players[b].seen - players[a].seen);
    $("#players").hidden = !names.length;
    $("#player-list").innerHTML = names.map((n) => `<button class="player ghost" data-name="${esc(n)}"><span>${ART("ui-player")}${esc(n)}</span>
      <small>${ART("star-on")}${sum(players[n].stars)} · ${sum(players[n].scores)} pts</small></button>`).join("");
    $("#player-list").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { usePlayer(b.dataset.name); openWorld(); }));
    $("#name-input").value = names.length ? "" : player;
  }
  function switchPlayer() { if (M && M.cleanup) { M.cleanup(); M.cleanup = null; } show("screen-intro"); renderPlayers(); $("#name-input").focus(); }
  $("#name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    usePlayer($("#name-input").value.trim().slice(0, 20) || "Cadet");
    openWorld();
  });
  $("#hud-name").addEventListener("click", switchPlayer);
  $("#btn-switch").addEventListener("click", switchPlayer);

  // ---------- world map ----------
  async function openWorld() {
    show("screen-world"); $("#world-note").hidden = true;
    $("#done-pop").hidden = true; $("#guide-panel").classList.remove("pop"); backdrop();
    if (!missions.length) missions = await (await fetch("missions/index.json")).json();
    if (!worldMap) {
      worldMap = L.map("world-map", { worldCopyJump: true, minZoom: 2 }).setView([20, 20], 2);
      L.tileLayer(ESRI, { attribution: ESRI_ATTR, maxZoom: 18 }).addTo(worldMap);
    }
    worldMap.eachLayer((l) => l instanceof L.Marker && worldMap.removeLayer(l));
    const list = $("#mission-list"); list.innerHTML = "";
    missions.forEach((m) => {
      const t = TOPICS[m.topic] || { color: "#fff", label: m.topic };
      const done = m.id in scores, st = stars[m.id] || 0;
      // a picture pin per mission (its topic card), with the stars underneath once played
      const pin = L.divIcon({ className: "mission-pin", iconSize: [68, 58], iconAnchor: [34, 56], tooltipAnchor: [0, -34],
        html: `<div class="mp${done ? " done" : ""}" style="border-color:${t.color}"><img src="art/card-${m.topic}.webp" alt=""></div>` +
              `<i style="border-top-color:${t.color}"></i>${done ? `<span class="stars">${starText(st)}</span>` : ""}` });
      L.marker([m.lat, m.lon], { icon: pin, title: m.title, riseOnHover: true })
        .addTo(worldMap).bindTooltip(`${m.title} · ${t.label}${done ? " · done ✓" : ""}`, { direction: "top" }).on("click", () => pick(m));
      const li = el("li", { class: done ? "done" : "" }, [
        el("span", { class: "chip", style: `background:${t.color}` }),
        el("span", { text: m.title }),
      ]);
      const s = el("span", { class: "pts stars" }); s.innerHTML = done ? starText(st) : "";
      li.appendChild(s);
      if (done) li.querySelector("span:nth-child(2)").insertAdjacentHTML("beforeend", ' <span class="tick">✓</span>');
      li.addEventListener("click", () => pick(m));
      list.appendChild(li);
    });
    drawBoard(); drawLabs();
  }

  // the Radar Lab: extra games, each set at the mission where its idea shows best; closed once played, like missions
  let labs = null;
  async function drawLabs() {
    if (!labs) labs = await fetch("missions/labs.json").then((r) => r.json()).catch(() => []);
    $("#lab-list").innerHTML = labs.map((l) => {
      const m = missions.find((x) => x.id === l.mission), done = `lab-${l.id}` in scores;
      return `<li class="${done ? "done" : ""}" data-lab="${l.id}"><span class="lab-ico">${l.icon}</span>
        <span>${esc(l.title)}<small>${m ? esc(m.title) : ""}${done ? ' <span class="tick">✓</span>' : ""}</small></span>
        <span class="pts stars">${done ? starText(stars[`lab-${l.id}`] || 0) : ""}</span></li>`;
    }).join("");
    $("#lab-list").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
      const l = labs.find((x) => x.id === li.dataset.lab);
      if (`lab-${l.id}` in scores) {
        $("#world-note").hidden = false;
        $("#world-note").innerHTML = `🧪 <b>${esc(l.title)}</b> is done ✓ <span class="stars">${starText(stars[`lab-${l.id}`] || 0)}</span> Try another lab!`;
        return sfx("meh");
      }
      openMission(l.mission, l);
    }));
  }

  // a finished mission is closed: its points count once (Play again on the end screen starts everyone's run over)
  function pick(m) {
    $("#world-note").hidden = !(m.id in scores);
    if (!(m.id in scores)) return openMission(m.id);
    $("#world-note").innerHTML = `${ART("star-on")}<b>${esc(m.title)}</b> is done ✓ <span class="stars">${starText(stars[m.id] || 0)}</span> Pick a mission you haven't played yet!`;
    sfx("meh");
  }

  // top cadets on this device (the full scoreboard is a dialog)
  const ranking = () => Object.entries(players).map(([name, p]) => ({ name, pts: sum(p.scores), stars: sum(p.stars),
    done: missions.filter((m) => m.id in (p.scores || {})).length })).sort((a, b) => b.pts - a.pts || b.stars - a.stars);
  function drawBoard() {
    const top = ranking().filter((r) => r.pts > 0).slice(0, 5);
    $("#board-list").innerHTML = top.length
      ? top.map((r) => `<li class="${r.name === player ? "me" : ""}"><b>${esc(r.name)}</b> · ⭐ ${r.stars} · ${r.pts}</li>`).join("")
      : "<li>No scores yet: be the first!</li>";
  }

  // ---------- scoreboard dialog: this device, and the world board (api/scores.js) ----------
  const WORLD = "api/scores";
  function openBoard(tab = "device") {
    const d = $("#board-dialog");
    if (!d.open) d.showModal();
    d.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("#board-device").hidden = tab !== "device"; $("#board-world").hidden = tab !== "world";
    if (tab === "device") {
      const rows = ranking();
      $("#board-device").innerHTML = rows.length ? `<table class="board"><tr><th>#</th><th>Cadet</th><th>⭐</th><th>Points</th><th>Missions</th></tr>
        ${rows.map((r, i) => `<tr class="${r.name === player ? "me" : ""}"><td>${r.pts && i < 3 ? `<img class="medal" src="art/medal-${i + 1}.webp" alt="${i + 1}">` : i + 1}</td><td>${esc(r.name)}</td>
          <td>${r.stars}</td><td>${r.pts}</td><td>${r.done} / ${missions.length}</td></tr>`).join("")}</table>
        <p class="muted small">Scores stay on this device. Tap your name at the top to switch player.</p>` : "<p>No players yet.</p>";
    } else worldTab();
  }
  async function worldTab() {
    const box = $("#board-world");
    box.innerHTML = "<p class=\"muted\">Loading the world board…</p>";
    let data = null;
    try { const r = await fetch(WORLD, { cache: "no-store" }); if (r.ok) data = await r.json(); } catch { /* offline */ }
    if (!data || !Array.isArray(data.top)) {
      box.innerHTML = `<p>The world board isn't switched on yet.</p><p class="muted small">For the team: Vercel → the SARbit project → Storage →
        add an Upstash Redis database and connect it. Nothing else to change: <code>api/scores.js</code> is ready.</p>`;
      return;
    }
    const me = data.top.find((r) => r.name.toLowerCase() === player.toLowerCase());
    box.innerHTML = `${data.top.length ? `<table class="board"><tr><th>#</th><th>Cadet</th><th>⭐</th><th>Points</th></tr>
      ${data.top.map((r, i) => `<tr class="${r === me ? "me" : ""}"><td>${i < 3 ? `<img class="medal" src="art/medal-${i + 1}.webp" alt="${i + 1}">` : i + 1}</td><td>${esc(r.name)}</td><td>${r.stars}</td><td>${r.points}</td></tr>`).join("")}</table>`
      : "<p>No scores yet: be the first!</p>"}
      <div class="upload"><p class="small">Send <b>${esc(player)}</b>: ⭐ ${totalStars()} · ${total()} points. Everyone will see this name, so use a nickname, never your real full name.</p>
      <button id="btn-upload" ${total() ? "" : "disabled"}>${ART("ui-send")}Send my score</button></div>`;
    const up = $("#btn-upload");
    if (up) up.onclick = async () => {
      up.disabled = true; up.textContent = "Sending…";
      try {
        const r = await fetch(WORLD, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: player, points: total(), stars: totalStars(), missions: missions.filter((m) => m.id in scores).length }) });
        if (!r.ok) throw new Error(await r.text());
        worldTab();
      } catch (err) { up.textContent = "Couldn't send, try again"; up.disabled = false; }
    };
  }
  $("#btn-board").addEventListener("click", () => openBoard());
  $("#btn-world-board").addEventListener("click", () => openBoard());
  $("#btn-end-board").addEventListener("click", () => openBoard());
  $("#btn-board-close").addEventListener("click", () => $("#board-dialog").close());
  document.querySelectorAll("#board-dialog .tabs button").forEach((b) => b.addEventListener("click", () => openBoard(b.dataset.tab)));

  // ---------- mission: 1 look · 2 glow · 3 find · 4 score ----------
  // Easy mode explains everything and gives hints; a Hard mode (no hints, fine grid) comes later.
  const MODE = store.get("mode", "easy");
  const BLOCK = 8;           // the answer is worked out on 8 × 8-pixel blocks (≈ 150-300 m on the ground)
  const DB_PER_GREY = 6.375; // grey layers: 6.375 grey levels per dB (see public/missions/README.md)
  const CHANGE_DB = 3;       // a block changed if its brightness moved ≥ 3 dB, darker or brighter
  const MAX_TARGETS = 8, MIN_TARGETS = 3, HEARTS = 3, TAP_REACH = 3;   // reach in blocks, forgiving for fingers
  const PTS = { glow: 50, glasses: 100, spot: 150, speed: 50 };
  let CONTENT = null;   // missions/content.json: story, facts, news links and game rule per mission (editable text)
  async function content() {
    if (!CONTENT) CONTENT = await fetch("missions/content.json").then((r) => r.json()).catch(() => ({}));
    return CONTENT;
  }
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
  // a new step (M.popNext) opens the alien in the middle of the screen; later tips go to the small bubble
  const say = (t) => {
    $("#guide-text").textContent = t;
    if (M && M.popNext) { M.popNext = false; return guideMode("pop"); }
    if (guideMin) { const g = $("#guide-panel"); g.classList.remove("ping"); void g.offsetWidth; g.classList.add("ping"); }
  };
  const PLAYTEST = location.hash.includes("playtest");
  function log(ev, data = {}) {
    if (!PLAYTEST || !M) return;
    (M.log = M.log || []).push({ t: Math.round((Date.now() - M.opened) / 100) / 10, ev, ...data });
  }
  document.querySelectorAll("button.info").forEach((b) => b.addEventListener("click", () => {
    say(INFO[b.dataset.info]()); const g = $(".guide"); g.classList.add("flash"); setTimeout(() => g.classList.remove("flash"), 600);
  }));

  async function openMission(id, lab = null) {
    show("screen-mission");
    $("#screen-mission").classList.toggle("lab", !!lab);
    const base = `missions/${id}/`;
    const info = await (await fetch(base + "mission.json")).json();
    const extra = (await content())[id] || {};
    const [w, s, e, n] = info.bbox;
    const { CO, CX } = info.channels;
    if (M && M.mapLayers) Object.values(M.mapLayers).forEach((l) => l && missionMap.removeLayer(l));
    M = { id, info, base, bounds: L.latLngBounds([s, w], [n, e]), step: 1, layers: {}, opened: Date.now(), log: [],
          mapLayers: {}, on: new Set(["radar", "glow", ...(extra.layers || ["towns"])]), osmP: null, bonusQueue: null, inBonus: false, bonusAsked: 0, bonusRight: 0,
          buckets: { red: null, cyan: null }, glasses: "CO",
          best: info.change_rule.channel === 1 && CO !== CX ? "CX" : "CO", tried: new Set(), measured: false,
          picked: null, overlay: null, swipe: null, extra: [], points: 0, got: {}, ana: null, found: new Set(), hearts: HEARTS,
          content: extra, rule: { sign: 0, db: CHANGE_DB, water_max: 99, ...((extra.game || {}).rule || {}) },
          focus: (extra.game || {}).focus || [0, 0, 1, 1], anaCache: {}, game: extra.game || { type: "spots" }, result: null, onTap: null,
          lab, key: lab ? `lab-${lab.id}` : id };
    const STEP3 = { spots: ART("icon-find") + "Find", quiz: ART("icon-inspect") + "Inspect", order: ART("ui-undo") + "Order", lasso: ART("icon-circle") + "Circle", hunt: ART("icon-rig") + "Hunt" };
    $('.steps li[data-step="3"]').innerHTML = STEP3[M.game.type] || "🎯 Play";

    $("#m-title").textContent = lab ? `🧪 ${lab.title}` : info.title || id;
    $("#m-place").textContent = lab ? `Radar Lab · ${info.title}, ${info.place || ""}` : info.place || "";
    $("#m-story").textContent = lab ? lab.blurb : extra.story || info.story || "";
    renderInfo(extra);
    $(".d-before").textContent = info.before.date; $(".d-after").textContent = info.after.date;
    document.querySelectorAll(".glasses button[data-ch]").forEach((bt) => {
      bt.innerHTML = bt.dataset.ch === "CO" ? `${ART("badge-water")}${CO} water` : `${ART("badge-leaf")}${CX} plants`;
      bt.hidden = bt.dataset.ch === "CX" && CO === CX;
    });
    setPoints();

    if (!missionMap) {
      missionMap = L.map("mission-map", { zoomSnap: 0.25 });
      L.tileLayer(ESRI, { attribution: ESRI_ATTR, maxZoom: 18 }).addTo(missionMap);
      missionMap.createPane("camera").style.zIndex = 420;   // above the radar pictures (400)
      const osm = missionMap.createPane("osm"); osm.style.zIndex = 450; osm.style.pointerEvents = "none";
      // only the find-the-spots game uses plain taps; other games set M.onTap (or nothing)
      missionMap.on("click", (ev) => M && M.step === 3 && (M.onTap ? M.onTap(ev.latlng) : spots() && !M.inBonus && tap(ev.latlng)));
    }
    missionMap.eachLayer((l) => !(l instanceof L.TileLayer) && missionMap.removeLayer(l));
    M.overlay = null;
    missionMap.fitBounds(M.bounds);
    renderLayers();

    await Promise.all(["before", "after"].flatMap((d) => (CO === CX ? ["CO"] : ["CO", "CX"]).map(async (ch) => {
      const src = base + info.layers[d][ch];
      M.layers[`${d}_${ch}`] = { src, data: pixels(await loadImage(src)) };
    })));
    setLayer();
    lab ? startLab() : goStep(1);
  }

  function renderInfo(c) {
    const facts = (c.facts || []).map((f) => `<li>${esc(f)}</li>`).join("");
    const news = (c.news || []).filter((n) => /^https:\/\//.test(n.url)).map((n) =>
      `<li><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><span>${esc(n.source)}${n.date ? " · " + esc(n.date) : ""}</span></li>`).join("");
    $("#m-info").innerHTML = facts || news ? `${facts ? `<ul class="facts">${facts}</ul>` : ""}${news ? `<p class="muted">Read more:</p><ul class="news">${news}</ul>` : ""}
      <p class="muted small">Radar data: NASA-ISRO NISAR, ${esc(M.info.before.date)} and ${esc(M.info.after.date)}.</p>` : "";
    $("#news-panel").hidden = !(facts || news);
    M.newsTouched = false;
  }
  // the news panel opens by itself on Look and Score (not over the map while you play), unless you opened or closed it
  function newsOpen(open) { $("#m-info").hidden = !open; $("#btn-news").classList.toggle("on", open); $("#btn-news").innerHTML = `${ART("ui-news")}What happened${open ? " ✕" : ""}`; }
  $("#btn-news").addEventListener("click", () => { M.newsTouched = true; newsOpen($("#m-info").hidden); });
  // the alien's tips can shrink to just the alien; a new tip makes it wiggle
  // three sizes: "pop" (big, in the middle, the screen dimmed), "bubble" (bottom left) and "min" (just the alien).
  // Tapping the small alien always brings the big one back.
  let guideMin = store.get("guideMin", false);
  function guideMode(mode) {
    const g = $("#guide-panel"), pop = mode === "pop";
    if (!pop) { guideMin = mode === "min"; store.set("guideMin", guideMin); }
    g.classList.toggle("pop", pop); g.classList.toggle("min", mode === "min"); g.classList.remove("ping");
    const head = pop && M && M.popTitle;
    $("#guide-title").hidden = !head; $("#guide-title").textContent = head || "";
    $("#guide-story").hidden = !(pop && M && M.popStory); $("#guide-story").textContent = (pop && M && M.popStory) || "";
    backdrop();
    if (pop) $("#btn-guide-ok").focus({ preventScroll: true });
  }
  const guideClose = () => $("#guide-panel").classList.contains("pop") && guideMode("bubble");
  function guideSize(min) { guideMode(min ? "min" : "bubble"); }
  $("#btn-guide-min").addEventListener("click", () => guideMode("min"));
  $("#btn-guide-big").addEventListener("click", () => guideMode("pop"));
  $("#btn-guide-ok").addEventListener("click", guideClose);
  $("#alien-guide").addEventListener("click", () => !$("#guide-panel").classList.contains("pop") && guideMode("pop"));
  // the dimmed screen behind a pop-up: tap it (or Esc) to close
  function backdrop() { $("#pop-backdrop").hidden = !($("#guide-panel").classList.contains("pop") || !$("#done-pop").hidden); }
  const closePops = () => { guideClose(); if (!$("#done-pop").hidden) { $("#done-pop").hidden = true; backdrop(); } };
  $("#pop-backdrop").addEventListener("click", closePops);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closePops());
  guideSize(guideMin);

  // ---------- map layers: OpenStreetMap towns / roads / rivers, NASA's camera, a street map ----------
  const LAYERS = {
    towns: ART("lyr-towns") + "Towns & islands", roads: ART("lyr-roads") + "Roads", rivers: ART("lyr-rivers") + "Rivers",
    wet_before: ART("lyr-wet") + "Wet on {before}", wet_after: ART("lyr-wet") + "Wet on {after}",
    camera: ART("lyr-camera") + "NASA camera photo", street: ART("lyr-street") + "Street map",
  };
  const osmData = () => (M.osmP = M.osmP || fetch(M.base + "osm.geojson").then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const ROAD_BIG = /motorway|trunk|primary/, OSM_KIND = { towns: "town", roads: "road", rivers: "river" };
  async function makeLayer(key) {
    if (key === "camera") {
      const c = M.content.camera, date = c.date || M.info.after.date;
      return c.layer === "hls"
        ? L.tileLayer(HLS(date), { pane: "camera", maxNativeZoom: 12, maxZoom: 19, attribution: "Camera: NASA HLS, Landsat + Sentinel-2 (GIBS)" })
        : L.tileLayer(GIBS(date), { pane: "camera", maxNativeZoom: 9, maxZoom: 19, attribution: "Camera: NASA GIBS (VIIRS)" });
    }
    if (key === "wet_before" || key === "wet_after") return wetLayer(key.slice(4));
    if (key === "street") return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { pane: "camera", maxZoom: 19, attribution: OSM_ATTR });
    const g = await osmData();
    const kind = OSM_KIND[key];
    let fs = (g ? g.features : []).filter((f) => f.properties.kind === kind);
    if (fs.some((f) => f.properties.place !== "suburb")) fs = fs.filter((f) => f.properties.place !== "suburb");   // one town, not its 6 suburbs
    if (fs.filter((f) => f.properties.place !== "hamlet").length >= 8) fs = fs.filter((f) => f.properties.place !== "hamlet");
    const crowded = fs.length > 12, named = (f) => !crowded || /city|town|island/.test(f.properties.place);   // crowded: villages are dots
    if (!fs.length) return null;
    return L.geoJSON({ type: "FeatureCollection", features: fs }, {
      pane: "osm", interactive: false, attribution: OSM_ATTR,
      style: (f) => (f.properties.kind === "river" ? { color: "#5aa8ff", weight: 2.5, opacity: 0.9 }
        : { color: ROAD_BIG.test(f.properties.highway) ? "#ffe14a" : "#ffffff", weight: ROAD_BIG.test(f.properties.highway) ? 3.5 : 1.5, opacity: 0.85 }),
      pointToLayer: (f, ll) => {
        const island = /island|islet/.test(f.properties.place);
        const dot = L.circleMarker(ll, { pane: "osm", radius: island ? 0 : named(f) ? 3.5 : 2.5, color: "#0b1020", weight: 1.5, fillColor: "#fff", fillOpacity: 1, interactive: false });
        return !named(f) ? dot : dot.bindTooltip(f.properties.name, { permanent: true, direction: island ? "center" : "right", offset: island ? [0, 0] : [6, 0],
            className: `place-label${island ? " island" : ""}`, interactive: false });
      },
    });
  }
  // where the radar saw water or wet ground (dark: HH / VV below −18 dB) on one date: white outline, light blue inside
  function wetLayer(date) {
    const img = M.layers[`${date}_CO`].data, W = img.width, d = img.data, B = 4;
    const bw = Math.floor(W / B), bh = Math.floor(img.height / B), lim = (35 - 18) * DB_PER_GREY;
    const raw = new Uint8Array(bw * bh), wet = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, n = 0;
      for (let y = by * B; y < by * B + B; y++) for (let x = bx * B; x < bx * B + B; x++) { const i = (y * W + x) * 4; if (d[i + 3]) { s += d[i]; n++; } }
      raw[by * bw + bx] = n > B * B / 2 && s / n < lim;
    }
    for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {   // 3 x 3 majority: no speckle
      let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += raw[(y + dy) * bw + x + dx];
      wet[y * bw + x] = n >= 5;
    }
    const cv = el("canvas"); cv.width = bw; cv.height = bh;
    const g = cv.getContext("2d"), out = g.createImageData(bw, bh);
    for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
      const k = y * bw + x;
      if (!wet[k]) continue;
      const edge = !wet[k - 1] || !wet[k + 1] || !wet[k - bw] || !wet[k + bw];
      out.data.set(edge ? [255, 255, 255, 230] : [90, 168, 255, 40], k * 4);   // white edge: not the blue-green of the glow
    }
    g.putImageData(out, 0, 0);
    return L.imageOverlay(cv.toDataURL(), M.bounds, { pane: "osm", interactive: false });
  }
  // the radar itself is two layers too: the picture, and the glow on it (both on unless the player switches them off)
  const RADAR = { radar: "📡 Radar picture", glow: "✨ Glow (what changed)" };
  function applyRadar() {
    if (!M) return;
    const radar = M.on.has("radar"), glow = M.on.has("glow");
    if (M.swipe) M.swipe.forEach((l) => l.setOpacity(radar ? 1 : 0));
    if (M.overlay) {
      const url = glow && M.glowUrl ? M.glowUrl : M.base + M.info.after.image;   // glow off: the plain radar picture
      if (M.overlay._url !== url) M.overlay.setUrl(url);
      M.overlay.setOpacity(!M.swipe && radar ? 1 : 0);
    }
    if (M.changeLayer) M.changeLayer.setOpacity(glow ? 0.55 : 0);
  }
  async function setLayer(key, on) {   // no key: just (re)draw what M.on asks for
    if (key) on ? M.on.add(key) : M.on.delete(key);
    if (key in RADAR) { applyRadar(); return renderLayers(); }
    if (key === "camera" && on) M.on.delete("street");
    if (key === "street" && on) M.on.delete("camera");
    const mine = M, g = await osmData();
    mine.osmKinds = new Set((g ? g.features : []).map((f) => f.properties.kind));
    for (const k of Object.keys(LAYERS)) {
      const want = mine.on.has(k);
      if (want && !(k in mine.mapLayers)) mine.mapLayers[k] = await makeLayer(k);
      if (mine !== M) return;   // the player opened another mission meanwhile
      const l = mine.mapLayers[k];
      if (l) want ? l.addTo(missionMap) : missionMap.removeLayer(l);
    }
    renderLayers();
  }
  function renderLayers() {
    const box = $("#layer-list");
    const row = (k, label) => `<label class="sw"><input type="checkbox" data-layer="${k}" ${M.on.has(k) ? "checked" : ""}> ${label}</label>`;
    const glowNow = M.step >= 2 || M.lab;   // step 1 shows the plain pictures: nothing glows yet
    const radarRows = Object.entries(RADAR).filter(([k]) => k !== "glow" || glowNow).map(([k, label]) => row(k, label)).join("");
    const nOn = [...M.on].filter((k) => k in LAYERS || (k in RADAR && (k !== "glow" || glowNow))).length;
    $("#btn-layers").innerHTML = `${ART("ui-layers")}Map layers <b class="layer-count">${nOn} on</b>${box.hidden ? "" : " ✕"}`;
    box.innerHTML = `<p class="layer-head">Tap a switch to turn a layer on or off</p><p class="layer-group">Radar</p>${radarRows}<p class="layer-group">Map</p>` + Object.entries(LAYERS)
      .filter(([k]) => k !== "camera" || M.content.camera !== false)
      .filter(([k]) => !k.startsWith("wet_") || (M.content.layers || []).includes(k) || (M.content.offer || []).includes(k))   // only where it tells the story
      .filter(([k]) => !OSM_KIND[k] || !M.osmKinds || M.osmKinds.has(OSM_KIND[k]))   // hide OSM layers this place has none of
      .map(([k, label]) => row(k, label.replace("{before}", M.info.before.date).replace("{after}", M.info.after.date))).join("") +
      `<p class="muted small">${M.on.has("camera") ? `Photo from ${M.content.camera?.date || M.info.after.date}. ` : ""}` +
      `${M.on.has("camera") || M.on.has("street") ? "Untick it to see the radar again." : "Map data © OpenStreetMap"}</p>`;
    box.querySelectorAll("input[data-layer]").forEach((c) => c.addEventListener("change", () => { log("layer", { k: c.dataset.layer, on: c.checked }); setLayer(c.dataset.layer, c.checked); }));
  }
  $("#btn-layers").addEventListener("click", () => {
    $("#layer-list").hidden = !$("#layer-list").hidden;
    store.set("layersSeen", true); $("#btn-layers").classList.remove("nudge");   // it pulses until the first time it's opened
    renderLayers();
  });
  if (!store.get("layersSeen", false)) $("#btn-layers").classList.add("nudge");

  // step 1 bonus: could a normal camera see the ground that day? (content.json "camera": {"clouds": "yes" | "no"})
  function cameraQuestion() {
    const c = M.content.camera, box = $("#camera-kit");
    box.hidden = !(c && (c.clouds === "yes" || c.clouds === "no") && !M.got.camera);
    if (box.hidden) return;
    const date = c.date || M.info.after.date;
    box.innerHTML = `<p class="quiz-q">${ART("icon-camera")} Bonus: NASA's camera satellite flew over on ${date}. Can a normal camera see the ground?</p>
      <button id="cam-show" class="ghost small">📷 Show me the camera photo</button>
      <div class="quiz-a" hidden><button data-c="yes">☁️ No, clouds hide it</button><button data-c="no">🌍 Yes, I can see it</button></div>`;
    $("#cam-show").onclick = () => { setLayer("camera", true); $("#cam-show").hidden = true; box.querySelector(".quiz-a").hidden = false;
      say(`This is a normal photo from space, taken on ${date}. Can you see the ground, or only clouds?`); };
    box.querySelectorAll("button[data-c]").forEach((b) => (b.onclick = () => {
      const ok = b.dataset.c === c.clouds;
      if (ok) { award("camera", 100); sfx("hit"); react("happy"); } else { sfx("miss"); react("oops"); }
      say((ok ? "Right! " : "Look again: ") + (c.clouds === "yes"
        ? "Clouds hid everything from the camera. My radar waves fly right through clouds, so I could still see!"
        : "It was sunny, so the camera sees it too. But at night or under clouds, only radar can look.") + (c.note ? " " + c.note : ""));
      box.innerHTML = `<p class="muted">${ok ? `📷 +100! ` : "📷 "}${c.clouds === "yes" ? "Clouds for the camera, clear view for the radar." : "Sunny day: camera and radar both see."}</p>`;
      setTimeout(() => M.step === 1 && setLayer("camera", false), 3500);
    }));
  }

  function setPoints() { $("#m-points").textContent = M.points; }
  function award(key, pts, at) {
    if (M.got[key]) return;
    M.got[key] = true; M.points += pts; setPoints();
    if (at) floatText(at, `+${pts}`, "good");
  }

  const STEP_NAME = { 1: "👀 Step 1 of 4 · Look", 2: "✨ Step 2 of 4 · Make it glow", 3: "🎯 Step 3 of 4 · Find it" };
  function goStep(step) {
    M.step = step;
    // the first tip of each step pops up big in the middle (step 4 has its own "mission complete" pop-up)
    M.popNext = step < 4; M.popStory = step === 1 ? $("#m-story").textContent : "";
    M.popTitle = step === 1 ? `🛸 New mission: ${M.info.title || M.id}` : STEP_NAME[step];
    document.querySelectorAll(".steps li").forEach((li) => {
      li.classList.toggle("now", +li.dataset.step === step); li.classList.toggle("past", +li.dataset.step < step);
    });
    const spots = M.game.type === "spots";
    $("#glow-kit").hidden = step !== 2; $("#find-kit").hidden = !(step === 3 && spots); $("#result").hidden = step !== 4;
    $("#game-kit").hidden = !(step === 3 && !spots); if (step !== 3) { $("#game-kit").innerHTML = ""; M.onTap = null; }
    missionMap.dragging.enable(); if (M.cleanup) { M.cleanup(); M.cleanup = null; }
    $("#btn-prev").hidden = step !== 2;
    document.querySelectorAll("[data-step-only]").forEach((b) => (b.hidden = +b.dataset.stepOnly !== step));
    $("#btn-hint2").hidden = MODE !== "easy";
    $("#map-hud").hidden = !(step === 3 && spots);
    log("step", { step });
    $("#mission-map").classList.toggle("find-mode", step === 3);
    stopSwipe(); M.extra.forEach((l) => missionMap.removeLayer(l)); M.extra = []; M.foundLayer = null;
    if (M.on.has("camera") || M.on.has("street")) { M.on.delete("camera"); M.on.delete("street"); setLayer(); }   // show the radar again
    $("#camera-kit").hidden = true;
    renderLayers();   // the glow switch appears from step 2
    if (step === 4) guideClose();

    setCalm(step === 1 ? "wave" : step === 2 ? "think" : step === 3 ? "point" : "happy");
    if (!M.newsTouched) newsOpen(step === 1 || step === 4);
    if (step === 1) {
      startSwipe(); cameraQuestion();
      say("Slide the bar on the map: left = BEFORE, right = AFTER. Can you spot what changed? Tap a ? if you want me to explain.");
      next("Next: make it glow ✨", true);
    }
    if (step === 2) { refreshCards(); composite(); glowHint(); }
    if (step === 3) (spots ? startFind() : startGame());
    if (step === 4) score();
    if (step !== 4) $("#playtest").hidden = true;
  }

  const spots = () => !M.lab && M.game.type === "spots";
  function next(label, enabled) { const b = $("#btn-next"); b.textContent = label; b.disabled = !enabled; }
  $("#btn-next").addEventListener("click", () => {
    if (M.step === 2 && M.glasses === M.best) award("glasses", PTS.glasses);
    if (M.step === 3 && M.inBonus) return nextBonus();
    if (M.step === 3 && !spots() && !M.result) return M.finishGame && M.finishGame();
    if (M.step === 3 && spots() && !M.bonusQueue) return startBonuses();
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
    applyRadar();
    $("#swipe-bar").hidden = false;
    const clip = () => before.getElement() && (before.getElement().style.clipPath = `inset(0 ${100 - $("#swipe").value}% 0 0)`);
    before.once("load", clip); clip();
    $("#swipe").oninput = clip;
  }
  function stopSwipe() {
    if (M && M.swipe) { M.swipe.forEach((l) => missionMap.removeLayer(l)); M.swipe = null; }
    $("#swipe-bar").hidden = true;
    applyRadar();
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
    return M.tried.size < 2 ? ` Now switch your radar glasses and watch the glow-o-meter!`
      : M.glasses === M.best ? ` Your ${label(M.best)} glasses are the best ones here: +${PTS.glasses} bonus when you go on!`
      : ` Try both radar glasses: the glow-o-meter shows which one lights up more. (+${PTS.glasses} bonus for the best ones)`;
  }
  // ---------- the glow-o-meter: how much of the picture glows through each pair of radar glasses ----------
  // Each bar shows only after the player has tried those glasses. The pair that lights up more is this mission's best
  // (measured from the same layers the player sees, so the bonus always agrees with the meter).
  function glowShare(ch) {
    const a = (M.anaCache[ch] = M.anaCache[ch] || analyse(ch));
    return a.changed.reduce((n, v) => n + v, 0) / (a.bw * a.bh);
  }
  function glassesWhy() {   // explains whichever pair really won here (the meter measures the same layers the player sees)
    const { CO, CX } = M.info.channels, water = WATERY[M.info.topic];
    if (M.best === "CX") return `${CX} wins! Only leaves, branches and crops twist my wave the other way, so plants that grew or were cut change the most in ${CX}.`;
    return water
      ? `${CO} wins! Smooth water bounces my wave away like a mirror, so wet and flooded ground changes a lot in ${CO}. ${CX} changes less: there are few leaves to twist the wave.`
      : `${CO} wins here! My long L-band wave bounces off the ground and up the tree trunks or crop stems, then straight back: a "double bounce". ` +
        `Cut the trees or the crop and that bounce is gone, so ${CO} changes the most. ${CX} (twisted by leaves) changed too, just less.`;
  }
  function glowMeter() {
    const box = $("#glow-meter"), { CO, CX } = M.info.channels;
    box.hidden = CO === CX || !(M.buckets.red && M.buckets.cyan);
    if (box.hidden) return;
    const first = !M.tried.has(M.glasses) && M.tried.size === 1, shown = M.tried.size === 0;
    M.tried.add(M.glasses);
    if (shown) setTimeout(() => box.scrollIntoView({ block: "nearest", behavior: "smooth" }), 300);   // it sits below the buckets
    const share = { CO: glowShare("CO"), CX: glowShare("CX") }, top = Math.max(share.CO, share.CX) || 1, both = M.tried.size === 2;
    const row = (ch) => {
      const tried = M.tried.has(ch);
      return `<div class="gm-row${ch === M.glasses ? " now" : ""}${both && ch === M.best ? " win" : ""}">
        <span class="gm-label">${ART(ch === "CO" ? "badge-water" : "badge-leaf")}${ch === "CO" ? CO : CX}</span>
        <span class="gm-bar"><i style="width:${tried ? Math.max(3, (100 * share[ch]) / top) : 0}%"></i></span>
        <b>${tried ? `${Math.round(share[ch] * 100)} %` : "?"}</b>${both && ch === M.best ? ART("star-on") : ""}</div>`;
    };
    box.innerHTML = `<p class="gm-title">Glow-o-meter: how much of the picture glows?</p>${row("CO")}${row("CX")}
      <p class="muted small">${both ? glassesWhy() : "Now try the other glasses and compare!"}</p>`;
    if (first) { sfx("glow"); react("happy"); log("meter", { best: M.best }); }
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
    if (!M.measured && M.info.channels.CO !== M.info.channels.CX) { M.best = glowShare("CX") > glowShare("CO") ? "CX" : "CO"; M.measured = true; }
    glowMeter();
    if (M.tried.size === 2) {
      next("Next: find the glowing spots 🎯", true);
      return say(glassesWhy() + (M.glasses === M.best ? ` You're wearing them: +${PTS.glasses} bonus when you go on!` : " Switch to them for a bonus!"));
    }
    say(((M.content.say || {}).glow && red === "before" ? M.content.say.glow : red === "before"
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
      const a = R && C && M.game.glow !== "plain" ? analysis() : null;   // which blocks count ("plain": show every change as it is)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let r = R ? st(R.data[i]) : 0, c = C ? st(C.data[i]) : 0;
        if (a) {
          const bx = Math.min(a.bw - 1, (x / BLOCK) | 0), by = Math.min(a.bh - 1, (y / BLOCK) | 0);
          const m = (r + c) / 2;
          const k = by * a.bw + bx;
          if (!a.changed[k]) r = c = m;   // doesn't count -> plain grey
          else if (a.targetIds.has(a.labels[k])) { r = Math.max(0, Math.min(255, m + (r - m) * 1.8)); c = Math.max(0, Math.min(255, m + (c - m) * 1.8)); }   // a big spot -> strong glow
          // a small change keeps its normal colour: it glows a little
        }
        o[i] = r; o[i + 1] = c; o[i + 2] = c;
        o[i + 3] = Math.max(R ? R.data[i + 3] : 0, C ? C.data[i + 3] : 0);
      }
      const cv = el("canvas"); cv.width = W; cv.height = H; cv.getContext("2d").putImageData(out, 0, 0);
      url = cv.toDataURL("image/png");
    }
    M.glowUrl = url;
    if (!M.overlay) M.overlay = L.imageOverlay(url, M.bounds).addTo(missionMap);
    applyRadar();   // shows the glow, or the plain picture if the player switched the glow off
  }

  // ---------- step 3 · other games (public/js/games/<type>.js) ----------
  // per-block mean dB of one channel, for games that ask about places (quiz, lasso…)
  function blockStats(ch) {
    const B = M.layers[`before_${ch}`].data, A = M.layers[`after_${ch}`].data, W = B.width, H = B.height;
    const bw = Math.floor(W / BLOCK), bh = Math.floor(H / BLOCK);
    const before = new Float32Array(bw * bh), after = new Float32Array(bw * bh), valid = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let sb = 0, sa = 0, n = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
        const i = (y * W + x) * 4;
        if (!B.data[i + 3] || !A.data[i + 3]) continue;
        sb += B.data[i]; sa += A.data[i]; n++;
      }
      const k = by * bw + bx;
      if (n > (BLOCK * BLOCK) / 2) { valid[k] = 1; before[k] = sb / n / DB_PER_GREY - 35; after[k] = sa / n / DB_PER_GREY - 35; }
    }
    return { bw, bh, before, after, valid };
  }
  const gameApi = (cfg) => ({
    M, map: missionMap, kit: $("#game-kit"), cfg, say, award, floatText, sfx, react, next,
    analysis, blockStats, toBlock, toLatLng, starText, osm: osmData, setLayer,
    glasses: (ch) => { if (M.glasses !== ch && M.layers[`before_${ch}`]) { M.glasses = ch; composite(); M.ana = analysis(); } },
    layer: (l) => { M.extra.push(l); return l.addTo(missionMap); },
    done: (result) => { M.result = result; startBonuses(); },
  });
  function startGame() {
    const G = (window.SARbitGames || {})[M.game.type];
    if (!G) { say(`This mission's game (${M.game.type}) isn't loaded.`); return next("Score it ⭐", true); }
    composite();
    M.ana = analysis();
    const api = gameApi(M.game);
    M.finishGame = () => G.finish && G.finish(api);
    G.start(api);
  }

  // ---------- Radar Lab: extra games (missions/labs.json, js/games/lab.js) ----------
  // They skip Look and Glow: the lab is the whole game, then the score. Points are kept under "lab-<id>".
  function startLab() {
    const G = (window.SARbitLab || {})[M.lab.type];
    M.step = 3; stopSwipe(); setCalm("think");
    M.popNext = true; M.popTitle = `🧪 Radar Lab: ${M.lab.title}`; M.popStory = M.lab.blurb || "";
    ["#glow-kit", "#find-kit", "#result", "#camera-kit", "#map-hud", "#btn-prev"].forEach((sel) => ($(sel).hidden = true));
    $("#game-kit").hidden = false; $("#game-kit").innerHTML = "";
    newsOpen(false);
    if (!G) { say(`This lab (${M.lab.type}) isn't loaded.`); return next("Score it ⭐", true); }
    M.ana = analysis();
    const api = gameApi(M.lab);
    M.finishGame = () => G.finish && G.finish(api);
    log("lab", { id: M.lab.id });
    G.start(api);
  }

  // bonus questions after the game, about the real places around the change (content.json "bonus": a list,
  // see js/games/bonus.js), then the score
  function startBonuses() {
    if (M.bonusQueue || M.lab) return goStep(4);
    M.bonusQueue = [].concat(M.content.bonus || []);
    M.townsOn = M.on.has("towns");   // a bonus may hide the town names while it asks; they come back after
    if (M.cleanup) { M.cleanup(); M.cleanup = null; }
    M.onTap = null; clearHint();
    M.extra.forEach((l) => missionMap.removeLayer(l)); M.extra = []; M.foundLayer = null;   // the game's pins and loops
    if (spots()) drawFound(true);
    nextBonus();
  }
  function nextBonus() {
    (M.bonusLayers || []).forEach((l) => missionMap.removeLayer(l)); M.bonusLayers = [];
    if (M.townsOn && !M.on.has("towns")) setLayer("towns", true);
    const b = M.bonusQueue.shift(), B = b && (window.SARbitBonus || {})[b.type];
    if (!b) { M.inBonus = false; return goStep(4); }
    if (!B) return nextBonus();
    M.inBonus = true;
    $("#find-kit").hidden = true; $("#map-hud").hidden = true; $("#game-kit").hidden = false;
    log("bonus", { type: b.type });
    B.start({ ...gameApi(b), more: M.bonusQueue.length > 0, done: nextBonus,
      layer: (l) => { M.bonusLayers.push(l); return l.addTo(missionMap); } });
  }

  // ---------- step 3 · find the glowing spots ----------
  // The answer comes from the SAME layers the player sees, so whatever glows can be found.
  function analyse(ch) {
    const B = M.layers[`before_${ch}`].data, A = M.layers[`after_${ch}`].data, W = B.width, H = B.height;
    const bw = Math.floor(W / BLOCK), bh = Math.floor(H / BLOCK), changed = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, sa = 0, n = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
        const i = (y * W + x) * 4;
        if (!B.data[i + 3] || !A.data[i + 3]) continue;
        s += A.data[i] - B.data[i]; sa += A.data[i]; n++;
      }
      if (n <= (BLOCK * BLOCK) / 2) continue;
      const fx = (bx + 0.5) / bw, fy = (by + 0.5) / bh, [fx0, fy0, fx1, fy1] = M.focus;
      if (fx < fx0 || fx > fx1 || fy < fy0 || fy > fy1) continue;   // outside the mission's focus area
      const d = s / n / DB_PER_GREY, after = sa / n / DB_PER_GREY - 35, before = after - d, r = M.rule;
      const strong = r.sign < 0 ? d <= -r.db : r.sign > 0 ? d >= r.db : Math.abs(d) >= r.db;
      if (strong && after < r.water_max && before < (r.before_max ?? 99)) changed[by * bw + bx] = 1;
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
    return { W, H, bw, bh, labels, changed, targets, targetIds: new Set(targets.map((t) => t.id)) };
  }

  const analysis = () => (M.anaCache[M.glasses] = M.anaCache[M.glasses] || analyse(M.glasses));

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
    M.ana = analysis();
    M.found = new Set(); M.hearts = HEARTS; M.t0 = Date.now(); M.hintLayer = null;
    $("#targets").textContent = $("#hud-targets").textContent = M.ana.targets.length;
    if (window.innerWidth <= 820) setTimeout(() => $(".mission-map-wrap").scrollIntoView({ behavior: "smooth" }), 600);
    drawFound(false); updateFind();
    say(((M.content.say || {}).find || `I can see {n} big glowing spots. Tap right on them!`).replace("{n}", M.ana.targets.length) +
        " Careful: tapping where nothing glows costs a heart." +
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
    const R = M.result;
    const n = R ? R.total : M.ana ? M.ana.targets.length : 0, f = R ? R.got : M.found.size;
    const st = R && R.stars != null ? R.stars : !n ? 0 : f === n ? 3 : f >= n / 2 ? 2 : f >= 1 ? 1 : 0;
    if (M.ana && !R) drawFound(true);
    M.changeLayer = L.imageOverlay(M.base + M.info.change_overlay, M.bounds, { opacity: 0.55, interactive: false }).addTo(missionMap);
    M.extra.push(M.changeLayer); applyRadar();   // NISAR's change map is part of the glow layer
    scores[M.key] = Math.max(scores[M.key] || 0, M.points); stars[M.key] = Math.max(stars[M.key] || 0, st);
    savePlayer(); updateHud();
    if (st === 3) sfx("win");
    const cheer = st === 3 ? "Perfect! Amazing radar eyes! 🚀" : st === 2 ? "Great work, cadet! 👍" : st === 1 ? "Good start! 💪" : "Let's try again! 💪";
    $("#result").innerHTML = `<div class="stars">${starText(st)}</div><div class="big">${M.points} points</div>
      <p class="score-line"><b>${cheer}</b><br>${R ? R.line : `You found <b>${f}</b> of <b>${n}</b> glowing spots`}${M.got.glasses ? ", and picked the best radar glasses" : ""}.${M.bonusAsked ? `<br>⭐ Bonus questions: <b>${M.bonusRight}</b> of <b>${M.bonusAsked}</b> right` : ""}${M.got.camera ? "<br>📷 You knew what the camera could see." : ""}</p>
      ${R ? "" : `<div class="legend"><span><i style="background:#4be08a"></i>found</span><span><i style="background:#ffe14a"></i>missed</span><span><i style="background:#ff2828"></i>what NISAR measured</span></div>`}
      <p class="muted">Why? ${(M.lab && M.lab.why) || M.content.why || WHY[M.info.topic] || ""}</p>
      <p class="muted small">Mission done ✓ Each mission counts once.</p>`;
    if (PLAYTEST) playtestNotes(n, f, st);
    missionDone(st, cheer, R ? R.line : `You found <b>${f}</b> of <b>${n}</b> glowing spots`);
    M.result = null;
    react(st >= 2 ? "happy" : "oops");
    say((R ? "" : f < n ? "The yellow spots are the ones you missed: they glow too! " : "You found every spot! ") + ((M.lab && M.lab.why) || M.content.why || WHY[M.info.topic] || ""));
    next("Next mission 🌍", true);
  }

  // the "mission complete" pop-up: stars, points, and where to go next
  function missionDone(st, cheer, line) {
    const box = $("#done-pop"), title = M.lab ? M.lab.title : M.info.title || M.id;
    box.innerHTML = `<img class="done-alien" src="art/alien-${st >= 2 ? "happy" : "wave"}.webp" alt="">
      <p class="done-kicker">${M.lab ? "Radar Lab done" : "Mission complete!"}</p>
      <h2>${esc(title)}</h2>
      <div class="stars">${starText(st)}</div><div class="big">${M.points} points</div>
      <p><b>${cheer}</b><br>${line}.</p>
      <div class="actions"><button id="done-next">🌍 Next mission</button><button id="done-look" class="ghost">🔍 Look at my map</button></div>`;
    box.hidden = false; backdrop();
    $("#done-next").onclick = () => { box.hidden = true; backdrop(); openWorld(); };
    $("#done-look").onclick = () => { box.hidden = true; backdrop(); };
    $("#done-next").focus({ preventScroll: true });
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
    if (M && M.cleanup) { M.cleanup(); M.cleanup = null; }
    $("#end-text").textContent = `${player}, you cleaned ${missions.filter((m) => m.id in scores).length} of ${missions.length} places, earned ⭐ ${totalStars()} stars and ${total()} points.`;
    show("screen-end");
  }
  $("#btn-finish").addEventListener("click", finish);
  $("#btn-world-finish").addEventListener("click", finish);
  $("#btn-again").addEventListener("click", () => {
    scores = {}; stars = {}; savePlayer(); updateHud(); openWorld();
  });

  if (player) usePlayer(player);
  renderPlayers(); updateHud();
  if (location.hash.includes("debug")) window.SARBIT = { get M() { return M; }, get map() { return missionMap; }, openMission };
})();

/* SARbit Radar Lab: four extra games that teach how radar pictures are made and read.
   They are not part of the 4-step missions; the world screen lists them (missions/labs.json), each set at the mission
   where its idea shows best. Every answer is worked out here from the mission's own layers.
   paint    — put HH, HV and HH/HV into red, green and blue: make the forest green and the clearings purple
   detector — slide the change threshold (dB) until your flood map matches the one NISAR's team made
   speckle  — average neighbouring pixels: fewer grainy dots, but blurrier shores. Find the sweet spot
   echo     — four places, four echoes: sort them from the weakest echo to the strongest */
(() => {
  "use strict";
  const DB = (v) => v / 6.375 - 35, GREY = (db) => (db + 35) * 6.375, RATIO_DB = (v) => v / 12.75;

  function loadPixels(src) {
    return new Promise((ok, fail) => {
      const i = new Image(); i.onerror = fail;
      i.onload = () => {
        const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(i, 0, 0);
        ok(g.getImageData(0, 0, c.width, c.height));
      };
      i.src = src;
    });
  }
  // one picture layer on the map that the game repaints
  function canvasLayer(api, W, H, opts = {}) {
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d"), img = g.createImageData(W, H);
    let layer = null;
    return {
      img,
      show() {
        g.putImageData(img, 0, 0);
        const url = cv.toDataURL();
        if (layer) layer.setUrl(url);
        else layer = api.layer(L.imageOverlay(url, api.M.bounds, { interactive: false, ...opts }));
      },
    };
  }
  function boxMean(src, W, H, r) {   // mean of a (2r+1)² window, via an integral image
    const S = new Float64Array((W + 1) * (H + 1)), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0, row = 0; x < W; x++) { row += src[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
      out[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return out;
  }
  const stars = (s, api) => `<span class="stars">${api.starText(s)}</span>`;
  let audio = null;
  function beep(freq) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.frequency.value = freq; g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.5);
    } catch { /* no audio */ }
  }

  const LAB = (window.SARbitLab = window.SARbitLab || {});

  // ---------- 1 · paint with radar ----------
  LAB.paint = {
    async start(api) {
      const M = api.M, { CO, CX } = M.info.channels, A = M.layers.after_CO.data, X = M.layers.after_CX.data, W = A.width, H = A.height;
      const R = await loadPixels(M.base + M.info.layers.after.RATIO);
      // each layer stretched over its useful range here (measured on the Amazon pair: forest HH −6 / HV −11 dB, cut HH −15 / HV −22 dB)
      const lut = (f, lo, hi) => Uint8ClampedArray.from({ length: 256 }, (_, v) => ((f(v) - lo) / (hi - lo)) * 255);
      const LAYERS = {
        co: { label: CO, hint: "bounces off ground and buildings", data: A.data, lut: lut(DB, -24, -2) },
        cx: { label: CX, hint: "twisted by leaves and branches", data: X.data, lut: lut(DB, -22, -10) },
        ratio: { label: `${CO}÷${CX}`, hint: "big where there are few leaves", data: R.data, lut: lut(RATIO_DB, 4.5, 7.5) },
      };
      const pots = { r: null, g: null, b: null };
      let picked = null;
      const pic = canvasLayer(api, W, H);
      // what each place is, from the data: forest (lots of HV, not cut), cut (HV dropped ≥ 3 dB), water (very dark HH)
      const B = M.layers.before_CX.data, cls = new Uint8Array(W * H);   // 1 forest, 2 cut, 3 water
      for (let i = 0; i < W * H; i++) {
        if (!A.data[i * 4 + 3]) continue;
        const hh = DB(A.data[i * 4]), hv = DB(X.data[i * 4]), drop = DB(B.data[i * 4]) - hv;
        cls[i] = hh < -21 ? 3 : drop >= 3 && hv < -17 ? 2 : hv > -15 && drop < 1 ? 1 : 0;
      }
      function paint() {
        const o = pic.img.data;
        for (let i = 0; i < W * H; i++) {
          const k = i * 4;
          o[k] = pots.r ? LAYERS[pots.r].lut[LAYERS[pots.r].data[k]] : 0;
          o[k + 1] = pots.g ? LAYERS[pots.g].lut[LAYERS[pots.g].data[k]] : 0;
          o[k + 2] = pots.b ? LAYERS[pots.b].lut[LAYERS[pots.b].data[k]] : 0;
          o[k + 3] = A.data[k + 3];
        }
        pic.show();
      }
      function colours() {   // the average colour of each kind of place in the player's picture
        const sum = { 1: [0, 0, 0, 0], 2: [0, 0, 0, 0], 3: [0, 0, 0, 0] }, o = pic.img.data;
        for (let i = 0; i < W * H; i += 3) { const c = cls[i]; if (!c) continue; const s = sum[c]; s[0] += o[i * 4]; s[1] += o[i * 4 + 1]; s[2] += o[i * 4 + 2]; s[3]++; }
        return Object.fromEntries(Object.entries(sum).map(([c, s]) => [c, s[3] > 200 ? s.slice(0, 3).map((v) => v / s[3]) : null]));
      }
      function render() {
        const chip = (k) => `<button class="lab-chip${picked === k ? " picked" : ""}${Object.values(pots).includes(k) ? " used" : ""}" data-k="${k}">
          <b>${LAYERS[k].label}</b><small>${LAYERS[k].hint}</small></button>`;
        const pot = (p, name) => `<button class="lab-pot ${p}" data-p="${p}"><span>${name}</span>${pots[p] ? `<b>${LAYERS[pots[p]].label}</b>` : "<em>empty</em>"}</button>`;
        api.kit.innerHTML = `<p class="quiz-q">🎨 Make the forest <span class="g">GREEN</span> and the cut patches <span style="color:#c08cff">PURPLE</span>!</p>
          <p class="muted small">Tap a radar layer, then a paint pot. Every pot mixes into the picture on the map.</p>
          <div class="lab-chips">${chip("co")}${chip("cx")}${chip("ratio")}</div>
          <div class="lab-pots">${pot("r", "RED")}${pot("g", "GREEN")}${pot("b", "BLUE")}</div>
          <button id="lab-check" ${Object.values(pots).some(Boolean) ? "" : "disabled"}>Check my picture ✅</button>`;
        api.kit.querySelectorAll(".lab-chip").forEach((b) => (b.onclick = () => { picked = picked === b.dataset.k ? null : b.dataset.k; render(); }));
        api.kit.querySelectorAll(".lab-pot").forEach((b) => (b.onclick = () => {
          const p = b.dataset.p;
          if (!picked) { pots[p] = null; paint(); return render(); }   // tap a full pot with nothing picked = empty it
          Object.keys(pots).forEach((q) => pots[q] === picked && (pots[q] = null));
          pots[p] = picked; picked = null; api.sfx("glow"); paint(); render();
        }));
        api.kit.querySelector("#lab-check").onclick = check;
      }
      function check() {
        const c = colours(), green = (v) => v && v[1] > v[0] + 10 && v[1] > v[2] + 10, purple = (v) => v && v[0] > v[1] + 10 && v[2] > v[1] + 10;
        const dark = (v) => v && Math.max(...v) < 90;
        const tests = [["the forest is green", green(c[1])], ["the cut patches are purple", purple(c[2])]];
        if (c[3]) tests.push(["the river is dark", dark(c[3])]);
        const got = tests.filter((t) => t[1]).length;
        tests.forEach((t, i) => t[1] && api.award(`paint${i}`, 200));
        api.sfx(got === tests.length ? "win" : got ? "hit" : "miss"); api.react(got ? "happy" : "oops");
        api.kit.querySelector("#lab-check").insertAdjacentHTML("afterend", `<ul class="lab-result">${tests.map((t) => `<li>${t[1] ? "✅" : "❌"} ${t[0]}</li>`).join("")}</ul>`);
        api.say(got === tests.length ? `A real radar scientist's picture! Red = ${CO}, green = ${CX}, blue = ${CO}÷${CX}. Leaves twist the wave, so the forest is full of ${CX}: green. Cut patches lost their leaves: ${CX} drops and ${CO}÷${CX} grows, so red + blue = purple.`
          : `Not yet. Tip: leaves twist my wave, so the forest is bright in ${CX}. Which pot should ${CX} go in to make it green? Change the pots and check again.`);
        M.labResult = { got, total: tests.length };
        api.next("Score it ⭐", true);
        if (got === tests.length) api.kit.querySelector("#lab-check").disabled = true;
      }
      M.finishGame = () => { const r = M.labResult || { got: 0, total: 3 }; api.done({ got: r.got, total: r.total, line: `Your radar painting got <b>${r.got}</b> of <b>${r.total}</b> colours right` }); };
      api.say(`Radar has no colours: I measure echoes. Scientists paint three radar layers into red, green and blue. Your turn!`);
      api.next("Score it ⭐", true);
      paint(); render();
    },
  };

  // ---------- 2 · change detector ----------
  LAB.detector = {
    async start(api) {
      const M = api.M, A = M.layers.after_CO.data, Bf = M.layers.before_CO.data, W = A.width, H = A.height;
      const ref = await loadPixels(M.base + M.info.change_overlay);
      const delta = new Float32Array(W * H), truth = new Uint8Array(W * H), ok = new Uint8Array(W * H);
      let nTruth = 0;
      for (let i = 0; i < W * H; i++) {
        if (!A.data[i * 4 + 3] || !Bf.data[i * 4 + 3]) continue;
        ok[i] = 1; delta[i] = (A.data[i * 4] - Bf.data[i * 4]) / 6.375;
        truth[i] = (ref.data[i * 4 + 3] || 0) > 0; nTruth += truth[i];
      }
      const match = (thr) => {   // how well "darker by ≥ thr dB" matches our reference change map (F1: both found and tidy)
        let tp = 0, mine = 0;
        for (let i = 0; i < W * H; i++) if (ok[i] && delta[i] <= -thr) { mine++; tp += truth[i]; }
        const p = mine ? tp / mine : 0, r = nTruth ? tp / nTruth : 0;
        return { f1: p + r ? (2 * p * r) / (p + r) : 0, share: mine / (W * H) };
      };
      const best = [...Array(20)].map((_, i) => (i + 1) / 2).reduce((b, t) => (match(t).f1 > b.f1 ? { t, f1: match(t).f1 } : b), { t: 0.5, f1: -1 });
      const mineLayer = canvasLayer(api, W, H);   // made first, so the white outline sits on top of it
      // our reference change map (made from the NISAR data with a 3 dB rule) as a white outline
      const outline = canvasLayer(api, W >> 2, H >> 2), q = (x, y) => truth[Math.min(H - 1, y * 4) * W + Math.min(W - 1, x * 4)];
      for (let y = 1; y < (H >> 2) - 1; y++) for (let x = 1; x < (W >> 2) - 1; x++)
        if (q(x, y) && (!q(x - 1, y) || !q(x + 1, y) || !q(x, y - 1) || !q(x, y + 1))) outline.img.data.set([255, 255, 255, 230], (y * (W >> 2) + x) * 4);
      let thr = 0.5, raf = 0, locked = false;
      function draw() {
        const o = mineLayer.img.data;
        for (let i = 0; i < W * H; i++) o[i * 4 + 3] = ok[i] && delta[i] <= -thr ? 200 : 0;
        mineLayer.show();
        const m = match(thr);
        const box = api.kit.querySelector("#det-live");
        if (box) box.innerHTML = `Your map: <b>${(m.share * 100).toFixed(1)} %</b> of the picture is flood · matches the reference map: <b>${Math.round(m.f1 * 100)} %</b>`;
        M.labThr = { thr, f1: m.f1 };
      }
      for (let i = 0; i < W * H; i++) mineLayer.img.data.set([255, 225, 74, 0], i * 4);
      mineLayer.show(); outline.show();
      api.kit.innerHTML = `<p class="quiz-q">🎚 Build a flood detector! How much darker must a place get to count as flooded?</p>
        <p class="muted small">Yellow = your flood map. White line = a reference flood map we made from the NISAR data with a 3 dB rule. Make yellow fill the white line, without spilling.</p>
        <div class="lab-slider"><span>0.5 dB</span><input id="det-thr" type="range" min="0.5" max="10" step="0.5" value="0.5"><span>10 dB</span></div>
        <p class="lab-big">Darker by at least <b id="det-val">0.5</b> dB</p>
        <p id="det-live" class="small"></p>
        <button id="det-lock">Lock my detector 🔒</button>`;
      api.kit.querySelector("#det-thr").oninput = (e) => {
        thr = +e.target.value; api.kit.querySelector("#det-val").textContent = thr;
        clearTimeout(raf); raf = setTimeout(draw, 30);
      };
      api.kit.querySelector("#det-lock").onclick = () => {
        if (locked) return; locked = true;
        const f1 = match(thr).f1, s = f1 >= 0.85 * best.f1 ? 3 : f1 >= 0.65 * best.f1 ? 2 : f1 > 0.2 ? 1 : 0;
        api.award("detector", s * 200); api.sfx(s === 3 ? "win" : s ? "hit" : "miss"); api.react(s >= 2 ? "happy" : "oops");
        api.kit.querySelector("#det-thr").disabled = true;
        api.say(`${s === 3 ? "Spot on!" : "Locked."} The best setting here is about ${best.t} dB. Too low, and grainy radar noise looks like flood everywhere. Too high, and you miss real water. Scientists tune this number for every flood.`);
        M.labResult = { stars: s, f1 };
        api.next("Score it ⭐", true);
      };
      M.finishGame = () => {
        if (!locked) api.kit.querySelector("#det-lock").click();   // "Score it" without locking: score the setting on screen
        const r = M.labResult || { stars: 0, f1: M.labThr.f1 };
        api.done({ got: r.stars, total: 3, stars: r.stars, line: `Your flood detector matched the reference flood map by <b>${Math.round(r.f1 * 100)} %</b>` }); };
      api.say("Every radar picture is a bit grainy, so everything changes a little. Slide to choose how much darker a place must get before you call it flooded.");
      api.next("Score it ⭐", true);
      draw();
    },
  };

  // ---------- 3 · speckle cleaner ----------
  LAB.speckle = {
    start(api) {
      const M = api.M, A = M.layers.after_CO.data, W = A.width, H = A.height, SIZES = [0, 1, 2, 3, 4, 6, 8];
      const g = new Float32Array(W * H), ok = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) { g[i] = A.data[i * 4]; ok[i] = A.data[i * 4 + 3] ? 1 : 0; }
      const cut = GREY(-18), lo = GREY(-20), hi = GREY(-15), REACH = 40;
      // for each window: grainy dots (pixels unlike most of their neighbours) and how blurry the shore is
      // (how many pixels the step from water, below −20 dB, to land, above −15 dB, takes along each row;
      // when the shore is so smeared that land never gets that bright, it counts as the blurriest)
      const runs = SIZES.map((r) => {
        const f = r ? boxMean(g, W, H, r) : g, wet = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) wet[i] = f[i] < cut;
        let dots = 0, steps = 0, width = 0;
        for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) {
          const i = y * W + x;
          if (!ok[i]) continue;
          let same = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) same += wet[i + dy * W + dx] === wet[i];
          if (same <= 3) dots++;
        }
        for (let y = 0; y < H; y += 3) for (let x = 0; x < W - REACH; x++) {
          const i = y * W + x;
          if (!ok[i] || !(f[i] < lo && f[i + 1] >= lo)) continue;   // the water starts to brighten here…
          for (let j = 1; j < REACH; j++) { if (f[i + j] < lo) break; if (f[i + j] > hi) { steps++; width += j; break; } }   // …land reached after j pixels
        }
        return { r, f, wet, dots, blur: steps > 20 ? width / steps : REACH };
      });
      const d0 = Math.max(1, runs[0].dots), bMin = Math.min(...runs.map((x) => x.blur)), bMax = Math.max(...runs.map((x) => x.blur));
      runs.forEach((x) => (x.score = x.dots / d0 + (x.blur - bMin) / Math.max(0.01, bMax - bMin)));   // both 0 (good) … 1 (bad)
      const bestI = runs.reduce((b, x, i) => (x.score < runs[b].score ? i : b), 0);
      const pic = canvasLayer(api, W, H);
      let at = 0, locked = false;
      function draw() {
        const x = runs[at], o = pic.img.data;
        for (let i = 0; i < W * H; i++) {
          const v = Math.max(0, Math.min(255, ((DB(x.f[i]) + 25) / 25) * 255)), k = i * 4;
          if (x.wet[i]) { o[k] = v * 0.35; o[k + 1] = v * 0.6 + 40; o[k + 2] = 200; } else { o[k] = o[k + 1] = o[k + 2] = v; }
          o[k + 3] = ok[i] ? 255 : 0;
        }
        pic.show();
        const bar = (v, max) => `<span class="gm-bar"><i style="width:${Math.min(100, (100 * v) / max)}%"></i></span>`;
        api.kit.querySelector("#sp-live").innerHTML = `<div class="gm-row"><span class="gm-label">Grainy dots</span>${bar(x.dots, d0)}<b>${x.dots}</b></div>
          <div class="gm-row"><span class="gm-label">Blurry shore</span>${bar(x.blur - bMin + 0.3, bMax - bMin + 0.3)}<b>${x.blur.toFixed(1)} px</b></div>`;
        api.kit.querySelector("#sp-val").textContent = `${2 * x.r + 1} × ${2 * x.r + 1}`;
      }
      api.kit.innerHTML = `<p class="quiz-q">✨ Clean the speckle! Radar pictures are grainy. Averaging neighbours makes them smooth… but too much blurs the shore.</p>
        <p class="muted small">Blue = water, grey = land and marsh. Find the setting with few grainy dots AND a sharp shore.</p>
        <div class="lab-slider"><span>raw</span><input id="sp-k" type="range" min="0" max="${SIZES.length - 1}" step="1" value="0"><span>very smooth</span></div>
        <p class="lab-big">Average over <b id="sp-val">1 × 1</b> pixels</p>
        <div id="sp-live" class="glow-meter"></div>
        <button id="sp-lock">This is the best one 🔒</button>`;
      api.kit.querySelector("#sp-k").oninput = (e) => { at = +e.target.value; draw(); };
      api.kit.querySelector("#sp-lock").onclick = () => {
        if (locked) return; locked = true;
        const off = Math.abs(at - bestI), s = off === 0 ? 3 : off === 1 ? 2 : 1;
        api.award("speckle", s * 200); api.sfx(s === 3 ? "win" : "hit"); api.react(s >= 2 ? "happy" : "oops");
        api.kit.querySelector("#sp-k").disabled = true;
        const b = runs[bestI].r * 2 + 1;
        api.say(`${s === 3 ? "Perfect!" : "Good try!"} The sweet spot here is ${b} × ${b} pixels. Radar echoes from many tiny things mix, so every pixel flickers: that's speckle. Scientists average neighbouring pixels ("multi-looking"), but not too many, or the edges get fuzzy.`);
        M.labResult = { stars: s, b };
        api.next("Score it ⭐", true);
      };
      M.finishGame = () => {
        if (!locked) api.kit.querySelector("#sp-lock").click();   // "Score it" without locking: score the window on screen
        const r = M.labResult || { stars: 0, b: runs[bestI].r * 2 + 1 };
        api.done({ got: r.stars, total: 3, stars: r.stars, line: `You cleaned the speckle; the best window here was <b>${r.b} × ${r.b}</b> pixels` }); };
      api.say("Look how grainy the radar is! Slide to average neighbouring pixels and watch the grainy dots and the shore.");
      api.next("Score it ⭐", true);
      draw();
    },
  };

  // ---------- 4 · echo sorter ----------
  LAB.echo = {
    start(api) {
      const M = api.M, s = api.blockStats("CO"), x = api.blockStats("CX"), { CO, CX } = M.info.channels;
      // pick one clear example of each: smooth water, bare field, trees and plants, buildings (3 × 3 blocks that agree)
      const calm = (k, arr, tol) => { const bx = k % s.bw, by = (k / s.bw) | 0;
        if (bx < 3 || by < 3 || bx > s.bw - 4 || by > s.bh - 4) return false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = k + dy * s.bw + dx; if (!s.valid[j] || Math.abs(arr[j] - arr[k]) > tol) return false; }
        return true; };
      const pick = (test, score, tol) => { let best = -1, bv = -1e9;
        for (let k = 0; k < s.valid.length; k++) if (s.valid[k] && test(k) && calm(k, s.after, tol) && score(k) > bv) { bv = score(k); best = k; }
        return best; };
      const KINDS = [
        { name: "Smoothest: water or flat mud", emoji: "💧", k: pick((k) => s.after[k] < -18, (k) => -s.after[k], 2) },
        { name: "Smooth: bare field", emoji: "🟫", k: pick((k) => s.after[k] > -15 && s.after[k] < -11 && x.after[k] < -19, (k) => -x.after[k], 1.5) },   // little HV: no plants
        { name: "Rough: plants, trees or rocks", emoji: "🌳", k: pick((k) => s.after[k] < -5 && s.after[k] > -10 && x.after[k] > -14, (k) => x.after[k], 2.5) },
        { name: "Corner mirrors: buildings", emoji: "🏘", k: pick((k) => s.after[k] > -3, (k) => s.after[k], 6) },
      ].filter((p) => p.k >= 0);
      KINDS.forEach((p) => (p.db = s.after[p.k]));
      let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const places = KINDS.slice().sort(() => rnd() - 0.5).map((p, i) => ({ ...p, letter: "ABCD"[i], ll: api.toLatLng((p.k % s.bw) + 0.5, ((p.k / s.bw) | 0) + 0.5) }));
      const truth = places.slice().sort((a, b) => a.db - b.db), order = [];
      const pin = (p, cls) => L.divIcon({ className: `quiz-pin ${cls}`, html: `<i></i><span>${p.letter}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const markers = places.map((p) => api.layer(L.marker(p.ll, { icon: pin(p, ""), zIndexOffset: 500 }).on("click", () => listen(p))));
      api.map.flyToBounds(L.latLngBounds(places.map((p) => p.ll)).pad(0.3), { duration: 0.6 });
      function listen(p) {   // a strong echo is a high beep, a weak echo a low one
        beep(180 + ((p.db + 30) / 30) * 1000); p.heard = true;
        markers[places.indexOf(p)].setIcon(pin(p, "now"));
        api.floatText(p.ll, "echo!", "meh"); render();
      }
      function render() {
        api.kit.innerHTML = `<p class="quiz-q">🔊 Echo sorter! Tap A, B, C and D on the map to hear their radar echo. Then sort them from the WEAKEST echo to the STRONGEST.</p>
          <p class="muted small">Low beep = weak echo, high beep = strong echo. Tap the letters below in order.</p>
          <div class="lab-chips">${places.map((p) => `<button class="lab-chip${order.includes(p) ? " used" : ""}" data-l="${p.letter}"><b>${p.letter}</b><small>${p.heard ? "heard ✓" : "tap it on the map"}</small></button>`).join("")}</div>
          <p class="lab-big">Weakest → strongest: <b>${order.map((p) => p.letter).join(" → ") || "…"}</b></p>
          <p><button id="echo-undo" class="ghost small" ${order.length ? "" : "disabled"}>${"<img class=\"ico\" src=\"art/ui-undo.webp\" alt=\"\">"}Undo</button>
          <button id="echo-check" ${order.length === places.length ? "" : "disabled"}>Check my order ✅</button></p>`;
        api.kit.querySelectorAll(".lab-chip").forEach((b) => (b.onclick = () => {
          const p = places.find((q) => q.letter === b.dataset.l);
          if (!order.includes(p)) { order.push(p); listen(p); }
        }));
        api.kit.querySelector("#echo-undo").onclick = () => { order.pop(); render(); };
        api.kit.querySelector("#echo-check").onclick = check;
      }
      function check() {
        const right = order.filter((p, i) => p === truth[i]).length;
        if (right) api.award("echo", right * 150);
        api.sfx(right === places.length ? "win" : right ? "hit" : "miss"); api.react(right >= places.length / 2 ? "happy" : "oops");
        places.forEach((p, i) => markers[i].setIcon(pin(p, order[truth.indexOf(p)] === p ? "ok" : "bad")));
        api.kit.innerHTML = `<p class="quiz-q">${right === places.length ? "Perfect radar ears! 🎧" : `${right} of ${places.length} in the right place.`}</p>
          <ol class="tm-answer">${truth.map((p) => `<li><span><b>${p.letter} · ${p.emoji} ${p.name}</b> · ${p.db.toFixed(0)} dB</span></li>`).join("")}</ol>
          <p class="muted small">Turn on 🗺 Layers → NASA camera photo to see what is really there.</p>`;
        api.say(`Smooth water sends my wave away like a mirror: the weakest echo. Bare fields send a little back, trees and plants scatter more, and buildings make walls and streets into corner mirrors: the strongest echo of all.`);
        M.labResult = { right, total: places.length };
        api.next("Score it ⭐", true);
      }
      M.finishGame = () => { const r = M.labResult || { right: 0, total: places.length };
        api.done({ got: r.right, total: r.total, line: `You sorted <b>${r.right}</b> of <b>${r.total}</b> echoes` }); };
      if (places.length < 3) { api.say("I couldn't find four clear places here."); return api.next("Score it ⭐", true); }
      api.say(`I measured the ${CO} echo of four places. Listen to each one, then sort them. (${CX} is for another day!)`);
      api.next("Score it ⭐", true);
      render();
    },
  };
})();

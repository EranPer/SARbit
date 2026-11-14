/* SARbit game "order": a season time machine. Three radar pictures of the same place are shuffled; the player
   puts them in time order using clues about what each season looks like to the radar.
   content.json: "game": {"type": "order", "frames": [{"date": "...", "image": "frame_x.png", "clue": "..."}, ...]}
   (frames listed in the right order; the game shuffles them) */
(() => {
  "use strict";
  const LETTERS = ["A", "B", "C", "D"];

  (window.SARbitGames = window.SARbitGames || {}).order = {
    start(api) {
      const M = api.M, frames = api.cfg.frames || [];
      let seed = [...M.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 11);
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      let deck = frames.map((f, n) => ({ ...f, n })).sort(() => rnd() - 0.5);
      if (deck.every((f, i) => f.n === i)) deck = [deck[1], deck[2], deck[0], ...deck.slice(3)];   // never start solved
      deck.forEach((f, i) => (f.letter = LETTERS[i]));
      const slots = frames.map(() => null);
      let picked = null, overlay = null;

      const showOnMap = (f) => {
        if (overlay) overlay.setUrl(M.base + f.image);
        else overlay = api.layer(L.imageOverlay(M.base + f.image, M.bounds));
        api.say(`This is picture ${f.letter}. Dark = water or smooth ground, bright green = tall plants, pink/white = buildings.`);
      };
      function render() {
        const card = (f) => `<div class="tm-card${picked === f ? " picked" : ""}" data-l="${f.letter}">
            <img src="${M.base + f.image}" alt=""><b>${f.letter}</b></div>`;
        api.kit.innerHTML = `<p class="quiz-q">Put the pictures in time order: first → last.</p>
          <ol class="tm-clues">${frames.map((f) => `<li>${f.clue}</li>`).join("")}</ol>
          <div class="tm-deck">${deck.filter((f) => !slots.includes(f)).map(card).join("") || '<p class="muted">All placed!</p>'}</div>
          <div class="tm-slots">${slots.map((f, i) => `<div class="tm-slot" data-i="${i}"><span>${i + 1}${["st", "nd", "rd", "th"][Math.min(i, 3)]}</span>${f ? card(f) : '<em>tap a picture, then here</em>'}</div>`).join("")}</div>
          <button id="tm-check" ${slots.includes(null) ? "disabled" : ""}>Check my order ✅</button>`;
        api.kit.querySelectorAll(".tm-card").forEach((c) => c.addEventListener("click", (e) => {
          e.stopPropagation();
          const f = deck.find((d) => d.letter === c.dataset.l);
          const at = slots.indexOf(f);
          if (at >= 0) { slots[at] = null; picked = f; }      // take it back out of a slot
          else picked = picked === f ? null : f;
          showOnMap(f); render();
        }));
        api.kit.querySelectorAll(".tm-slot").forEach((s) => s.addEventListener("click", () => {
          if (!picked) return;
          const i = +s.dataset.i;
          const prev = slots.indexOf(picked);
          if (prev >= 0) slots[prev] = null;
          slots[i] = picked; picked = null;   // a card already in slot i goes back to the deck
          api.sfx("meh"); render();
        }));
        const chk = api.kit.querySelector("#tm-check");
        if (chk) chk.addEventListener("click", check);
      }
      function check() {
        let right = 0;
        slots.forEach((f, i) => {
          const ok = f.n === i;
          if (ok) { right++; api.award(`slot${i}`, 200); }
        });
        const all = right === frames.length;
        api.sfx(all ? "win" : right ? "hit" : "miss"); api.react(all ? "happy" : "oops");
        api.kit.innerHTML = `<p class="quiz-q">${all ? "Perfect time travel! 🚀" : `${right} of ${frames.length} in the right place.`}</p>
          <ol class="tm-answer">${frames.map((f) => `<li><img src="${M.base + f.image}" alt=""><span><b>${f.date}</b><br>${f.clue}</span></li>`).join("")}</ol>`;
        api.say(all ? "You read the seasons like a real radar scientist!" : "Here is the real order. Look how the brightness changes with the crop.");
        api.next("Score it ⭐", true);
        M.order = { right, total: frames.length };
        M.finishGame = () => api.done({ got: right, total: frames.length, line: `You put <b>${right}</b> of <b>${frames.length}</b> pictures in the right place` });
      }
      api.next("Score it ⭐", false);
      render();
      showOnMap(deck[0]);
      api.say("Time machine! These are three radar pictures of the same farms at different times. Read the clues and put them in order.");
    },
    finish(api) {
      const o = api.M.order || { right: 0, total: (api.cfg.frames || []).length };
      api.done({ got: o.right, total: o.total, line: `You put <b>${o.right}</b> of <b>${o.total}</b> pictures in the right place` });
    },
  };
})();

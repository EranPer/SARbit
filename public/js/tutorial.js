/* SARbit tutorial: the training mission (content.json "tutorial": true, today the Jezreel Valley, A3).
   The alien leads the player hand by hand: one card at a time, one idea about SAR per card, and the player does
   every action themselves (move the slider, drop the cards, switch glasses, answer the first pin).
   Cards are big pop-ups in the middle (to read) or the tip bubble (to do something, with the button glowing).
   app.js sends every game event as a window "sarbit" event; this file only listens and talks. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const core = () => window.SARbitCore;
  const RED = '<b style="color:#ff5a5a">', CYAN = '<b style="color:#7cf3c7">';
  const day = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  // ---------- the cards ----------
  // step: the mission step it belongs to · pop: big in the middle (else the tip bubble) · target: what glows
  // button: a Next button · wait(e, M): the player's action that moves on · skip: a "skip" button for optional actions
  // when(M): show only if true · nudge: what to say when the player does something else
  function script(M) {
    const { CO, CX } = M.info.channels, b = day(M.info.before.date), a = day(M.info.after.date);
    return [
      { step: 1, pop: true, face: "wave", title: "Welcome to radar school", button: "Let's start ▶",
        text: `Hi cadet! Before the real missions, let's train together in the <b>Jezreel Valley</b> in Israel: farm fields so rich ` +
          `they call it the <b>breadbasket of Israel</b>. I'll show you every button, one at a time. Nothing can go wrong here!` },
      { step: 1, pop: true, face: "think", title: "What is SAR?", button: "Cool! ▶",
        text: `Normal cameras in space need <b>sunlight</b> and a <b>clear sky</b>. My radar is different: it <b>shouts invisible ` +
          `microwaves</b> at the ground and <b>listens for the echo</b>, like a bat. That's <b>SAR</b>: Synthetic Aperture Radar. ` +
          `It works <b>at night</b> and <b>through clouds</b>.` },
      { step: 1, pop: true, face: "point", title: "Why \"synthetic aperture\"?", button: "Next ▶",
        text: `A sharp radar picture would need an antenna <b>kilometres long</b>! So the satellite listens to echoes all along its ` +
          `flight, and a computer adds them up as if the antenna were that long. These pictures come from <b>NISAR</b>, ` +
          `a NASA and ISRO satellite with a 12-metre golden antenna.` },
      { step: 1, title: "Bright and dark", target: "#mission-map", button: "Got it ▶",
        text: `This grey picture on the map is radar. <b>Bright</b> = a strong echo: rough things like tall crops, trees and houses ` +
          `bounce my wave back. <b>Dark</b> = a weak echo: smooth things like water or flat bare soil bounce it away, like a mirror.` },
      { step: 1, title: "Step 1 · Look: move the slider", target: "#swipe-bar", wait: (e) => e.ev === "swipe" && e.count >= 4,
        text: `There are <b>two</b> radar pictures here: <b>BEFORE</b> (${b}) and <b>AFTER</b> (${a}). ` +
          `Drag the <b>slider</b> at the top right of the map, left and right.` },
      { step: 1, title: "What changed?", target: "#mission-map", button: "Next ▶",
        text: `Left of the line = June, right = October. Each little square is a <b>field</b>. Did some fields turn <b>darker</b>? ` +
          `In June the crops stood tall and rough: strong echo. After the <b>harvest</b> the soil is bare and smooth: weak echo.` },
      { step: 1, title: "Could a normal camera see it?", target: "#cam-show", wait: (e) => e.ev === "camera-show", skip: "Skip ▶",
        when: () => !$("#camera-kit").hidden && $("#cam-show"),
        text: `Press <b>📷 Show me the camera photo</b> on the left. It's a normal photo from space, taken the same week.` },
      { step: 1, title: "Your answer", target: "#camera-kit", wait: (e) => e.ev === "camera", skip: "Skip ▶",
        when: () => !$("#camera-kit").hidden && $("#camera-kit button[data-c]"),
        text: `Can you see the fields in the photo? Answer on the left. (Summer in Israel is sunny… but under storm clouds, ` +
          `only radar would see the ground!)` },
      { step: 1, title: "Map layers", target: "#btn-layers", wait: (e) => e.ev === "layer", skip: "Skip ▶",
        leave: () => !$("#layer-list").hidden && $("#btn-layers").click(),   // fold the list away again
        text: `One more tool: <b>🗺 Map layers</b>, top left of the map. Open it and switch a layer on or off, like <b>Roads</b>. ` +
          `Real maps can go on top of the radar.` },
      { step: 1, title: "On to step 2", target: "#btn-next", wait: (e) => e.ev === "step" && e.step === 2,
        text: `Great looking, cadet! Press the green <b>Next: make it glow ✨</b> button on the left.` },

      { step: 2, pop: true, face: "think", title: "Step 2 · Make it glow", button: "Show me ▶",
        text: `Finding changes between two grey pictures is hard, even for scientists. So they use a <b>colour trick</b>: ` +
          `paint the BEFORE picture ${RED}red</b> and the AFTER picture ${CYAN}blue-green</b>, and put one on top of the other.` },
      { step: 2, title: "BEFORE into RED", target: '.card[data-date="before"], .bucket.red',
        wait: (e, M) => M.buckets.red === "before", nudge: (e) => e.ev === "drop" && "Almost! The <b>BEFORE</b> card goes into the <b>RED</b> bucket.",
        text: `Drag the <b>BEFORE</b> card into the ${RED}RED</b> bucket. (Or tap the card, then tap the bucket.)` },
      { step: 2, title: "AFTER into BLUE-GREEN", target: '.card[data-date="after"], .bucket.cyan',
        wait: (e, M) => M.buckets.red === "before" && M.buckets.cyan === "after",
        nudge: (e) => e.ev === "drop" && "Almost! BEFORE in red, <b>AFTER</b> in <b>blue-green</b>.",
        text: `Now drag the <b>AFTER</b> card into the ${CYAN}BLUE-GREEN</b> bucket.` },
      { step: 2, title: "It glows!", target: "#mission-map", button: "I see it ▶",
        text: `Where a field <b>didn't change</b>, red and blue-green are equal and mix into <b>grey</b>. Where the echo was strong ` +
          `in June and weak in October, ${RED}red wins</b>: that field glows red, so it was <b>harvested</b>. ` +
          `Blue-green would mean it got brighter, like a new crop growing.` },
      { step: 2, title: "Radar glasses", target: ".glasses", wait: (e) => e.ev === "glasses" && e.ch === "CX",
        nudge: (e) => e.ev === "glasses" && `Now try the <b>${CX}</b> glasses!`,
        text: `My radar sends waves that wiggle <b>flat</b> (H). <b>${CO}</b> glasses hear the echo that comes back flat: good for ` +
          `water and soil. <b>${CX}</b> glasses hear the echo that comes back <b>upright</b>: only leaves and stems twist my wave ` +
          `like that. Tap <b>${CX} plants</b>!` },
      { step: 2, title: "Glow-o-meter", target: "#glow-meter", button: "Next ▶", when: () => !$("#glow-meter").hidden,
        // the winner is measured on this very picture (app.js glowShare), never assumed
        text: (M) => `The <b>glow-o-meter</b> on the left measures how much glows with each pair of glasses. Here ` +
          `<b>${M.best === "CX" ? CX : CO}</b> wins. Both see the harvest in different ways: <b>${CO}</b> hears the ` +
          `"double bounce" (ground, then up the crop stems, then straight back), and <b>${CX}</b> hears leaves twisting ` +
          `my wave. Comparing them is called <b>polarisation</b>, a real SAR trick.` },
      { step: 2, title: "On to step 3", target: "#btn-next", wait: (e) => e.ev === "step" && e.step === 3,
        text: `In the next step I'll wear the <b>${CX}</b> glasses: they answer one question very well, ` +
          `"are the plants still there?". Press <b>Next</b>: now you check real fields yourself!` },

      { step: 3, pop: true, face: "point", title: "Step 3 · Be the scientist", button: "I'm ready ▶",
        text: `Now you check real fields, like NISAR's science team. I put <b>numbered pins</b> on fields. For each pin: ` +
          `${RED}glows red</b> → it was <b>harvested</b>. <b>Grey</b> → it <b>stayed the same</b>. Not sure? ` +
          `Press <b>👀 BEFORE</b> and <b>AFTER</b> to compare.` },
      { step: 3, title: "Pin 1", target: "#game-kit .quiz-a", wait: (e) => e.ev === "quiz-answer", release: true,
        text: `Pin 1 is blinking <b>yellow</b> on the map. Look at its colour, then pick your answer on the left.` },
      { step: 3, final: true },   // from here the quiz talks by itself; the training ends with the score
    ];
  }

  // ---------- the engine ----------
  let cards = [], i = -1, M = null, active = false, count = 0;
  const visible = () => cards.filter((c) => !c.final);

  function clearTargets() { document.querySelectorAll(".tut-target").forEach((x) => x.classList.remove("tut-target")); }
  function okButton(label) {
    const ok = $("#btn-guide-ok");
    ok.textContent = label || "Got it, let's go! 👍";
    ok.classList.toggle("tut-show", !!label);
  }

  function show() {
    const c = cards[i];
    clearTargets();
    if (!c) return;
    if (c.final) { M.tutHold = false; M.tutNext = null; M.popTitle = ""; okButton(null); $("#guide-title").hidden = true; return; }
    if (c.when && !c.when(M)) return next();
    M.tutHold = true; count = 0;
    const n = visible().indexOf(c) + 1, title = `🎓 ${n}/${visible().length} · ${c.title}`;
    if (c.face) core().setCalm(c.face);
    M.popTitle = title; M.popStory = "";   // also when the player taps the small alien to see this card big
    if (c.pop) {
      core().guideMode("pop");
    } else {
      core().guideMode("bubble");
      $("#guide-title").hidden = false; $("#guide-title").textContent = title;
      $("#guide-story").hidden = true;
    }
    $("#guide-text").innerHTML = typeof c.text === "function" ? c.text(M) : c.text;
    okButton(c.button || c.skip || (c.pop ? "Next ▶" : null));
    if (c.target) document.querySelectorAll(c.target).forEach((x, k) => {
      x.classList.add("tut-target");
      if (k === 0 && x.closest(".mixer")) x.scrollIntoView({ block: "center", behavior: "smooth" });   // centre: the sticky Next bar hides the bottom
    });
    // "Next" in a pop-up moves on; a card that waits for the player only shrinks back to the bubble
    M.tutNext = () => (c.wait && !c.pop ? show() : next());
  }
  function next() { const c = cards[i]; if (c && c.leave) c.leave(); i++; show(); }
  function jumpTo(step) { i = cards.findIndex((c) => c.step === step); if (i < 0) i = cards.length - 1; show(); }

  function start() {
    M = core().M; cards = script(M); i = 0; active = true;
    document.body.classList.add("tut-on");
    core().newsOpen && core().newsOpen(false); M.newsTouched = true;   // the news waits: one thing at a time
    if (!$("#tut-skip")) {
      const s = document.createElement("button");
      s.id = "tut-skip"; s.className = "ghost small"; s.textContent = "Skip training";
      s.addEventListener("click", stop);
      $("#guide-panel .guide-body").appendChild(s);
    }
    show();
  }
  function stop() {
    if (!active) return;
    active = false; clearTargets(); okButton(null);
    document.body.classList.remove("tut-on");
    const s = $("#tut-skip"); if (s) s.remove();
    if (M) { M.tutHold = false; M.tutNext = null; }
    if ($("#guide-panel").classList.contains("pop")) core().guideMode("bubble");
    $("#guide-title").hidden = true;
  }

  function onEvent(e) {
    const m = core() && core().M;
    if (e.ev === "step") {
      if (e.step === 1 && m && m.tutorial && (!active || m !== M)) return setTimeout(start, 0);
      if (!active) return;
      if (m !== M) return stop();          // another mission
      if (e.step === 4) return stop();     // the score: "Training complete" takes over
    }
    if (!active || m !== M) return;
    const c = cards[i];
    if (!c || c.final) return;
    e.count = ++count;
    if (c.wait && c.wait(e, M)) {
      if (c.release) M.tutHold = false;     // the game's own answer to this action must be heard
      return setTimeout(next, 450);        // after the game has had its say
    }
    if (e.ev === "step" && e.step !== c.step) return setTimeout(() => jumpTo(e.step), 0);   // the player went on (or back)
    const tip = c.nudge && c.nudge(e);
    if (tip) setTimeout(() => { $("#guide-text").innerHTML = tip; }, 0);
  }
  window.addEventListener("sarbit", (ev) => onEvent({ ...ev.detail }));

  // the quiz's answer buttons, and "Next" in the bubble (the pop-up's Next goes through app.js → M.tutNext)
  document.addEventListener("click", (ev) => {
    if (!active) return;
    if (ev.target.closest("#game-kit .quiz-a button[data-k]")) onEvent({ ev: "quiz-answer" });
    if (ev.target.closest("#btn-guide-ok") && !$("#guide-panel").classList.contains("pop")) {
      ev.stopPropagation(); next();
    }
  }, true);
  // leaving the mission screen ends the training (it starts again next time the mission opens)
  document.addEventListener("click", (ev) => { if (active && ev.target.closest("#btn-back, #btn-finish, #hud-name")) stop(); }, true);
})();

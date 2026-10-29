/* Bug Hunt Arena client. Talks only to /.netlify/functions/game. */
(() => {
  "use strict";
  const API = "/.netlify/functions/game";
  const LS_KEY = "bha-session-v1";
  const LANGS = [["python", "Python"], ["javascript", "JavaScript"], ["java", "Java"], ["c", "C"], ["mixed", "Mixed"]];
  const LANG_NAME = Object.fromEntries(LANGS);
  const DIFF_NAME = { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert" };
  const NETWORK_MSG = "We can't reach the server. Check your connection and try again.";

  const app = document.getElementById("app");
  const netEl = document.getElementById("net");
  const toastEl = document.getElementById("toast");

  let session = loadSession();
  let state = null;
  let offset = 0; // serverNow - Date.now()
  let view = session ? "room" : "home";
  let howtoReturn = "home";
  let lastKey = "";
  let inflight = false;
  let failures = 0;
  let lastNoticeId = null;
  let localPick = null;
  let reviewTab = "mine";
  let homeError = { create: "", join: "" };
  let chosenLang = "python";
  const form = { cname: "", jcode: (new URLSearchParams(location.search).get("room") || "").toUpperCase().slice(0, 6), jname: "" };
  const codeCache = new Map();

  // ---------- utilities ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  function loadSession() {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY) || "null"); return s && s.code && s.playerId && s.token ? s : null; }
    catch { return null; }
  }
  function saveSession(s) {
    session = s;
    try { s ? localStorage.setItem(LS_KEY, JSON.stringify(s)) : localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const serverNow = () => Date.now() + offset;
  const setNet = (on) => { netEl.hidden = !on; };
  let toastTimer = null;
  function toast(text, ms = 4000) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  /** POST to the game function. Retries quietly on network/server errors. Returns parsed JSON or {ok:false, network:true}. */
  async function api(body, retries = 3) {
    for (let attempt = 0; ; attempt++) {
      let res = null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 9000);
        res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal, cache: "no-store" });
        clearTimeout(t);
        if (res.status < 500) {
          const data = await res.json();
          setNet(false);
          return data;
        }
      } catch { /* network error or bad JSON: retry */ }
      if (attempt >= retries) return { ok: false, network: true, message: NETWORK_MSG };
      setNet(true);
      await sleep(Math.min(4000, 400 * 2 ** attempt));
    }
  }

  function accept(data) {
    if (!data || !data.state) return;
    state = data.state;
    offset = state.serverNow - Date.now();
    if (state.myLine) localPick = null;
    if (state.phase !== "playing") localPick = null;
    if (state.notice && state.notice.id !== lastNoticeId) {
      if (lastNoticeId !== null) toast(state.notice.text);
      lastNoticeId = state.notice.id;
    } else if (lastNoticeId === null) lastNoticeId = state.notice ? state.notice.id : 0;
    if (view === "howto" && state.phase !== "lobby" && howtoReturn === "room") view = "room";
  }

  function leaveToHome(message) {
    saveSession(null);
    state = null;
    lastNoticeId = null;
    codeCache.clear();
    view = "home";
    homeError = { create: "", join: message || "" };
    render(true);
  }

  // ---------- polling ----------
  async function poll() {
    if (!session || inflight) return;
    inflight = true;
    const data = await api({ action: "state", code: session.code, playerId: session.playerId, token: session.token }, 0);
    inflight = false;
    if (!session) return;
    if (data.network) { failures++; if (failures >= 2) setNet(true); return; }
    failures = 0;
    setNet(false);
    if (!data.ok) {
      if (data.error === "ROOM_NOT_FOUND" || data.error === "NOT_PLAYER") leaveToHome(data.message);
      return;
    }
    accept(data);
    render();
  }
  setInterval(poll, 1000);
  setInterval(tickClocks, 200);

  async function rejoin() {
    const data = await api({ action: "rejoin", code: session.code, playerId: session.playerId, token: session.token }, 4);
    if (data.ok) { accept(data); view = "room"; render(true); return; }
    if (data.network) { view = "room"; render(true); return; } // keep polling; banner shows
    leaveToHome(data.message);
  }

  // ---------- actions ----------
  async function act(action, extra = {}) {
    const data = await api({ action, code: session.code, playerId: session.playerId, token: session.token, ...extra }, 3);
    if (data.ok) { accept(data); render(); return true; }
    toast(data.message || NETWORK_MSG);
    return false;
  }

  async function createRoom(name, btn) {
    btn.disabled = true;
    const data = await api({ action: "create", name, lang: chosenLang }, 3);
    btn.disabled = false;
    if (!data.ok) { homeError.create = data.message || NETWORK_MSG; render(true); return; }
    saveSession({ code: data.state.code, playerId: data.playerId, token: data.token });
    accept(data);
    view = "room";
    render(true);
  }

  async function joinRoom(code, name, btn) {
    btn.disabled = true;
    const data = await api({ action: "join", code, name }, 3);
    btn.disabled = false;
    if (!data.ok) { homeError.join = data.message || NETWORK_MSG; render(true); return; }
    saveSession({ code: data.state.code, playerId: data.playerId, token: data.token });
    accept(data);
    view = "room";
    render(true);
  }

  async function pickLine(line) {
    if (!state || state.phase !== "playing" || state.myLine || localPick || state.pending) return;
    localPick = line;
    render();
    const ok = await act("answer", { line });
    if (!ok) { localPick = null; render(); }
  }

  async function leave() {
    if (session) api({ action: "leave", code: session.code, playerId: session.playerId, token: session.token }, 0);
    leaveToHome("");
  }

  async function copyCode(code, btn) {
    try { await navigator.clipboard.writeText(code); }
    catch {
      const ta = h("textarea", { "aria-hidden": "true", style: "position:fixed;opacity:0" });
      ta.value = code; document.body.append(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  }

  // ---------- clocks ----------
  function tickClocks() {
    for (const el of document.querySelectorAll("[data-ends]")) {
      const ends = Number(el.dataset.ends);
      const total = Number(el.dataset.total || 1);
      const left = Math.max(0, ends - serverNow());
      if (el.dataset.kind === "bar") {
        el.firstChild.style.width = `${(left / total) * 100}%`;
        el.classList.toggle("low", left < 8000);
      } else el.textContent = String(Math.ceil(left / 1000));
    }
  }

  // ---------- rendering ----------
  function render(force = false) {
    const key = JSON.stringify([view, state && { ...state, serverNow: 0 }, localPick, reviewTab, homeError, chosenLang]);
    if (!force && key === lastKey) return;
    lastKey = key;
    const scroller = app.querySelector(".codeview");
    const scrollLeft = scroller ? scroller.scrollLeft : 0;
    let node;
    if (view === "howto") node = renderHowTo();
    else if (view === "home" || !session) node = renderHome();
    else if (!state) node = h("div", { class: "status" }, "Connecting to your room...");
    else node = renderRoom();
    app.replaceChildren(node);
    const sc = app.querySelector(".codeview");
    if (sc) sc.scrollLeft = scrollLeft;
    tickClocks();
  }

  function renderHome() {
    const bind = (k) => (e) => { form[k] = e.target.value; };
    const createName = h("input", { class: "input", id: "cname", maxlength: "18", autocomplete: "nickname", required: true, placeholder: "e.g. Priya", oninput: bind("cname") });
    const joinCode = h("input", { class: "input code-input", id: "jcode", maxlength: "6", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", required: true, placeholder: "ABC234", oninput: bind("jcode") });
    const joinName = h("input", { class: "input", id: "jname", maxlength: "18", autocomplete: "nickname", required: true, placeholder: "e.g. Arjun", oninput: bind("jname") });
    createName.value = form.cname; joinCode.value = form.jcode; joinName.value = form.jname;
    const createBtn = h("button", { class: "btn block", type: "submit" }, "Create room");
    const joinBtn = h("button", { class: "btn block", type: "submit" }, "Join room");
    const chips = h("div", { class: "chips", role: "group", "aria-label": "Language" },
      LANGS.map(([id, label]) => h("button", {
        type: "button", class: "chip", "aria-pressed": String(chosenLang === id),
        onclick: (e) => {
          chosenLang = id;
          for (const c of e.currentTarget.parentNode.children) c.setAttribute("aria-pressed", String(c === e.currentTarget));
        },
      }, label)));
    return h("div", null,
      h("header", { class: "hero" },
        h("h1", null, "Bug Hunt ", h("span", { class: "bug" }, "Arena")),
        h("p", null, "Spot the one broken line before your friends do. Eight rounds, thirty seconds each, interview-style code.")),
      h("form", { class: "panel", onsubmit: (e) => { e.preventDefault(); createRoom(createName.value, createBtn); } },
        h("h2", null, "Host a game"),
        h("label", { class: "field" }, h("span", null, "Your nickname"), createName),
        h("p", { class: "hint", style: "margin:0 0 8px" }, "Language"),
        chips,
        h("p", { class: "err", role: "alert" }, homeError.create),
        createBtn),
      h("form", { class: "panel", onsubmit: (e) => { e.preventDefault(); joinRoom(joinCode.value, joinName.value, joinBtn); } },
        h("h2", null, "Join a game"),
        h("label", { class: "field" }, h("span", null, "Room code"), joinCode),
        h("label", { class: "field" }, h("span", null, "Your nickname"), joinName),
        h("p", { class: "err", role: "alert" }, homeError.join),
        joinBtn),
      h("div", { class: "home-foot" }, h("button", { class: "link", type: "button", onclick: () => { howtoReturn = "home"; view = "howto"; render(true); } }, "How to play")));
  }

  function renderHowTo() {
    return h("div", { class: "howto" },
      h("button", { class: "btn ghost small", onclick: () => { view = howtoReturn; render(true); } }, "Back"),
      h("h2", null, "How to play"),
      h("ol", null,
        h("li", null, "The host creates a room and picks Python, JavaScript, Java, C, or Mixed. Friends join with the 6-character room code. You need 2 to 8 players."),
        h("li", null, "Each round shows a short program and what it is supposed to do. Exactly one line is wrong."),
        h("li", null, "You get one tap. Tap the buggy line before the 30-second timer runs out. A wrong tap locks you out until the next round."),
        h("li", null, "A correct answer scores 100 to 150 points: the faster you tap, the more you get. Wrong or no answer scores 0."),
        h("li", null, "After every round you'll see the bug, a one-line explanation, and the fixed line, then the leaderboard."),
        h("li", null, "Eight rounds get harder as you go: Easy, Medium, Hard, then Expert. Ties go to whoever was faster on their correct answers."),
        h("li", null, "At the end, review your mistakes or every solution. If your connection drops, just reopen the page: you'll rejoin automatically.")),
      h("button", { class: "btn block", onclick: () => { view = howtoReturn; render(true); } }, "Got it"));
  }

  function badges(lang, diff) {
    return h("div", { class: "badges" },
      h("span", { class: "badge lang" }, LANG_NAME[lang] || lang),
      diff ? h("span", { class: `badge ${diff}` }, DIFF_NAME[diff]) : null);
  }
  function topbar() {
    return h("div", { class: "topbar" },
      h("span", { class: "round-no" }, `Round ${state.round} of ${state.rounds}`),
      state.badge ? badges(state.badge.language, state.badge.difficulty) : null);
  }
  const me = () => state.players.find((p) => p.id === state.you);

  function codeView(code, opts) {
    const key = JSON.stringify([code, opts.keyExtra || "", opts.bugLine, opts.mine, opts.wrong, opts.interactive]);
    if (codeCache.has(key)) return codeCache.get(key);
    const el = h("div", { class: "codeview" },
      h("ol", null, code.map((text, i) => {
        const n = i + 1;
        const cls = ["cl", n === opts.bugLine && "bug", n === opts.mine && "mine", n === opts.wrong && "wrong"].filter(Boolean).join(" ");
        return h("li", null, h("button", {
          class: cls, type: "button", disabled: !opts.interactive,
          "aria-label": `Line ${n}: ${text.trim() || "blank"}`,
          onclick: opts.interactive ? () => pickLine(n) : null,
        }, h("span", { class: "ln" }, n), h("span", { class: "tx" }, text)));
      })));
    if (codeCache.size > 40) codeCache.clear();
    codeCache.set(key, el);
    return el;
  }

  function renderRoom() {
    switch (state.phase) {
      case "lobby": return renderLobby();
      case "countdown": return renderCountdown();
      case "playing": case "allin": return renderPlaying();
      case "reveal": return renderReveal();
      case "leaderboard": return renderLeaderboard();
      case "finished": return renderFinished();
      default: return h("div", { class: "status" }, "Loading...");
    }
  }

  function playerList() {
    return h("ul", { class: "players" }, state.players.map((p) => h("li", null,
      h("span", { class: "pname" }, p.name, p.id === state.you ? h("span", { class: "you" }, " (you)") : null),
      h("span", { class: "row" },
        p.isHost ? h("span", { class: "tag host" }, "Host") : null,
        !p.connected ? h("span", { class: "tag off" }, "Offline") : null))));
  }

  function renderLobby() {
    const online = state.players.filter((p) => p.connected).length;
    const copyBtn = h("button", { class: "btn small", onclick: (e) => copyCode(state.code, e.currentTarget) }, "Copy");
    return h("div", null,
      h("div", { class: "lobby-code" },
        h("p", { class: "label" }, "Room code"),
        h("div", { class: "roomcode", "aria-label": `Room code ${state.code.split("").join(" ")}` }, state.code),
        h("div", { class: "row", style: "justify-content:center" }, copyBtn, badges(state.lang))),
      h("p", { class: "waiting" }, "Waiting for players..."),
      h("div", { class: "panel" },
        h("div", { class: "row spread" }, h("h2", null, "Players"), h("span", { class: "tag" }, `${state.players.length} / 8`)),
        playerList()),
      h("div", { style: "margin-top:18px" },
        state.isHost
          ? h("button", { class: "btn block", disabled: online < 2, onclick: (e) => { e.currentTarget.disabled = true; act("start"); } }, online < 2 ? "Need at least 2 players" : "Start game")
          : h("p", { class: "status" }, "Waiting for the host to start the game.")),
      h("div", { class: "row spread", style: "margin-top:14px" },
        h("button", { class: "link", onclick: () => { howtoReturn = "room"; view = "howto"; render(true); } }, "How to play"),
        h("button", { class: "link", onclick: leave }, "Leave room")));
  }

  function pendingCard() {
    return h("div", { class: "pending-card" },
      h("h2", null, "Joining next round"),
      h("p", null, "A round is in progress. You'll jump in at the start of the next one with 0 points."));
  }

  function renderCountdown() {
    return h("div", null,
      state.pending ? pendingCard() : null,
      h("div", { class: "countdown" },
        h("h2", null, `Round ${state.round} of ${state.rounds}`),
        h("div", { class: "big", dataset: { ends: state.phaseEndsAt, kind: "num" } }, "3"),
        h("p", { class: "hint" }, "Get ready"),
        badges(state.badge.language, state.badge.difficulty)));
  }

  function answeredList() {
    const active = state.players.filter((p) => !p.pending);
    return h("div", null,
      h("h3", { class: "section-title" }, "Who's answered?"),
      h("ul", { class: "answered" }, active.map((p) => h("li", null,
        h("span", { class: `check${p.answered ? " on" : ""}`, "aria-label": p.answered ? "answered" : "not yet" }, p.answered ? "✓" : ""),
        h("span", null, p.name, p.id === state.you ? h("span", { class: "you" }, " (you)") : null, !p.connected ? h("span", { class: "stats" }, "offline") : null)))));
  }

  function renderPlaying() {
    const myPick = state.myLine || localPick;
    const canPick = state.phase === "playing" && !myPick && !state.pending;
    return h("div", null,
      topbar(),
      state.phase === "allin" ? h("div", { class: "allin" }, "All answers in!") : h("div", { class: "row" },
        h("div", { class: "timer", style: "flex:1", dataset: { ends: state.phaseEndsAt, total: 30000, kind: "bar" } }, h("i")),
        h("span", { class: "secs", dataset: { ends: state.phaseEndsAt, kind: "num" } }, "30")),
      state.pending ? pendingCard() : null,
      h("div", { class: "goal" }, h("b", null, "Goal: "), state.snippet.goal),
      codeView(state.snippet.code, { mine: myPick, interactive: canPick, keyExtra: `play-${state.gameNo}-${state.round}` }),
      state.pending ? null : h("p", { class: "status" },
        myPick ? `You picked line ${myPick}. Your answer is locked in until the reveal.` : "Tap the line with the bug. You get one try."),
      answeredList());
  }

  function renderReveal() {
    const r = state.reveal;
    const mine = r.picks.find((p) => p.id === state.you);
    const wrong = mine && mine.line && !mine.correct ? mine.line : null;
    return h("div", null,
      topbar(),
      h("p", { class: "status" }, mine ? (mine.correct ? `Correct! +${mine.points} points` : mine.line ? `Not quite. The bug was on line ${r.bugLine}.` : "Time ran out. No answer this round.") : "Here's the answer."),
      h("div", { class: "goal" }, h("b", null, "Goal: "), state.snippet.goal),
      codeView(state.snippet.code, { bugLine: r.bugLine, wrong, keyExtra: `rev-${state.gameNo}-${state.round}` }),
      h("div", { class: "explain" },
        h("p", { class: "what" }, `Line ${r.bugLine}: ${r.explanation}`),
        h("p", { class: "hint" }, "Fixed line:"),
        h("div", { class: "fixline" }, r.fixed.trim())),
      h("ul", { class: "picks" }, r.picks.map((p) => h("li", null,
        h("span", { class: "pname" }, p.name),
        p.correct ? h("span", { class: "ok" }, `✓ +${p.points}`) : h("span", { class: "no" }, p.line ? `✗ line ${p.line}` : "no answer")))));
  }

  function renderLeaderboard() {
    const last = state.round >= state.rounds;
    return h("div", null,
      topbar(),
      h("h2", { style: "font-size:28px;margin-top:6px" }, last ? "Final round done" : "Leaderboard"),
      h("ol", { class: "board" }, state.players.map((p, i) => h("li", null,
        h("span", { class: "rk" }, i + 1),
        h("span", { class: "pname" }, p.name, p.id === state.you ? h("span", { class: "you" }, " (you)") : null,
          p.pending ? h("span", { class: "stats" }, "joins next round") : null),
        h("span", { class: "pts" }, p.score, h("span", { class: `plus${p.lastPoints ? "" : " zero"}` }, `+${p.lastPoints}`))))),
      h("p", { class: "next-in" }, last ? "Results in " : "Next round in ", h("span", { dataset: { ends: state.phaseEndsAt, kind: "num" } }, "15"), "s"),
      state.isHost ? h("button", { class: "btn block", onclick: (e) => { e.currentTarget.disabled = true; act("next"); } }, last ? "Show results" : "Next round") : null);
  }

  function renderFinished() {
    const meRow = state.final.find((f) => f.id === state.you);
    const perfect = meRow && meRow.played === state.rounds && meRow.correct === state.rounds;
    const mistakes = state.review.filter((r) => r.played && !r.correct);
    const items = reviewTab === "mine" ? mistakes : state.review;
    const fmt = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
    return h("div", null,
      h("h2", { style: "font-size:34px;margin:8px 0 4px" }, "Final standings"),
      perfect ? h("p", { class: "perfect" }, "Perfect game! No bugs escaped you.") : null,
      h("ol", { class: "board" }, state.final.map((f) => h("li", null,
        h("span", { class: "rk" }, f.rank),
        h("span", { class: "pname" }, f.name, f.id === state.you ? h("span", { class: "you" }, " (you)") : null,
          h("span", { class: "stats" }, `${f.accuracy}% accuracy (${f.correct}/${f.played}), average answer time ${fmt(f.avgMs)}`)),
        h("span", { class: "pts" }, f.score)))),
      h("div", { style: "margin-top:18px" },
        state.isHost
          ? h("button", { class: "btn block", onclick: (e) => { e.currentTarget.disabled = true; codeCache.clear(); reviewTab = "mine"; act("playAgain"); } }, "Play again")
          : h("p", { class: "status" }, "Waiting for the host to start another game."),
        h("div", { class: "row spread", style: "margin-top:8px" }, h("span"), h("button", { class: "link", onclick: leave }, "Leave room"))),
      h("div", { class: "tabs", role: "tablist" },
        h("button", { class: "tab", role: "tab", "aria-selected": String(reviewTab === "mine"), onclick: () => { reviewTab = "mine"; render(); } }, `My mistakes (${mistakes.length})`),
        h("button", { class: "tab", role: "tab", "aria-selected": String(reviewTab === "all"), onclick: () => { reviewTab = "all"; render(); } }, "All solutions")),
      items.length === 0
        ? h("p", { class: "empty" }, perfect ? "Perfect game! No bugs escaped you." : "No mistakes in the rounds you played.")
        : items.map((r) => h("div", { class: "review-item" },
          h("div", { class: "row spread" }, h("h3", null, `Round ${r.round}`), badges(r.language, r.difficulty)),
          h("div", { class: "goal" }, h("b", null, "Goal: "), r.goal),
          codeView(r.code, { bugLine: r.bugLine, wrong: r.myLine && !r.correct ? r.myLine : null, keyExtra: `review-${state.gameNo}-${r.round}` }),
          h("div", { class: "explain" },
            h("p", { class: "what" }, `Line ${r.bugLine}: ${r.explanation}`),
            h("p", { class: "hint" }, r.played ? (r.correct ? "You found it." : r.myLine ? `You picked line ${r.myLine}.` : "You didn't answer this one.") : "You joined after this round."),
            h("div", { class: "fixline" }, r.fixed.trim())))));
  }

  // ---------- boot ----------
  if (session) { render(true); rejoin(); } else render(true);
})();

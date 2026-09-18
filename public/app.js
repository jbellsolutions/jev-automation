/* Jev Voice Browser — client.
 * Speech is transcribed locally in the browser with the Web Speech API (Chrome/Edge).
 * Only FINAL transcripts are sent to the server; interim text is just displayed. */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    pill: $("jev-pill"), title: $("page-title"), url: $("page-url"), screen: $("screen"), overlay: $("screen-overlay"),
    status: $("status"), mic: $("mic"), micLabel: $("mic-label"), interim: $("interim"), speechNote: $("speech-note"),
    form: $("text-form"), input: $("text-input"), confirm: $("confirm"), confirmAction: $("confirm-action"),
    confirmReason: $("confirm-reason"), confirmYes: $("confirm-yes"), confirmNo: $("confirm-no"),
    clarify: $("clarify"), clarifyQ: $("clarify-question"), clarifyOpts: $("clarify-options"), log: $("log"), clearLog: $("clear-log"),
  };
  let viewport = { width: 1280, height: 800 };
  let ws = null;
  let lastEntry = null;

  // ---------------------------------------------------------------- websocket
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { setStatus("Connected", "ok"); sendViewport(); };
    ws.onclose = () => { setStatus("Disconnected — retrying…", "warn"); setTimeout(connect, 1500); };
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
  }
  function send(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

  function onMessage(msg) {
    switch (msg.type) {
      case "hello":
        viewport = msg.viewport;
        els.pill.textContent = msg.jev.enabled ? `Jev · ${msg.jev.model}` : "heuristic mode · no TYPESAFE_API_KEY";
        els.pill.className = `pill ${msg.jev.enabled ? "jev" : "heuristic"}`;
        break;
      case "viewport":
        viewport = { width: msg.width, height: msg.height };
        break;
      case "screenshot":
        els.screen.src = `data:image/jpeg;base64,${msg.jpegBase64}`;
        els.overlay.classList.add("hidden");
        els.title.textContent = msg.title || "—";
        els.url.textContent = msg.url;
        break;
      case "status":
        setStatus(msg.text, msg.level);
        if (lastEntry && msg.level !== "busy") appendResult(lastEntry, msg.text, msg.level);
        if (msg.level !== "busy") { els.confirm.classList.add("hidden"); }
        break;
      case "transcript_ack":
        lastEntry = addEntry(msg.text);
        els.clarify.classList.add("hidden");
        break;
      case "decision":
        if (lastEntry) renderDecision(lastEntry, msg.decision);
        break;
      case "confirm":
        els.confirmAction.textContent = msg.actionLabel;
        els.confirmReason.textContent = msg.reason;
        els.confirm.classList.remove("hidden");
        setStatus("Waiting for confirmation…", "warn");
        break;
      case "clarify":
        els.clarifyQ.textContent = msg.question;
        els.clarifyOpts.innerHTML = "";
        msg.options.forEach((o, i) => {
          const b = document.createElement("button");
          b.type = "button"; b.className = "chip";
          b.innerHTML = `${i + 1}. ${escapeHtml(o.label)}<small>${Math.round(o.probability * 100)}%</small>`;
          b.onclick = () => { send({ type: "pick", elementId: o.elementId }); els.clarify.classList.add("hidden"); };
          els.clarifyOpts.appendChild(b);
        });
        els.clarify.classList.remove("hidden");
        setStatus('Say "the first one" or click an option', "warn");
        break;
    }
  }

  function setStatus(text, level) { els.status.textContent = text; els.status.className = `status ${level || "info"}`; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---------------------------------------------------------------- log
  function addEntry(said) {
    const li = document.createElement("li");
    li.className = "entry";
    li.innerHTML = `<div class="said">${escapeHtml(said)}</div><div class="did muted">thinking…</div><div class="meta"></div>`;
    els.log.prepend(li);
    while (els.log.children.length > 40) els.log.lastChild.remove();
    return li;
  }
  function renderDecision(li, d) {
    li.querySelector(".did").innerHTML = `→ ${escapeHtml(d.actionLabel)}`;
    li.querySelector(".did").classList.remove("muted");
    const meta = li.querySelector(".meta");
    const tags = [
      `<span class="tag ${d.source}">${d.source === "jev" ? escapeHtml(d.model || "jev") : "heuristic"}</span>`,
      `<span class="tag">intent: ${escapeHtml(d.intent)} ${Math.round(d.intentConfidence * 100)}%</span>`,
    ];
    if (d.targetConfidence != null) tags.push(`<span class="tag">target ${Math.round(d.targetConfidence * 100)}%</span>`);
    if (d.risky != null && d.risky >= 0.6) tags.push(`<span class="tag risk">risky ${Math.round(d.risky * 100)}%</span>`);
    tags.push(`<span class="tag">${d.latencyMs} ms${d.inputTokens ? ` · ${d.inputTokens} tok` : ""}</span>`);
    meta.innerHTML = tags.join("") + `<div class="bar" style="width:100%"><span style="width:${Math.round(d.intentConfidence * 100)}%"></span></div>`;
  }
  function appendResult(li, text, level) {
    const did = li.querySelector(".did");
    if (did && did.classList.contains("muted")) { did.textContent = `→ ${text}`; did.classList.remove("muted"); return; }
    let r = li.querySelector(".result");
    if (!r) { r = document.createElement("div"); r.className = "result muted"; li.appendChild(r); }
    r.textContent = text;
    r.style.color = level === "error" ? "var(--danger)" : level === "warn" ? "var(--warn)" : level === "ok" ? "var(--accent-2)" : "";
  }
  els.clearLog.onclick = () => { els.log.innerHTML = ""; lastEntry = null; };

  // ---------------------------------------------------------------- commands
  function sendCommand(text, via) {
    text = text.trim();
    if (!text) return;
    send({ type: "command", text, via });
  }
  els.form.onsubmit = (e) => { e.preventDefault(); sendCommand(els.input.value, "text"); els.input.value = ""; };
  els.confirmYes.onclick = () => { send({ type: "confirm_reply", ok: true }); els.confirm.classList.add("hidden"); };
  els.confirmNo.onclick = () => { send({ type: "confirm_reply", ok: false }); els.confirm.classList.add("hidden"); };

  // Clicking the live view clicks the same spot in the real browser.
  els.screen.onclick = (e) => {
    const r = els.screen.getBoundingClientRect();
    if (!r.width || !r.height) return;
    send({ type: "click_at", fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height });
  };

  // Size the real browser's viewport to the space we have, so frames are never
  // stretched in CSS (the server captures at 2x for HiDPI screens).
  let viewportTimer = null;
  function sendViewport() {
    const box = els.screen.parentElement.getBoundingClientRect();
    if (box.width < 100 || box.height < 100) return;
    send({ type: "viewport", width: Math.round(box.width), height: Math.round(box.height) });
  }
  window.addEventListener("resize", () => { clearTimeout(viewportTimer); viewportTimer = setTimeout(sendViewport, 300); });

  // ---------------------------------------------------------------- speech
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;
  let restartTimer = null;

  if (!SR) {
    els.mic.disabled = true;
    els.micLabel.textContent = "Voice not supported here";
    els.speechNote.textContent = "This browser has no Web Speech API. Use Chrome or Edge for voice; the text box below still works.";
    els.speechNote.classList.remove("hidden");
  } else if (!window.isSecureContext) {
    els.mic.disabled = true;
    els.micLabel.textContent = "Voice needs HTTPS or localhost";
    els.speechNote.textContent = "Microphone access requires a secure context. Open this page via http://localhost or https.";
    els.speechNote.classList.remove("hidden");
  }

  function startRecognition() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0].transcript;
        if (res.isFinal) { els.interim.innerHTML = "&nbsp;"; sendCommand(text, "voice"); }
        else interim += text;
      }
      if (interim) els.interim.textContent = interim;
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        stopListening();
        els.speechNote.textContent = "Microphone permission was denied. Allow it in the address bar and try again.";
        els.speechNote.classList.remove("hidden");
      } else if (ev.error !== "no-speech" && ev.error !== "aborted") {
        setStatus(`Speech error: ${ev.error}`, "warn");
      }
    };
    // Chrome ends sessions after silence; keep listening until the user stops.
    rec.onend = () => { if (listening) restartTimer = setTimeout(startRecognition, 200); };
    rec.start();
  }
  function startListening() {
    listening = true;
    els.mic.setAttribute("aria-pressed", "true");
    els.mic.title = "Stop listening";
    els.micLabel.textContent = "Listening… speak a command";
    els.speechNote.classList.add("hidden");
    startRecognition();
  }
  function stopListening() {
    listening = false;
    clearTimeout(restartTimer);
    try { rec && rec.stop(); } catch (_) { /* already stopped */ }
    els.mic.setAttribute("aria-pressed", "false");
    els.mic.title = "Start listening";
    els.micLabel.textContent = "Tap to start listening";
    els.interim.innerHTML = "&nbsp;";
  }
  els.mic.onclick = () => (listening ? stopListening() : startListening());
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body && !els.mic.disabled) { e.preventDefault(); els.mic.click(); }
  });

  connect();
})();

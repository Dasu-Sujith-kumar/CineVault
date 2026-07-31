const $ = (id) => document.getElementById(id);

const connPill = $("connPill");
const fileName = $("fileName");
const timeText = $("timeText");
const volText = $("volText");
const speedText = $("speedText");
const timeline = $("timeline");
const timelineHint = $("timelineHint");
const volume = $("volume");
const speed = $("speed");
const openPath = $("openPath");
const log = $("log");

const btnToggle = $("btnToggle");
const btnBack = $("btnBack");
const btnFwd = $("btnFwd");
const btnOpen = $("btnOpen");
const btnConnect = $("btnConnect");

let lastState = null;
let scrubbing = false;
let lastSeekSentAt = 0;
let lastVolSentAt = 0;
let lastSpeedSentAt = 0;

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const s = Math.max(0, seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

async function apiGet(path) {
  const res = await fetch(path, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error || "request_failed"), { json, status: res.status });
  return json;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error || "request_failed"), { json, status: res.status });
  return json;
}

function setPill(text, kind) {
  connPill.textContent = text;
  if (kind === "ok") {
    connPill.style.borderColor = "rgba(46, 229, 157, 0.45)";
    connPill.style.background = "rgba(46, 229, 157, 0.12)";
    return;
  }
  if (kind === "bad") {
    connPill.style.borderColor = "rgba(255, 107, 107, 0.45)";
    connPill.style.background = "rgba(255, 107, 107, 0.12)";
    return;
  }
  connPill.style.borderColor = "rgba(255, 255, 255, 0.12)";
  connPill.style.background = "rgba(255, 255, 255, 0.06)";
}

function writeLog(state) {
  const lines = [];
  lines.push(`connected: ${state.connected} (connecting: ${state.connecting})`);
  lines.push(`pipe: ${state.pipePath}`);
  if (state.mpvPid) lines.push(`mpv pid: ${state.mpvPid}`);
  if (state.mpvLaunchError) lines.push(`mpv launch error: ${state.mpvLaunchError}`);
  if (state.lastError) lines.push(`last error: ${state.lastError}`);
  log.textContent = lines.join("\n");
}

function updateUI(state) {
  lastState = state;
  writeLog(state);

  if (state.connected) setPill("Connected", "ok");
  else if (state.connecting) setPill("Connecting...", "warn");
  else setPill("Not connected", "bad");

  const s = state.state || {};
  const paused = s.pause;
  const pos = Number(s["time-pos"]);
  const dur = Number(s.duration);
  const vol = Number(s.volume);
  const spd = Number(s.speed);
  const name = s.filename || s.path || "-";

  fileName.textContent = name;
  timeText.textContent =
    Number.isFinite(pos) && Number.isFinite(dur) && dur > 0 ? `${fmtTime(pos)} / ${fmtTime(dur)}` : fmtTime(pos);
  volText.textContent = Number.isFinite(vol) ? `${Math.round(vol)}%` : "-";
  speedText.textContent = Number.isFinite(spd) ? `${spd.toFixed(2)}x` : "-";

  if (!scrubbing) {
    if (Number.isFinite(dur) && dur > 0) {
      timeline.max = String(dur);
      timeline.value = Number.isFinite(pos) ? String(pos) : "0";
      timeline.disabled = false;
      timelineHint.textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
    } else {
      timeline.max = "1";
      timeline.value = "0";
      timeline.disabled = true;
      timelineHint.textContent = "-";
    }
  }

  if (Number.isFinite(vol)) volume.value = String(Math.max(0, Math.min(100, vol)));
  if (Number.isFinite(spd)) speed.value = String(Math.max(0.25, Math.min(3, spd)));

  btnToggle.textContent = paused === true ? "Play" : "Pause";
}

async function refresh() {
  try {
    const state = await apiGet("/api/state");
    updateUI(state);
  } catch (err) {
    setPill("Server error", "bad");
    log.textContent = String(err?.message || err);
  }
}

btnToggle.addEventListener("click", async () => {
  try {
    await apiPost("/api/toggle");
    await refresh();
  } catch (err) {
    log.textContent = String(err?.json?.lastError || err?.message || err);
  }
});

btnBack.addEventListener("click", async () => {
  try {
    await apiPost("/api/seek", { delta: -10 });
  } catch (err) {
    log.textContent = String(err?.json?.lastError || err?.message || err);
  }
});

btnFwd.addEventListener("click", async () => {
  try {
    await apiPost("/api/seek", { delta: 10 });
  } catch (err) {
    log.textContent = String(err?.json?.lastError || err?.message || err);
  }
});

btnConnect.addEventListener("click", async () => {
  try {
    await apiPost("/api/connect");
    await refresh();
  } catch (err) {
    log.textContent = String(err?.json?.lastError || err?.message || err);
  }
});

btnOpen.addEventListener("click", async () => {
  const p = (openPath.value || "").trim();
  if (!p) return;
  try {
    await apiPost("/api/open", { path: p });
  } catch (err) {
    log.textContent = String(err?.json?.lastError || err?.message || err);
  }
});

timeline.addEventListener("pointerdown", () => {
  scrubbing = true;
});

timeline.addEventListener("pointerup", async () => {
  scrubbing = false;
  const t = Number(timeline.value);
  if (!Number.isFinite(t)) return;
  try {
    await apiPost("/api/seekTo", { time: t });
  } catch (err) {
    log.textContent = String(err?.json?.lastError || err?.message || err);
  }
});

timeline.addEventListener("input", () => {
  const t = Number(timeline.value);
  const max = Number(timeline.max);
  if (Number.isFinite(t) && Number.isFinite(max) && max > 0) {
    timelineHint.textContent = `${fmtTime(t)} / ${fmtTime(max)}`;
  }

  // If the browser doesn't emit pointerup (edge cases), send throttled seeks.
  const now = Date.now();
  if (now - lastSeekSentAt < 350) return;
  lastSeekSentAt = now;
  if (!scrubbing) return;
  apiPost("/api/seekTo", { time: t }).catch(() => {});
});

volume.addEventListener("input", () => {
  const v = Number(volume.value);
  const now = Date.now();
  if (now - lastVolSentAt < 120) return;
  lastVolSentAt = now;
  apiPost("/api/volume", { value: v }).catch(() => {});
});

speed.addEventListener("input", () => {
  const v = Number(speed.value);
  const now = Date.now();
  if (now - lastSpeedSentAt < 160) return;
  lastSpeedSentAt = now;
  apiPost("/api/speed", { value: v }).catch(() => {});
});

window.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
  if (typing) return;

  if (e.code === "Space") {
    e.preventDefault();
    btnToggle.click();
    return;
  }
  if (e.code === "ArrowLeft") {
    e.preventDefault();
    btnBack.click();
    return;
  }
  if (e.code === "ArrowRight") {
    e.preventDefault();
    btnFwd.click();
  }
});

refresh();
setInterval(refresh, 400);

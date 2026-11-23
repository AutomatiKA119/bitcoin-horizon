const GRACE_MS = 60_000;
const WAKE_PX = 12;

export function startScreensaver({ button, countEl, hintEl }) {
  const sessionId = sessionStorage.getItem("bh.saver") || crypto.randomUUID();
  sessionStorage.setItem("bh.saver", sessionId);
  let enteredAt = 0;
  let anchor = null;
  let lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
  let graceTimer = 0;
  let beatTimer = 0;
  let pollTimer = 0;

  function people(count) {
    const noun = count === 1 ? "person" : "people";
    return `${count} ${noun} currently screensaver-ing`;
  }

  async function publish(active) {
    const response = await fetch("/api/screensaver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, active }),
    });
    if (!response.ok) throw new Error("count unavailable");
    const data = await response.json();
    countEl.textContent = people(Number(data.count) || 0);
  }

  async function refreshCount() {
    try {
      const data = await fetch("/api/screensaver").then((response) => response.json());
      countEl.textContent = people(Number(data.count) || 0);
    } catch {
      countEl.textContent = "screensaver count unavailable";
    }
  }

  function renderHint() {
    if (!document.fullscreenElement) {
      hintEl.textContent = "";
      button.setAttribute("aria-label", "Fullscreen screensaver");
      return;
    }
    button.setAttribute("aria-label", "Leave fullscreen");
    const left = GRACE_MS - (Date.now() - enteredAt);
    hintEl.textContent = left > 0
      ? `still ${Math.ceil(left / 1000)}s`
      : "move or press a key to return";
  }

  function stopBeat() {
    clearInterval(beatTimer);
    beatTimer = 0;
    publish(false).catch(() => {});
  }

  function onFullscreen() {
    clearTimeout(graceTimer);
    anchor = null;
    if (document.fullscreenElement) {
      enteredAt = Date.now();
      graceTimer = setTimeout(() => {
        anchor = { ...lastPointer };
        renderHint();
      }, GRACE_MS);
      clearInterval(beatTimer);
      publish(true).catch(() => {});
      beatTimer = setInterval(() => publish(true).catch(() => {}), 15000);
    } else {
      stopBeat();
    }
    renderHint();
  }

  button.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      hintEl.textContent = "FULLSCREEN BLOCKED";
    }
  });

  document.addEventListener("fullscreenchange", onFullscreen);
  window.addEventListener("mousemove", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!document.fullscreenElement || !anchor) return;
    const dx = event.clientX - anchor.x;
    const dy = event.clientY - anchor.y;
    if (dx * dx + dy * dy >= WAKE_PX * WAKE_PX) document.exitFullscreen();
  });
  window.addEventListener("keydown", () => {
    if (!document.fullscreenElement || !anchor) return;
    document.exitFullscreen();
  });

  refreshCount();
  pollTimer = setInterval(refreshCount, 15000);
  setInterval(renderHint, 1000);
  return () => {
    clearInterval(pollTimer);
    clearInterval(beatTimer);
  };
}

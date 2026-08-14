(function () {
  "use strict";

  const DEFAULT_DURATION = 5 * 60 * 1000;
  const DEFAULT_MATCH = {
    blueName: "ทีมสีน้ำเงิน", redName: "ทีมสีแดง",
    blueScore: 0, redScore: 0,
    durationMs: DEFAULT_DURATION, remainingMs: DEFAULT_DURATION,
    running: false, startTs: null, endTs: null, phase: "idle",
    countdownValue: null, countdownEndTs: null,
    scoresVisible: true, updatedAt: 0
  };

  let db = null;
  let roomRef = null;
  let roomCode = "";
  let state = Object.assign({}, DEFAULT_MATCH);
  let clockFrame = null;
  let countdownDriver = null;
  let timerFinished = false;
  let nameTimer = null;
  let toastTimer = null;
  let serverOffsetMs = 0;

  const $ = (id) => document.getElementById(id);

  function initFirebase() {
    if (!firebase.apps.length) firebase.initializeApp(window.EK_FIREBASE_CONFIG);
    db = firebase.database();
  }

  function validRoom(value) { return /^\d{4}$/.test(value); }
  function cleanRoomInput() { $("roomCode").value = $("roomCode").value.replace(/\D/g, "").slice(0, 4); }

  function joinRoom() {
    cleanRoomInput();
    const code = $("roomCode").value.trim();
    if (!validRoom(code)) return toast("กรุณากรอกรหัสสนามเป็นตัวเลข 4 หลัก");
    roomCode = code;
    initFirebase();
    roomRef = db.ref("rooms/" + roomCode + "/match");
    $("roomGate").hidden = true;
    $("controlApp").hidden = false;
    $("roomPill").textContent = "ROOM " + roomCode + "  ▢";

    db.ref(".info/connected").on("value", (snapshot) => {
      const online = !!snapshot.val();
      $("syncState").classList.toggle("online", online);
      $("syncText").textContent = online ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ";
    });
    db.ref(".info/serverTimeOffset").on("value", (snapshot) => {
      serverOffsetMs = Number(snapshot.val()) || 0;
    });

    roomRef.on("value", (snapshot) => {
      if (!snapshot.exists()) {
        roomRef.set(Object.assign({}, DEFAULT_MATCH, { updatedAt: nowMs() })).catch(firebaseError);
        return;
      }
      state = Object.assign({}, DEFAULT_MATCH, snapshot.val() || {});
      renderState();
    }, firebaseError);
  }

  function firebaseError(error) {
    console.error(error);
    $("syncState").classList.remove("online");
    $("syncText").textContent = "เชื่อมต่อไม่ได้";
    toast("เชื่อมต่อ Firebase ไม่สำเร็จ กรุณาตรวจสอบ Database และ Rules");
  }

  function updateMatch(patch) {
    if (!roomRef) return Promise.resolve();
    return roomRef.update(Object.assign({}, patch, { updatedAt: nowMs() })).catch(firebaseError);
  }

  function nowMs() { return Date.now() + serverOffsetMs; }

  function liveRemaining(match) {
    if (!match.running) return Math.max(0, Number(match.remainingMs) || 0);
    if (Number(match.endTs) > 0) return Math.max(0, Number(match.endTs) - nowMs());
    if (!match.startTs) return Math.max(0, Number(match.remainingMs) || 0);
    return Math.max(0, (Number(match.remainingMs) || 0) - (nowMs() - match.startTs));
  }

  function formatClock(ms) {
    const safe = Math.max(0, ms);
    const whole = Math.floor(safe / 1000);
    const min = String(Math.floor(whole / 60)).padStart(2, "0");
    const sec = String(whole % 60).padStart(2, "0");
    const milli = String(Math.floor(safe % 1000)).padStart(3, "0");
    return min + ":" + sec + '<span class="clock-ms">.' + milli + "</span>";
  }

  function phaseLabel(phase) {
    return phase === "countdown" ? "เตรียมเริ่มการแข่งขัน" :
      phase === "running" ? "กำลังแข่งขัน" :
      phase === "paused" ? "หยุดเวลา" :
      phase === "finished" ? "จบการแข่งขัน" : "พร้อมเริ่ม";
  }

  function renderState() {
    if (document.activeElement !== $("blueName")) $("blueName").value = state.blueName || "";
    if (document.activeElement !== $("redName")) $("redName").value = state.redName || "";
    $("blueScore").textContent = Number(state.blueScore) || 0;
    $("redScore").textContent = Number(state.redScore) || 0;
    $("previewBlue").textContent = Number(state.blueScore) || 0;
    $("previewRed").textContent = Number(state.redScore) || 0;
    $("scoresVisible").checked = state.scoresVisible !== false;

    if (document.activeElement !== $("durationMinutes") && document.activeElement !== $("durationSeconds")) {
      $("durationMinutes").value = Math.floor(state.durationMs / 60000);
      $("durationSeconds").value = Math.floor((state.durationMs % 60000) / 1000);
    }

    const phase = state.phase || "idle";
    $("phaseChip").className = "phase-chip " + phase;
    $("phaseChip").textContent = phaseLabel(phase);
    $("startMatch").hidden = !(phase === "idle" || phase === "finished");
    $("pauseMatch").hidden = phase !== "running";
    $("resumeMatch").hidden = phase !== "paused";
    $("countdownState").hidden = phase !== "countdown";
    $("countdownMini").textContent = state.countdownValue || 3;
    $("finishMatch").disabled = phase === "idle" || phase === "finished";

    if (phase === "countdown") startCountdownDriver(); else stopCountdownDriver();
    restartClock();
  }

  function restartClock() {
    if (clockFrame) cancelAnimationFrame(clockFrame);
    timerFinished = false;
    const tick = () => {
      const remaining = liveRemaining(state);
      const html = formatClock(remaining);
      $("controlClock").innerHTML = html;
      $("previewClock").innerHTML = '<span class="clock">' + html + "</span>";
      $("controlClockBox").classList.toggle("danger", remaining > 0 && remaining <= 10000);
      if (state.running && remaining <= 0 && !timerFinished) {
        timerFinished = true;
        updateMatch({ running: false, remainingMs: 0, startTs: null, endTs: null, phase: "finished" });
        return;
      }
      if (state.running) clockFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  function startCountdownDriver() {
    if (countdownDriver || !state.countdownEndTs) return;
    const tick = () => {
      const value = Math.max(0, Math.ceil((Number(state.countdownEndTs) - nowMs()) / 1000));
      $("countdownMini").textContent = value > 0 ? value : "GO!";
      if (value > 0) {
        if (value !== state.countdownValue) updateMatch({ countdownValue: value });
        return;
      }
      stopCountdownDriver();
      completeCountdown();
    };
    // กำหนด interval ก่อนเรียก tick เพื่อให้หยุดตัวเองได้ แม้แท็บถูกพักไว้
    // จนเวลานับถอยหลังหมดแล้วค่อยกลับมาทำงาน
    countdownDriver = setInterval(tick, 100);
    tick();
  }

  function completeCountdown() {
    if (!roomRef) return;
    const transitionNow = nowMs();
    roomRef.transaction((current) => {
      if (!current || current.phase !== "countdown") return;
      if (Number(current.countdownEndTs) > transitionNow) return;
      const remaining = Math.max(0, Number(current.remainingMs) || Number(current.durationMs) || 0);
      current.phase = remaining > 0 ? "running" : "finished";
      current.running = remaining > 0;
      current.startTs = remaining > 0 ? transitionNow : null;
      current.endTs = remaining > 0 ? transitionNow + remaining : null;
      current.countdownValue = 0;
      current.countdownEndTs = null;
      current.updatedAt = transitionNow;
      return current;
    }, (error, committed) => {
      if (error) return firebaseError(error);
      if (committed) playAudio("whistleAudio");
    }, false);
  }

  function stopCountdownDriver() {
    if (countdownDriver) clearInterval(countdownDriver);
    countdownDriver = null;
  }

  function startMatch() {
    const remaining = liveRemaining(state);
    if (remaining <= 0) return toast("กรุณารีเซ็ตเวลาก่อนเริ่มแข่งขัน");
    playAudio("countdownAudio");
    updateMatch({ phase: "countdown", running: false, remainingMs: remaining, startTs: null, endTs: null, countdownValue: 3, countdownEndTs: nowMs() + 3000 });
  }

  function pauseMatch() {
    updateMatch({ phase: "paused", running: false, remainingMs: liveRemaining(state), startTs: null, endTs: null, countdownValue: null, countdownEndTs: null });
  }

  function resumeMatch() {
    const remaining = Math.max(0, Number(state.remainingMs) || 0);
    const resumeNow = nowMs();
    updateMatch({ phase: remaining > 0 ? "running" : "finished", running: remaining > 0, remainingMs: remaining, startTs: remaining > 0 ? resumeNow : null, endTs: remaining > 0 ? resumeNow + remaining : null, countdownValue: null, countdownEndTs: null });
  }

  function finishMatch() {
    updateMatch({ phase: "finished", running: false, remainingMs: liveRemaining(state), startTs: null, endTs: null, countdownValue: null, countdownEndTs: null });
  }

  function resetTimer() {
    stopCountdownDriver();
    updateMatch({ phase: "idle", running: false, remainingMs: state.durationMs, startTs: null, endTs: null, countdownValue: null, countdownEndTs: null }).then(() => toast("รีเซ็ตเวลาแล้ว"));
  }

  function applyDuration() {
    const minutes = Math.max(0, Math.floor(Number($("durationMinutes").value) || 0));
    const seconds = Math.max(0, Math.floor(Number($("durationSeconds").value) || 0));
    const totalSeconds = minutes * 60 + seconds;
    if (totalSeconds <= 0) return toast("กรุณาตั้งเวลาอย่างน้อย 1 วินาที");
    const duration = totalSeconds * 1000;
    $("durationMinutes").value = Math.floor(totalSeconds / 60);
    $("durationSeconds").value = totalSeconds % 60;
    stopCountdownDriver();
    updateMatch({ durationMs: duration, remainingMs: duration, running: false, startTs: null, endTs: null, phase: "idle", countdownValue: null, countdownEndTs: null }).then(() => toast("ตั้งเวลาแข่งขันเรียบร้อย"));
  }

  function adjustScore(side, amount) {
    if (!roomRef) return;
    roomRef.child(side + "Score").transaction((value) => Math.max(0, (Number(value) || 0) + amount), null, false);
  }

  function saveTeamNames() {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => updateMatch({ blueName: $("blueName").value.trim(), redName: $("redName").value.trim() }), 220);
  }

  function newMatch() {
    if (!roomRef || !confirm("เริ่มแมตช์ใหม่และล้างคะแนนทั้งสองทีมใช่หรือไม่?")) return;
    roomRef.set(Object.assign({}, DEFAULT_MATCH, {
      blueName: state.blueName, redName: state.redName,
      durationMs: state.durationMs, remainingMs: state.durationMs,
      updatedAt: nowMs()
    })).then(() => toast("พร้อมสำหรับแมตช์ใหม่")).catch(firebaseError);
  }

  function displayUrl() {
    const code = roomCode || $("roomCode").value.trim();
    return "display.html" + (validRoom(code) ? "?room=" + encodeURIComponent(code) : "");
  }

  function openDisplay() { window.open(displayUrl(), "_blank"); }
  function playAudio(id) { const audio = $(id); if (!audio) return; audio.pause(); audio.currentTime = 0; audio.play().catch(() => {}); }
  function toast(text) { clearTimeout(toastTimer); $("toast").textContent = text; $("toast").hidden = false; toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2600); }

  $("roomCode").addEventListener("input", cleanRoomInput);
  $("roomCode").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });
  $("randomRoom").addEventListener("click", () => { $("roomCode").value = String(Math.floor(1000 + Math.random() * 9000)); });
  $("joinRoom").addEventListener("click", joinRoom);
  $("openDisplayGate").addEventListener("click", openDisplay);
  $("openDisplay").addEventListener("click", openDisplay);
  $("openDisplayPreview").addEventListener("click", openDisplay);
  $("roomPill").addEventListener("click", () => navigator.clipboard && navigator.clipboard.writeText(roomCode).then(() => toast("คัดลอกรหัสสนามแล้ว")));
  $("themeToggle").addEventListener("click", () => { const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; localStorage.setItem("ek-soccer-theme", next); });
  $("startMatch").addEventListener("click", startMatch);
  $("pauseMatch").addEventListener("click", pauseMatch);
  $("resumeMatch").addEventListener("click", resumeMatch);
  $("finishMatch").addEventListener("click", finishMatch);
  $("resetTimer").addEventListener("click", resetTimer);
  $("applyDuration").addEventListener("click", applyDuration);
  $("newMatch").addEventListener("click", newMatch);
  $("scoresVisible").addEventListener("change", (event) => updateMatch({ scoresVisible: event.target.checked }));
  $("blueName").addEventListener("input", saveTeamNames);
  $("redName").addEventListener("input", saveTeamNames);
  document.querySelectorAll("[data-score]").forEach((button) => button.addEventListener("click", () => adjustScore(button.dataset.score, Number(button.dataset.value))));
  $("assetToggle").addEventListener("click", () => { $("assetInfo").hidden = !$("assetInfo").hidden; $("assetArrow").textContent = $("assetInfo").hidden ? "⌄" : "⌃"; });
  $("testCountdown").addEventListener("click", () => playAudio("countdownAudio"));
  $("testWhistle").addEventListener("click", () => playAudio("whistleAudio"));
})();

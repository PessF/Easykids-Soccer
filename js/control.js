(function () {
  "use strict";

  const ROOM_PASSWORD = "7777";
  const APP_VERSION = "stable8-side-clarity";
  const DEFAULT_DURATION = 5 * 60 * 1000;
  const DEFAULT_MATCH = {
    blueName: "Blue Team", redName: "Red Team",
    blueScore: 0, redScore: 0,
    durationMs: DEFAULT_DURATION, remainingMs: DEFAULT_DURATION,
    running: false, startTs: null, endTs: null, phase: "idle",
    countdownValue: null, countdownEndTs: null,
    scoresVisible: true, matchId: null, historyEntryId: null, startedAt: null, finishReason: null,
    historySaved: false, sidesSwapped: false,
    updatedAt: 0
  };

  let db = null;
  let roomRef = null;
  let historyRef = null;
  let rosterRef = null;
  let roomTeams = [];
  let rosterLocalOnly = false;
  let rosterPendingSync = false;
  let rosterListenerActive = false;
  let firebaseConnected = false;
  let roomCode = "";
  let state = Object.assign({}, DEFAULT_MATCH);
  let clockFrame = null;
  let clockInterval = null;
  let timeUpPending = false;
  let finishingMatch = false;
  let countdownDriver = null;
  let lastCountdownNumber = null;
  let toastTimer = null;
  let serverOffsetMs = 0;
  let historyQuery = null;
  let joined = false;
  let lastFirebaseErrorAt = 0;
  let lastSidesSwapped = null;
  let sideAnimationTimer = null;

  const $ = (id) => document.getElementById(id);

  function initFirebase() {
    if (!window.firebase || !firebase.initializeApp || !firebase.database) {
      throw new Error("FIREBASE_SDK_UNAVAILABLE");
    }
    if (!window.EK_FIREBASE_CONFIG || !window.EK_FIREBASE_CONFIG.databaseURL) {
      throw new Error("FIREBASE_CONFIG_UNAVAILABLE");
    }
    if (!firebase.apps.length) firebase.initializeApp(window.EK_FIREBASE_CONFIG);
    db = firebase.database();
  }

  console.info("EasyKids Robot Soccer Control", APP_VERSION);

  function validRoom(value) { return /^\d{4}$/.test(value); }
  function cleanRoomInput() { $("roomCode").value = $("roomCode").value.replace(/\D/g, "").slice(0, 4); }
  function cleanPasswordInput() { $("roomPassword").value = $("roomPassword").value.replace(/\D/g, "").slice(0, 4); }

  function joinRoom() {
    if (joined) return;
    cleanRoomInput();
    const code = $("roomCode").value.trim();
    if (!validRoom(code)) return toast("กรุณากรอก Room Code เป็นตัวเลข 4 หลัก");
    if ($("roomPassword").value !== ROOM_PASSWORD) return toast("รหัสกรรมการไม่ถูกต้อง");
    $("joinRoom").disabled = true;
    $("joinRoom").textContent = "กำลังเชื่อมต่อ…";
    roomCode = code;
    try {
      initFirebase();
    } catch (error) {
      $("joinRoom").disabled = false;
      $("joinRoom").textContent = "เข้าร่วมการตัดสิน";
      console.error(error);
      return toast("โหลด Firebase ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตและไฟล์ตั้งค่า");
    }
    roomRef = db.ref("rooms/" + roomCode + "/match");
    try { roomTeams = JSON.parse(localStorage.getItem("ek-soccer-roster-" + roomCode) || "[]"); } catch (_) { roomTeams = []; }
    try { rosterPendingSync = localStorage.getItem("ek-soccer-roster-pending-" + roomCode) === "1"; } catch (_) { rosterPendingSync = false; }
    if (!Array.isArray(roomTeams)) roomTeams = [];
    $("teamRosterInput").value = roomTeams.join("\n");
    renderTeamPickers();
    renderSavedTeamList();
    historyRef = db.ref("rooms/" + roomCode + "/history");
    rosterRef = db.ref("rooms/" + roomCode + "/roster");
    historyQuery = historyRef.orderByChild("endedAt");
    joined = true;
    $("roomGate").hidden = true;
    $("controlApp").hidden = false;
    $("roomPill").textContent = "Room Code " + roomCode;

    db.ref(".info/connected").on("value", (snapshot) => {
      const online = !!snapshot.val();
      firebaseConnected = online;
      $("syncState").classList.toggle("online", online);
      $("syncText").textContent = online ? "เชื่อมต่อแล้ว" : "ออฟไลน์ · รอเชื่อมต่อ";
    });
    db.ref(".info/serverTimeOffset").on("value", (snapshot) => {
      serverOffsetMs = Number(snapshot.val()) || 0;
    });

    roomRef.on("value", (snapshot) => {
      if (!snapshot.exists()) return;
      state = Object.assign({}, DEFAULT_MATCH, snapshot.val() || {});
      if (state.redName === "ทีมสีแดง") state.redName = "Red Team";
      if (state.blueName === "ทีมสีน้ำเงิน") state.blueName = "Blue Team";
      renderState();
    }, firebaseError);
    historyQuery.on("value", refreshHistory, firebaseError);
    watchRoster();

    roomRef.transaction((current) => current || Object.assign({}, DEFAULT_MATCH, {
      updatedAt: nowMs()
    }), (error) => {
      if (error) firebaseError(error);
    }, false);
  }

  function watchRoster() {
    if (rosterListenerActive) return;
    rosterListenerActive = true;
    rosterRef.on("value", (snapshot) => {
      if (rosterPendingSync) return;
      if (!snapshot.exists() && roomTeams.length) {
        $("rosterStatus").textContent = "รายชื่อทีมอยู่ในเครื่องนี้ กรุณากดบันทึกเพื่อซิงค์กับ Firebase";
        return;
      }
      roomTeams = Array.isArray(snapshot.val()) ? snapshot.val().filter((name) => typeof name === "string") : [];
      try { localStorage.setItem("ek-soccer-roster-" + roomCode, JSON.stringify(roomTeams)); } catch (_) {}
      if (document.activeElement !== $("teamRosterInput")) $("teamRosterInput").value = roomTeams.join("\n");
      renderTeamPickers();
      renderSavedTeamList();
      $("rosterStatus").textContent = "รายชื่อทีมซิงค์กับ Firebase แล้ว";
    }, (error) => {
      console.warn("บันทึกรายชื่อทีมบน Firebase ไม่ได้", error);
      rosterListenerActive = false;
      rosterLocalOnly = true;
      $("rosterStatus").textContent = "ใช้รายชื่อทีมที่บันทึกในเครื่องนี้ กรุณาเผยแพร่กฎ Firebase ล่าสุด";
      toast("ใช้รายชื่อทีมที่บันทึกในเครื่องนี้ กรุณาตรวจสอบกฎ Firebase");
    });

  }

  function firebaseError(error) {
    console.error(error);
    $("syncState").classList.remove("online");
    $("syncText").textContent = "เชื่อมต่อไม่ได้";
    const currentTime = Date.now();
    if (currentTime - lastFirebaseErrorAt > 2500) {
      lastFirebaseErrorAt = currentTime;
      toast("เชื่อมต่อ Firebase ไม่สำเร็จ กรุณาตรวจสอบ Database และ Rules");
    }
  }

  function updateMatch(patch) {
    if (!roomRef) return Promise.resolve(false);
    return roomRef.update(Object.assign({}, patch, { updatedAt: nowMs() }))
      .then(() => true)
      .catch((error) => {
        firebaseError(error);
        return false;
      });
  }

  function nowMs() { return Date.now() + serverOffsetMs; }

  function remainingAt(match, timestamp) {
    if (!match.running) return Number(match.remainingMs) || 0;
    if (match.endTs != null && Number.isFinite(Number(match.endTs))) return Number(match.endTs) - timestamp;
    if (!match.startTs) return Number(match.remainingMs) || 0;
    return (Number(match.remainingMs) || 0) - (timestamp - Number(match.startTs));
  }

  function liveRemaining(match) {
    return remainingAt(match, nowMs());
  }

  function formatClock(ms) {
    const safe = Math.max(0, ms);
    const whole = Math.floor(safe / 1000);
    const min = String(Math.floor(whole / 60)).padStart(2, "0");
    const sec = String(whole % 60).padStart(2, "0");
    const centi = String(Math.floor((safe % 1000) / 10)).padStart(2, "0");
    return '<span class="clock-main">' + min + ":" + sec + '</span><span class="clock-ms">:' + centi + "</span>";
  }

  function paintClock(element, ms) {
    const safe = Math.max(0, ms);
    const whole = Math.floor(safe / 1000);
    const main = String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0");
    const milli = ":" + String(Math.floor((safe % 1000) / 10)).padStart(2, "0");
    const mainElement = element.querySelector(".clock-main");
    const milliElement = element.querySelector(".clock-ms");
    if (!mainElement || !milliElement) {
      element.innerHTML = formatClock(ms);
      return;
    }
    if (mainElement.textContent !== main) mainElement.textContent = main;
    if (milliElement.textContent !== milli) milliElement.textContent = milli;
  }

  function phaseLabel(phase) {
    return phase === "countdown" ? "เตรียมเริ่มการแข่งขัน" :
      phase === "running" ? "กำลังแข่งขัน" :
      phase === "timeup" ? "หมดเวลา · รอกรรมการจบแมตช์" :
      phase === "paused" ? "หยุดเวลา" :
      phase === "finished" ? "จบการแข่งขัน" : "พร้อมเริ่ม";
  }

  function renderState() {
    $("blueName").value = state.blueName || "Blue Team";
    $("redName").value = state.redName || "Red Team";
    renderTeamPickers();
    $("blueScore").textContent = Number(state.blueScore) || 0;
    $("redScore").textContent = Number(state.redScore) || 0;
    $("scoresVisible").checked = state.scoresVisible !== false;
    const sidesSwapped = state.sidesSwapped === true;
    $("scoreControls").classList.toggle("sides-swapped", sidesSwapped);
    $("swapTeams").setAttribute("aria-pressed", String(sidesSwapped));
    $("redSideLabel").textContent = sidesSwapped ? "ฝั่งขวา" : "ฝั่งซ้าย";
    $("blueSideLabel").textContent = sidesSwapped ? "ฝั่งซ้าย" : "ฝั่งขวา";
    $("swapTeams").title = sidesSwapped ? "Swap back: red left, blue right" : "Swap sides: blue left, red right";
    if (lastSidesSwapped !== null && lastSidesSwapped !== sidesSwapped) animateSideSwap();
    lastSidesSwapped = sidesSwapped;

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
    $("finishMatch").disabled = finishingMatch || phase === "idle" || phase === "finished";

    if (phase === "countdown") startCountdownDriver(); else stopCountdownDriver();
    restartClock();
  }

  function restartClock() {
    if (clockFrame) cancelAnimationFrame(clockFrame);
    if (clockInterval) clearInterval(clockInterval);
    clockFrame = null;
    clockInterval = null;
    timeUpPending = false;
    const evaluate = () => {
      const remaining = liveRemaining(state);
      paintClock($("controlClock"), remaining);
      $("controlClockBox").classList.toggle("danger", remaining > 0 && remaining <= 10000);
      if (state.running && remaining <= 0 && !timeUpPending) {
        timeUpPending = true;
        markTimeUp();
        return true;
      }
      return false;
    };
    const tick = () => {
      if (evaluate()) return;
      if (state.running) clockFrame = requestAnimationFrame(tick);
    };
    tick();
    // Safety net: requestAnimationFrame is fully suspended by the browser while this
    // tab/screen is not in the foreground (switching apps, screen lock, etc.), so on
    // its own it can freeze the display and only notice the match ended once the tab
    // is refocused — which is exactly what looks like "jumping straight to 00:00".
    // setInterval keeps running (throttled but alive) even while hidden, so it still
    // catches the time-up moment close to when it actually happens.
    if (state.running) {
      clockInterval = setInterval(() => { if (evaluate()) { clearInterval(clockInterval); clockInterval = null; } }, 250);
    }
  }

  function markTimeUp() {
    if (!roomRef) return;
    const transitionNow = nowMs();
    roomRef.transaction((current) => {
      if (!current || !current.running) return;
      if (current.endTs != null && Number(current.endTs) > transitionNow) return;
      current.running = false;
      current.remainingMs = 0;
      current.startTs = null;
      current.endTs = null;
      current.phase = "timeup";
      current.updatedAt = transitionNow;
      return current;
    }, (error) => { if (error) firebaseError(error); }, false);
  }

  function startCountdownDriver() {
    if (countdownDriver || !state.countdownEndTs) return;
    const tick = () => {
      const calculated = Math.min(3, Math.max(0, Math.ceil((Number(state.countdownEndTs) - nowMs()) / 1000)));
      // เลขนับถอยหลังต้องลดลงเท่านั้น ป้องกัน server offset หรือ snapshot เก่า
      // ทำให้ตัวเลขย้อนจาก 2 กลับเป็น 3
      const value = lastCountdownNumber == null ? calculated : Math.min(lastCountdownNumber, calculated);
      if (value !== lastCountdownNumber) $("countdownMini").textContent = value > 0 ? value : "GO!";
      lastCountdownNumber = value;
      if (value > 0) return;
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
    }, (error) => { if (error) firebaseError(error); }, false);
  }

  function stopCountdownDriver() {
    if (countdownDriver) clearInterval(countdownDriver);
    countdownDriver = null;
    lastCountdownNumber = null;
  }

  function startMatch() {
    const remaining = liveRemaining(state);
    if (remaining <= 0) return toast("กรุณารีเซ็ตเวลาก่อนเริ่มแข่งขัน");
    const startedAt = nowMs();
    const newMatchId = historyRef ? historyRef.push().key : null;
    if (!newMatchId) return toast("ไม่สามารถสร้างรหัสแมตช์ได้ กรุณาตรวจสอบการเชื่อมต่อ");
    roomRef.transaction((current) => {
      const match = Object.assign({}, DEFAULT_MATCH, current || {});
      if (!["idle", "finished"].includes(match.phase)) return;
      const safeRemaining = Math.max(0, liveRemaining(match));
      if (!safeRemaining) return;
      return Object.assign({}, match, {
        phase: "countdown", running: false, remainingMs: safeRemaining,
        startTs: null, endTs: null, countdownValue: 3,
        countdownEndTs: startedAt + 3000, matchId: newMatchId,
        historyEntryId: newMatchId, startedAt: startedAt,
        finishReason: null, historySaved: false, updatedAt: startedAt
      });
    }, (error, committed) => {
      if (error) return firebaseError(error);
      if (!committed) toast("ไม่สามารถเริ่มได้ เพราะสถานะแมตช์ถูกเปลี่ยนจากอุปกรณ์อื่น");
    }, false);
  }

  function pauseMatch() {
    const transitionNow = nowMs();
    roomRef.transaction((current) => {
      if (!current || current.phase !== "running" || !current.running) return;
      // ต้องคำนวณก่อนเปลี่ยน running เป็น false ไม่เช่นนั้นจะได้ค่า remainingMs เดิม
      // ซึ่งมักเป็นเวลาเต็มของการแข่งขันและทำให้ Resume เหมือนเริ่มนับใหม่
      const duration = Math.max(0, Number(current.durationMs) || 0);
      const pausedRemaining = Math.max(0, remainingAt(current, transitionNow));
      current.remainingMs = duration ? Math.min(duration, pausedRemaining) : pausedRemaining;
      current.phase = "paused";
      current.running = false;
      current.startTs = null;
      current.endTs = null;
      current.countdownValue = null;
      current.countdownEndTs = null;
      current.updatedAt = transitionNow;
      return current;
    }, (error, committed, snapshot) => {
      if (error) return firebaseError(error);
      if (!committed || !snapshot) return toast("ไม่สามารถหยุดเวลาได้ เพราะสถานะแมตช์ถูกเปลี่ยนจากอุปกรณ์อื่น");
      const savedMatch = snapshot.val() || {};
      toast("หยุดเวลาไว้ที่ " + formatRemainingTime(savedMatch.remainingMs));
    }, false);
  }

  function resumeMatch() {
    const resumeNow = nowMs();
    roomRef.transaction((current) => {
      if (!current || current.phase !== "paused") return;
      const duration = Math.max(0, Number(current.durationMs) || 0);
      const storedRemaining = Math.max(0, Number(current.remainingMs) || 0);
      const remaining = duration ? Math.min(duration, storedRemaining) : storedRemaining;
      if (!remaining) return;
      current.remainingMs = remaining;
      current.phase = "running";
      current.running = true;
      current.startTs = resumeNow;
      current.endTs = resumeNow + remaining;
      current.countdownValue = null;
      current.countdownEndTs = null;
      current.updatedAt = resumeNow;
      return current;
    }, (error, committed, snapshot) => {
      if (error) return firebaseError(error);
      if (!committed) toast("ไม่สามารถเดินเวลาต่อได้ กรุณาตรวจสอบเวลาคงเหลือ");
      else toast("เดินเวลาต่อจาก " + formatRemainingTime((snapshot.val() || {}).remainingMs));
    }, false);
  }

  function formatRemainingTime(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return minutes + ":" + seconds;
  }

  function finishMatch() {
    if (!db || !roomCode || !roomRef || !historyRef || finishingMatch) return;
    finishingMatch = true;
    $("finishMatch").disabled = true;
    const endedAt = nowMs();
    roomRef.once("value").then((snapshot) => {
      if (!snapshot.exists()) throw new Error("MATCH_NOT_FOUND");
      const currentMatch = Object.assign({}, DEFAULT_MATCH, snapshot.val() || {});
      if (currentMatch.phase === "idle") throw new Error("MATCH_NOT_STARTED");
      if (currentMatch.phase === "finished" && currentMatch.historySaved) return currentMatch.historyEntryId;
      const generatedId = historyRef.push().key;
      const matchId = String(currentMatch.matchId || generatedId || "");
      const historyId = String(currentMatch.historyEntryId || currentMatch.matchId || generatedId || "");
      if (!matchId || !historyId) throw new Error("MATCH_ID_UNAVAILABLE");
      const finishedMatch = Object.assign({}, currentMatch, {
        matchId: matchId,
        historyEntryId: historyId,
        phase: "finished",
        running: false,
        remainingMs: Math.max(0, liveRemaining(currentMatch)),
        startTs: null,
        endTs: null,
        countdownValue: null,
        countdownEndTs: null,
        finishReason: "manual",
        historySaved: true,
        updatedAt: endedAt
      });
      const record = buildHistoryRecord(finishedMatch, historyId, endedAt);
      const updates = {};
      updates["rooms/" + roomCode + "/match"] = finishedMatch;
      updates["rooms/" + roomCode + "/history/" + historyId] = record;
      return db.ref().update(updates).then(() => verifyHistoryRecord(historyId)).then(() => historyId);
    }).then(() => {
      finishingMatch = false;
      toast("จบการแข่งขันและบันทึกประวัติแล้ว");
    }).catch((error) => {
      finishingMatch = false;
      if (error && /MATCH_NOT_FOUND|MATCH_NOT_STARTED|MATCH_ID_UNAVAILABLE/.test(error.message || "")) {
        toast("ไม่พบข้อมูลแมตช์ที่กำลังแข่งขัน กรุณาลองเริ่มแมตช์ใหม่");
      } else if (error && /HISTORY_NOT_PERSISTED|HISTORY_SERVER_READ_FAILED/.test(error.message || "")) {
        toast("Firebase ยังไม่เก็บประวัติ กรุณา Publish firebase-rules.json เวอร์ชันล่าสุด");
      } else {
        firebaseError(error);
      }
      renderState();
    });
  }

  function resetTimer() {
    if (["countdown", "running", "paused", "timeup"].includes(state.phase) &&
        !confirm("รีเซ็ตเวลาและยกเลิกแมตช์ปัจจุบันใช่หรือไม่?")) return;
    stopCountdownDriver();
    updateMatch({ phase: "idle", running: false, remainingMs: state.durationMs, startTs: null, endTs: null, countdownValue: null, countdownEndTs: null, matchId: null, historyEntryId: null, startedAt: null, finishReason: null, historySaved: false }).then((saved) => { if (saved) toast("รีเซ็ตเวลาแล้ว"); });
  }

  function applyDuration() {
    const minutes = Math.min(99, Math.max(0, Math.floor(Number($("durationMinutes").value) || 0)));
    const seconds = Math.min(59, Math.max(0, Math.floor(Number($("durationSeconds").value) || 0)));
    const totalSeconds = minutes * 60 + seconds;
    if (totalSeconds <= 0) return toast("กรุณาตั้งเวลาอย่างน้อย 1 วินาที");
    if (["countdown", "running", "paused", "timeup"].includes(state.phase) &&
        !confirm("เปลี่ยนเวลาและยกเลิกแมตช์ปัจจุบันใช่หรือไม่?")) return;
    const duration = totalSeconds * 1000;
    $("durationMinutes").value = Math.floor(totalSeconds / 60);
    $("durationSeconds").value = totalSeconds % 60;
    stopCountdownDriver();
    updateMatch({ durationMs: duration, remainingMs: duration, running: false, startTs: null, endTs: null, phase: "idle", countdownValue: null, countdownEndTs: null, matchId: null, historyEntryId: null, startedAt: null, finishReason: null, historySaved: false }).then((saved) => { if (saved) toast("ตั้งเวลาแข่งขันเรียบร้อย"); });
  }

  function buildHistoryRecord(match, historyId, endedAt) {
    const durationMs = Math.max(0, Number(match.durationMs) || 0);
    const remainingMs = Math.max(0, Number(match.remainingMs) || 0);
    return {
      historyId: historyId,
      matchId: String(match.matchId || historyId),
      blueName: match.blueName || "Blue Team",
      redName: match.redName || "Red Team",
      blueScore: Number(match.blueScore) || 0,
      redScore: Number(match.redScore) || 0,
      durationMs: durationMs,
      playedMs: Math.max(0, durationMs - remainingMs),
      startedAt: Number(match.startedAt) || null,
      endedAt: endedAt,
      finishReason: "manual"
    };
  }

  function recordsFromSnapshot(snapshot) {
    const records = [];
    const rootValue = snapshot.val();
    if (isHistoryRecord(rootValue)) {
      records.push({ key: String(rootValue.historyId || "legacy"), value: rootValue });
      return records;
    }
    snapshot.forEach((child) => {
      const value = child.val();
      if (isHistoryRecord(value)) records.push({ key: child.key, value: value });
    });
    return records;
  }

  function isHistoryRecord(value) {
    return !!value && typeof value === "object" &&
      (value.endedAt != null || value.blueScore != null || value.redScore != null);
  }

  function verifyHistoryRecord(historyId) {
    return historyRef.child(historyId).once("value").then((snapshot) => {
      if (!snapshot.exists() || !isHistoryRecord(snapshot.val())) throw new Error("HISTORY_NOT_PERSISTED");
      return snapshot.val();
    });
  }

  function refreshHistory(snapshot) {
    renderHistoryRecords(recordsFromSnapshot(snapshot));
  }

  function renderHistoryRecords(records) {
    records.sort((a, b) => {
      const byTime = (Number(b.value.endedAt) || 0) - (Number(a.value.endedAt) || 0);
      return byTime || String(b.key).localeCompare(String(a.key));
    });
    if (!records.length) {
      $("historyList").innerHTML = '<p class="history-empty">ยังไม่มีประวัติการแข่งขัน</p>';
      if ($("historyCount")) $("historyCount").textContent = "0 รายการ";
      $("clearHistory").disabled = true;
      return;
    }
    if ($("historyCount")) $("historyCount").textContent = records.length + " รายการ";
    $("clearHistory").disabled = false;
    $("historyList").innerHTML = records.map(({ key, value }) => {
      const endedAt = Number(value.endedAt) || 0;
      const date = endedAt ? new Date(endedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "ไม่ระบุเวลา";
      const played = formatHistoryDuration(Number(value.playedMs) || Number(value.durationMs) || 0);
      const blueName = escapeHtml(value.blueName === "ทีมสีน้ำเงิน" ? "Blue Team" : (value.blueName || "Blue Team"));
      const redName = escapeHtml(value.redName === "ทีมสีแดง" ? "Red Team" : (value.redName || "Red Team"));
      return '<article class="history-item"><div class="history-meta"><span>' + date + '</span><small>' + (value.finishReason === "time" ? "หมดเวลา" : "จบโดยกรรมการ") + ' · ใช้เวลา ' + played + '</small></div><div class="history-result"><span class="history-team red">' + redName + '</span><strong>' + (Number(value.redScore) || 0) + '<i>–</i>' + (Number(value.blueScore) || 0) + '</strong><span class="history-team blue">' + blueName + '</span></div><button class="history-delete" data-history-delete="' + escapeHtml(key) + '" aria-label="ลบประวัติแมตช์นี้">ลบ</button></article>';
    }).join("");
  }

  function formatHistoryDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function deleteHistory(key) {
    if (!historyRef || !key || !confirm("ลบประวัติแมตช์นี้ใช่หรือไม่?")) return;
    historyRef.child(key).remove().then(() => toast("ลบประวัติแล้ว")).catch(firebaseError);
  }

  function clearHistory() {
    if (!historyRef || !confirm("ล้างประวัติการแข่งขันทั้งหมดของห้องนี้ใช่หรือไม่?")) return;
    historyRef.remove().then(() => toast("ล้างประวัติทั้งหมดแล้ว")).catch(firebaseError);
  }

  function adjustScore(side, amount) {
    if (!roomRef) return;
    roomRef.transaction((current) => window.EKScoreGoal.adjust(current, side, amount, nowMs()), (error) => {
      if (error) firebaseError(error);
    }, false);
  }

  function swapTeams() {
    if (!roomRef || $("swapTeams").disabled) return;
    $("swapTeams").disabled = true;
    roomRef.transaction((current) => {
      if (!current) return;
      return window.EKTeamSwap.toggleSides(current, nowMs());
    }, (error, committed, snapshot) => {
      $("swapTeams").disabled = false;
      if (error) return firebaseError(error);
      if (!committed) return toast("ไม่สามารถสลับฝั่งได้ กรุณาลองใหม่");
      const swapped = !!snapshot && (snapshot.val() || {}).sidesSwapped === true;
      toast(swapped ? "สีน้ำเงินอยู่ซ้าย · สีแดงอยู่ขวา" : "สีแดงอยู่ซ้าย · สีน้ำเงินอยู่ขวา");
    }, false);
  }

  function animateSideSwap() {
    clearTimeout(sideAnimationTimer);
    $("scoreControls").classList.remove("side-swap-flash");
    void $("scoreControls").offsetWidth;
    $("scoreControls").classList.add("side-swap-flash");
    sideAnimationTimer = setTimeout(() => $("scoreControls").classList.remove("side-swap-flash"), 450);
  }

  function renderTeamPickers() {
    ["red", "blue"].forEach((side) => {
      const select = $(side + "TeamPicker");
      const label = $(side + "NameLabel");
      const fallback = side === "red" ? "Red Team" : "Blue Team";
      const current = $(side + "Name").value.trim();
      label.textContent = fallback;
      label.hidden = roomTeams.length > 0;
      select.hidden = roomTeams.length === 0;
      if (!roomTeams.length) return;
      select.replaceChildren(new Option(fallback, fallback));
      roomTeams.forEach((name) => { if (name !== fallback) select.add(new Option(name, name)); });
      if (current && current !== fallback && !roomTeams.includes(current)) select.add(new Option(current, current));
      select.value = current || fallback;
    });
  }

  function renderSavedTeamList() {
    $("savedTeamList").replaceChildren(...roomTeams.map((name) => {
      const item = document.createElement("span");
      item.textContent = name;
      return item;
    }));
  }

  function parseTeamCsvRows(text, delimiter) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        row.push(cell); cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
      } else cell += char;
    }
    if (quoted) throw new Error("รูปแบบ CSV ไม่ถูกต้อง: เครื่องหมายคำพูดไม่ครบ");
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
    return rows;
  }

  function teamNamesFromCsv(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    const delimiter = [",", "\t", ";"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
    const rows = parseTeamCsvRows(text, delimiter);
    if (!rows.length) throw new Error("ไฟล์ CSV ว่างเปล่า");
    const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim().toLocaleLowerCase().replace(/\s+/g, " "));
    const accepted = ["team_name", "team name", "teamname", "ชื่อทีม", "ทีม"];
    const teamIndex = headers.findIndex((header) => accepted.includes(header));
    if (teamIndex < 0) throw new Error("ไม่พบคอลัมน์ชื่อทีม (team_name) ในไฟล์ CSV");
    const seen = new Set();
    const names = rows.slice(1).map((row) => String(row[teamIndex] || "").trim()).filter((name) => {
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!names.length) throw new Error("ไม่พบรายชื่อทีมในไฟล์ CSV");
    if (names.some((name) => name.length > 30)) throw new Error("ชื่อทีมต้องไม่เกิน 30 ตัวอักษร");
    if (names.length > 50) throw new Error("นำเข้าได้สูงสุด 50 ทีม");
    return names;
  }

  async function importTeamCsv(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const names = teamNamesFromCsv(await file.text());
      $("teamRosterInput").value = names.join("\n");
      $("rosterStatus").textContent = `นำเข้า ${names.length} ทีมแล้ว กรุณาตรวจสอบและกดบันทึกรายชื่อทีม`;
      toast(`นำเข้า ${names.length} ทีมแล้ว กรุณากดบันทึก`);
    } catch (error) {
      toast(error?.message || "นำเข้า CSV ไม่สำเร็จ");
    }
  }

  function saveTeamRoster() {
    if (!roomCode) return;
    const names = [...new Set($("teamRosterInput").value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
    if (names.some((name) => name.length > 30)) return toast("ชื่อทีมต้องไม่เกิน 30 ตัวอักษร");
    if (names.length > 50) return toast("บันทึกได้สูงสุด 50 ทีม");
    roomTeams = names;
    rosterPendingSync = true;
    renderTeamPickers();
    renderSavedTeamList();
    if (!names.length) {
      $("redName").value = "Red Team";
      $("blueName").value = "Blue Team";
      updateMatch({ redName: "Red Team", blueName: "Blue Team" });
    }
    try {
      localStorage.setItem("ek-soccer-roster-" + roomCode, JSON.stringify(names));
      localStorage.setItem("ek-soccer-roster-pending-" + roomCode, "1");
    } catch (_) {}
    if (!rosterRef || !firebaseConnected) {
      $("rosterStatus").textContent = "บันทึกในเครื่องนี้แล้ว ยังไม่ได้ซิงค์กับ Firebase";
      return toast("บันทึกรายชื่อทีมในเครื่องนี้แล้ว ยังไม่ได้ซิงค์กับ Firebase");
    }
    rosterRef.set(names.length ? names : null)
      .then(() => {
        const needsListener = rosterLocalOnly;
        rosterLocalOnly = false;
        rosterPendingSync = false;
        try { localStorage.removeItem("ek-soccer-roster-pending-" + roomCode); } catch (_) {}
        if (needsListener) watchRoster();
        $("rosterStatus").textContent = "รายชื่อทีมซิงค์กับ Firebase แล้ว";
        toast("บันทึกรายชื่อทีมแล้ว");
      })
      .catch((error) => {
        console.warn("บันทึกรายชื่อทีมบน Firebase ไม่ได้", error);
        rosterLocalOnly = true;
        $("rosterStatus").textContent = "บันทึกในเครื่องนี้แล้ว กรุณาเผยแพร่กฎ Firebase ล่าสุด";
        toast("บันทึกรายชื่อทีมในเครื่องนี้แล้ว กรุณาตรวจสอบกฎ Firebase");
      });
  }

  function newMatch() {
    if (!roomRef || !confirm("เริ่มแมตช์ใหม่และล้างคะแนนทั้งสองทีมใช่หรือไม่?")) return;
    roomRef.set(Object.assign({}, DEFAULT_MATCH, {
      blueName: state.blueName, redName: state.redName,
      durationMs: state.durationMs, remainingMs: state.durationMs,
      sidesSwapped: state.sidesSwapped === true,
      updatedAt: nowMs()
    })).then(() => toast("พร้อมสำหรับแมตช์ใหม่")).catch(firebaseError);
  }

  function displayUrl() {
    const code = roomCode || $("roomCode").value.trim();
    return "display.html" + (validRoom(code) ? "?room=" + encodeURIComponent(code) : "");
  }

  function openDisplay() { window.open(displayUrl(), "_blank"); }
  function toast(text) { clearTimeout(toastTimer); $("toast").textContent = text; $("toast").hidden = false; toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2600); }

  $("roomCode").addEventListener("input", cleanRoomInput);
  $("roomCode").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });
  $("roomPassword").addEventListener("input", cleanPasswordInput);
  $("roomPassword").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });
  $("randomRoom").addEventListener("click", () => { $("roomCode").value = String(Math.floor(1000 + Math.random() * 9000)); });
  $("joinRoom").addEventListener("click", joinRoom);
  $("openDisplay").addEventListener("click", openDisplay);
  $("startMatch").addEventListener("click", startMatch);
  $("pauseMatch").addEventListener("click", pauseMatch);
  $("resumeMatch").addEventListener("click", resumeMatch);
  $("finishMatch").addEventListener("click", finishMatch);
  $("resetTimer").addEventListener("click", resetTimer);
  $("applyDuration").addEventListener("click", applyDuration);
  $("newMatch").addEventListener("click", newMatch);
  $("swapTeams").addEventListener("click", swapTeams);
  $("clearHistory").addEventListener("click", clearHistory);
  $("historyList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-delete]");
    if (button) deleteHistory(button.dataset.historyDelete);
  });
  $("scoresVisible").addEventListener("change", (event) => updateMatch({ scoresVisible: event.target.checked }));
  $("saveTeamRoster").addEventListener("click", saveTeamRoster);
  $("importTeamCsv").addEventListener("click", () => $("teamCsvFile").click());
  $("teamCsvFile").addEventListener("change", importTeamCsv);
  ["red", "blue"].forEach((side) => {
    $(side + "TeamPicker").addEventListener("change", (event) => {
      const previousName = state[side + "Name"] || (side === "red" ? "Red Team" : "Blue Team");
      const selectedName = event.target.value;
      $("teamSelectionStatus").hidden = false;
      $("teamSelectionStatus").classList.remove("error");
      $("teamSelectionStatus").textContent = "กำลังซิงค์ชื่อทีมกับ Firebase…";
      updateMatch({ [side + "Name"]: selectedName }).then((saved) => {
        if (saved) {
          $("teamSelectionStatus").textContent = "ชื่อทีมซิงค์กับ Firebase แล้ว";
        } else {
          $(side + "Name").value = previousName;
          event.target.value = previousName;
          $("teamSelectionStatus").classList.add("error");
          $("teamSelectionStatus").textContent = "ส่งชื่อทีมไปยัง Firebase ไม่สำเร็จ";
          toast("ส่งชื่อทีมไปยัง Firebase ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ");
        }
      });
    });
  });
  document.querySelectorAll("[data-score]").forEach((button) => button.addEventListener("click", () => adjustScore(button.dataset.score, Number(button.dataset.value))));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && joined) restartClock(); });
})();

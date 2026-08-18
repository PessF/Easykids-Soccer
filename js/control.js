(function () {
  "use strict";

  const ROOM_PASSWORD = "2877";
  const DEFAULT_DURATION = 5 * 60 * 1000;
  const DEFAULT_MATCH = {
    blueName: "ทีมสีน้ำเงิน", redName: "ทีมสีแดง",
    blueScore: 0, redScore: 0,
    durationMs: DEFAULT_DURATION, remainingMs: DEFAULT_DURATION,
    running: false, startTs: null, endTs: null, phase: "idle",
    countdownValue: null, countdownEndTs: null,
    scoresVisible: true, matchId: null, historyEntryId: null, startedAt: null, finishReason: null,
    historySaved: false,
    updatedAt: 0
  };

  let db = null;
  let roomRef = null;
  let historyRef = null;
  let roomCode = "";
  let state = Object.assign({}, DEFAULT_MATCH);
  let clockFrame = null;
  let timeUpPending = false;
  let finishingMatch = false;
  let countdownDriver = null;
  let nameTimer = null;
  let toastTimer = null;
  let serverOffsetMs = 0;
  let historyQuery = null;
  let joined = false;
  let lastFirebaseErrorAt = 0;
  let audioContext = null;

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

  function validRoom(value) { return /^\d{4}$/.test(value); }
  function cleanRoomInput() { $("roomCode").value = $("roomCode").value.replace(/\D/g, "").slice(0, 4); }
  function cleanPasswordInput() { $("roomPassword").value = $("roomPassword").value.replace(/\D/g, "").slice(0, 4); }

  function joinRoom() {
    if (joined) return;
    cleanRoomInput();
    const code = $("roomCode").value.trim();
    if (!validRoom(code)) return toast("กรุณากรอกรหัสสนามเป็นตัวเลข 4 หลัก");
    if ($("roomPassword").value !== ROOM_PASSWORD) return toast("รหัสผ่านห้องไม่ถูกต้อง");
    $("joinRoom").disabled = true;
    $("joinRoom").textContent = "กำลังเชื่อมต่อ…";
    roomCode = code;
    try {
      initFirebase();
    } catch (error) {
      $("joinRoom").disabled = false;
      $("joinRoom").textContent = "เข้าสู่หน้าควบคุม";
      console.error(error);
      return toast("โหลด Firebase ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตและไฟล์ตั้งค่า");
    }
    roomRef = db.ref("rooms/" + roomCode + "/match");
    historyRef = db.ref("rooms/" + roomCode + "/history");
    historyQuery = historyRef.orderByChild("endedAt");
    joined = true;
    $("roomGate").hidden = true;
    $("controlApp").hidden = false;
    $("roomPill").textContent = "ROOM " + roomCode + "  ▢";

    db.ref(".info/connected").on("value", (snapshot) => {
      const online = !!snapshot.val();
      $("syncState").classList.toggle("online", online);
      $("syncText").textContent = online ? "เชื่อมต่อแล้ว" : "ออฟไลน์ · รอเชื่อมต่อ";
    });
    db.ref(".info/serverTimeOffset").on("value", (snapshot) => {
      serverOffsetMs = Number(snapshot.val()) || 0;
    });

    roomRef.on("value", (snapshot) => {
      if (!snapshot.exists()) return;
      state = Object.assign({}, DEFAULT_MATCH, snapshot.val() || {});
      renderState();
    }, firebaseError);
    historyQuery.on("value", refreshHistory, firebaseError);

    roomRef.transaction((current) => current || Object.assign({}, DEFAULT_MATCH, {
      updatedAt: nowMs()
    }), (error) => {
      if (error) firebaseError(error);
    }, false);
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

  function liveRemaining(match) {
    if (!match.running) return Number(match.remainingMs) || 0;
    if (match.endTs != null && Number.isFinite(Number(match.endTs))) return Number(match.endTs) - nowMs();
    if (!match.startTs) return Number(match.remainingMs) || 0;
    return (Number(match.remainingMs) || 0) - (nowMs() - match.startTs);
  }

  function formatClock(ms) {
    const safe = Math.max(0, ms);
    const whole = Math.floor(safe / 1000);
    const min = String(Math.floor(whole / 60)).padStart(2, "0");
    const sec = String(whole % 60).padStart(2, "0");
    const milli = String(Math.floor(safe % 1000)).padStart(3, "0");
    return '<span class="clock-main">' + min + ":" + sec + '</span><span class="clock-ms">.' + milli + "</span>";
  }

  function paintClock(element, ms) {
    const safe = Math.max(0, ms);
    const whole = Math.floor(safe / 1000);
    const main = String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0");
    const milli = "." + String(Math.floor(safe % 1000)).padStart(3, "0");
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
    $("finishMatch").disabled = finishingMatch || phase === "idle" || phase === "finished";

    if (phase === "countdown") startCountdownDriver(); else stopCountdownDriver();
    restartClock();
  }

  function restartClock() {
    if (clockFrame) cancelAnimationFrame(clockFrame);
    clockFrame = null;
    timeUpPending = false;
    const tick = () => {
      const remaining = liveRemaining(state);
      paintClock($("controlClock"), remaining);
      paintClock($("previewClock").querySelector(".clock"), remaining);
      $("controlClockBox").classList.toggle("danger", remaining > 0 && remaining <= 10000);
      if (state.running && remaining <= 0 && !timeUpPending) {
        timeUpPending = true;
        markTimeUp();
        return;
      }
      if (state.running) {
        clockFrame = requestAnimationFrame(tick);
      }
    };
    tick();
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
    const startedAt = nowMs();
    const newMatchId = historyRef ? historyRef.push().key : null;
    if (!newMatchId) return toast("ไม่สามารถสร้างรหัสแมตช์ได้ กรุณาตรวจสอบการเชื่อมต่อ");
    playAudio("countdownAudio");
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
      current.phase = "paused";
      current.running = false;
      current.remainingMs = Math.max(0, liveRemaining(current));
      current.startTs = null;
      current.endTs = null;
      current.countdownValue = null;
      current.countdownEndTs = null;
      current.updatedAt = transitionNow;
      return current;
    }, (error) => { if (error) firebaseError(error); }, false);
  }

  function resumeMatch() {
    const resumeNow = nowMs();
    roomRef.transaction((current) => {
      if (!current || current.phase !== "paused") return;
      const remaining = Math.max(0, Number(current.remainingMs) || 0);
      if (!remaining) return;
      current.phase = "running";
      current.running = true;
      current.startTs = resumeNow;
      current.endTs = resumeNow + remaining;
      current.countdownValue = null;
      current.countdownEndTs = null;
      current.updatedAt = resumeNow;
      return current;
    }, (error, committed) => {
      if (error) return firebaseError(error);
      if (!committed) toast("ไม่สามารถเดินเวลาต่อได้ กรุณาตรวจสอบเวลาคงเหลือ");
    }, false);
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
      blueName: match.blueName || "ทีมสีน้ำเงิน",
      redName: match.redName || "ทีมสีแดง",
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
      const blueName = escapeHtml(value.blueName || "ทีมสีน้ำเงิน");
      const redName = escapeHtml(value.redName || "ทีมสีแดง");
      return '<article class="history-item"><div class="history-meta"><span>' + date + '</span><small>' + (value.finishReason === "time" ? "หมดเวลา" : "จบโดยกรรมการ") + ' · ใช้เวลา ' + played + '</small></div><div class="history-result"><span class="history-team blue">' + blueName + '</span><strong>' + (Number(value.blueScore) || 0) + '<i>–</i>' + (Number(value.redScore) || 0) + '</strong><span class="history-team red">' + redName + '</span></div><button class="history-delete" data-history-delete="' + escapeHtml(key) + '" aria-label="ลบประวัติแมตช์นี้">ลบ</button></article>';
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
    roomRef.child(side + "Score").transaction((value) => Math.min(999, Math.max(0, (Number(value) || 0) + amount)), (error) => {
      if (error) firebaseError(error);
    }, false);
  }

  function saveTeamNames() {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => updateMatch({
      blueName: $("blueName").value.trim() || "ทีมสีน้ำเงิน",
      redName: $("redName").value.trim() || "ทีมสีแดง"
    }), 250);
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
  function ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    return audioContext;
  }

  function synthAudio(kind) {
    const context = ensureAudioContext();
    if (!context) return;
    const notes = kind === "whistle"
      ? [{ at: 0, hz: 1500, length: .55 }, { at: .08, hz: 1850, length: .48 }]
      : [{ at: 0, hz: 660, length: .14 }, { at: .55, hz: 660, length: .14 }, { at: 1.1, hz: 880, length: .24 }];
    notes.forEach((note) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = kind === "whistle" ? "sine" : "square";
      oscillator.frequency.setValueAtTime(note.hz, context.currentTime + note.at);
      gain.gain.setValueAtTime(.0001, context.currentTime + note.at);
      gain.gain.exponentialRampToValueAtTime(.13, context.currentTime + note.at + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + note.at + note.length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + note.at);
      oscillator.stop(context.currentTime + note.at + note.length + .02);
    });
  }

  function playAudio(id) {
    const audio = $(id);
    const kind = /whistle/i.test(id) ? "whistle" : "countdown";
    if (!audio || audio.dataset.failed === "true") return synthAudio(kind);
    audio.pause();
    audio.currentTime = 0;
    audio.play().catch(() => synthAudio(kind));
  }
  function toast(text) { clearTimeout(toastTimer); $("toast").textContent = text; $("toast").hidden = false; toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2600); }

  $("roomCode").addEventListener("input", cleanRoomInput);
  $("roomCode").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });
  $("roomPassword").addEventListener("input", cleanPasswordInput);
  $("roomPassword").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });
  $("randomRoom").addEventListener("click", () => { $("roomCode").value = String(Math.floor(1000 + Math.random() * 9000)); });
  $("joinRoom").addEventListener("click", joinRoom);
  $("openDisplayGate").addEventListener("click", openDisplay);
  $("openDisplay").addEventListener("click", openDisplay);
  $("openDisplayPreview").addEventListener("click", openDisplay);
  $("roomPill").addEventListener("click", () => {
    if (!navigator.clipboard) return toast("รหัสสนาม: " + roomCode);
    navigator.clipboard.writeText(roomCode).then(() => toast("คัดลอกรหัสสนามแล้ว")).catch(() => toast("รหัสสนาม: " + roomCode));
  });
  $("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("ek-soccer-theme", next); } catch (_) {}
  });
  $("startMatch").addEventListener("click", startMatch);
  $("pauseMatch").addEventListener("click", pauseMatch);
  $("resumeMatch").addEventListener("click", resumeMatch);
  $("finishMatch").addEventListener("click", finishMatch);
  $("resetTimer").addEventListener("click", resetTimer);
  $("applyDuration").addEventListener("click", applyDuration);
  $("newMatch").addEventListener("click", newMatch);
  $("clearHistory").addEventListener("click", clearHistory);
  $("historyList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-delete]");
    if (button) deleteHistory(button.dataset.historyDelete);
  });
  $("scoresVisible").addEventListener("change", (event) => updateMatch({ scoresVisible: event.target.checked }));
  $("blueName").addEventListener("input", saveTeamNames);
  $("redName").addEventListener("input", saveTeamNames);
  document.querySelectorAll("[data-score]").forEach((button) => button.addEventListener("click", () => adjustScore(button.dataset.score, Number(button.dataset.value))));
  $("assetToggle").addEventListener("click", () => { $("assetInfo").hidden = !$("assetInfo").hidden; $("assetArrow").textContent = $("assetInfo").hidden ? "แสดง" : "ซ่อน"; });
  $("testCountdown").addEventListener("click", () => playAudio("countdownAudio"));
  $("testWhistle").addEventListener("click", () => playAudio("whistleAudio"));
  [$("countdownAudio"), $("whistleAudio")].forEach((audio) => {
    if (audio) audio.addEventListener("error", () => { audio.dataset.failed = "true"; });
  });
})();

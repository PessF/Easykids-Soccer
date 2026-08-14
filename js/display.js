(function () {
  "use strict";
  const DEFAULT_MATCH = { blueName:"ทีมสีน้ำเงิน", redName:"ทีมสีแดง", blueScore:0, redScore:0, durationMs:300000, remainingMs:300000, running:false, startTs:null, phase:"idle", countdownValue:null, scoresVisible:true };
  const $ = (id) => document.getElementById(id);
  let db = null, roomRef = null, roomCode = "", state = Object.assign({}, DEFAULT_MATCH), clockFrame = null, lastPhase = "idle";

  const queryRoom = new URLSearchParams(location.search).get("room") || "";
  $("displayRoomCode").value = queryRoom.replace(/\D/g, "").slice(0, 4);

  function enterDisplay() {
    roomCode = $("displayRoomCode").value.replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(roomCode)) { $("displayEntryError").hidden = false; return; }
    $("displayEntryError").hidden = true;
    $("displayEntry").hidden = true;
    $("matchDisplay").hidden = false;
    $("displayStatus").textContent = "◌ ROOM " + roomCode;
    if (!firebase.apps.length) firebase.initializeApp(window.EK_FIREBASE_CONFIG);
    db = firebase.database();
    roomRef = db.ref("rooms/" + roomCode + "/match");
    db.ref(".info/connected").on("value", (snapshot) => {
      const online = !!snapshot.val();
      $("displayStatus").classList.toggle("online", online);
      $("displayStatus").textContent = (online ? "●" : "◌") + " ROOM " + roomCode;
    });
    roomRef.on("value", (snapshot) => {
      if (!snapshot.exists()) return;
      state = Object.assign({}, DEFAULT_MATCH, snapshot.val() || {});
      renderState();
    }, (error) => console.error(error));
  }

  function liveRemaining(match) { return !match.running || !match.startTs ? Math.max(0, Number(match.remainingMs)||0) : Math.max(0, (Number(match.remainingMs)||0) - (Date.now() - match.startTs)); }
  function formatClock(ms) { const safe=Math.max(0,ms), whole=Math.floor(safe/1000), min=String(Math.floor(whole/60)).padStart(2,"0"), sec=String(whole%60).padStart(2,"0"), milli=String(Math.floor(safe%1000)).padStart(3,"0"); return min+":"+sec+'<span class="clock-ms">.'+milli+"</span>"; }
  function phaseLabel(phase) { return phase==="countdown"?"เตรียมเริ่มการแข่งขัน":phase==="running"?"กำลังแข่งขัน":phase==="paused"?"หยุดเวลา":phase==="finished"?"จบการแข่งขัน":"พร้อมเริ่ม"; }

  function renderState() {
    $("displayBlueName").textContent = state.blueName || "ทีมสีน้ำเงิน";
    $("displayRedName").textContent = state.redName || "ทีมสีแดง";
    setScore("displayBlueScore", Number(state.blueScore)||0);
    setScore("displayRedScore", Number(state.redScore)||0);
    $("displayScoreboard").hidden = state.scoresVisible === false;
    $("displayPhase").className = "phase-display " + state.phase;
    $("displayPhase").textContent = phaseLabel(state.phase);
    $("pausedRibbon").hidden = state.phase !== "paused";
    $("matchDisplay").classList.toggle("is-paused", state.phase === "paused");
    $("countdownOverlay").hidden = state.phase !== "countdown";
    if (state.phase === "countdown") {
      $("countdownNumber").textContent = state.countdownValue > 0 ? state.countdownValue : "GO!";
      if (lastPhase !== "countdown") playAudio("displayCountdownAudio");
    }
    if (state.phase === "running" && lastPhase === "countdown") playAudio("displayWhistleAudio");
    lastPhase = state.phase;
    const blueWinner = state.phase === "finished" && state.blueScore > state.redScore;
    const redWinner = state.phase === "finished" && state.redScore > state.blueScore;
    winner("blueTeamBox", blueWinner); winner("redTeamBox", redWinner);
    restartClock();
  }

  function setScore(id, value) { const el=$(id); if(el.textContent===String(value)) return; el.textContent=value; el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),180); }
  function winner(id, active) { const box=$(id); box.classList.toggle("winner",active); box.querySelector(".winner-label").hidden=!active; }
  function restartClock() { if(clockFrame) cancelAnimationFrame(clockFrame); const tick=()=>{ const remaining=liveRemaining(state); $("displayClock").innerHTML=formatClock(remaining); $("displayTimerBox").classList.toggle("danger",remaining>0&&remaining<=10000); if(state.running) clockFrame=requestAnimationFrame(tick); }; tick(); }
  function playAudio(id) { const audio=$(id); if(!audio)return; audio.pause(); audio.currentTime=0; audio.play().catch(()=>{}); }

  $("displayRoomCode").addEventListener("input",()=>{$("displayRoomCode").value=$("displayRoomCode").value.replace(/\D/g,"").slice(0,4);});
  $("displayRoomCode").addEventListener("keydown",(event)=>{if(event.key==="Enter")enterDisplay();});
  $("enterDisplay").addEventListener("click",enterDisplay);
  $("logoLeft").addEventListener("error",()=>{$("logoLeft").hidden=true;});
  $("logoRight").addEventListener("error",()=>{$("logoRight").hidden=true;});
  $("fullscreenButton").addEventListener("click",()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen().catch(()=>{});else document.exitFullscreen().catch(()=>{});});
  $("displaySettingsButton").addEventListener("click",()=>{$("displaySettings").hidden=!$("displaySettings").hidden;});
  $("closeDisplaySettings").addEventListener("click",()=>{$("displaySettings").hidden=true;});
  $("displayTestCountdown").addEventListener("click",()=>playAudio("displayCountdownAudio"));
  $("displayTestWhistle").addEventListener("click",()=>playAudio("displayWhistleAudio"));
})();

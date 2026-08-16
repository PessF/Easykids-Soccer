(function () {
  "use strict";
  const ROOM_PASSWORD = "2877";
  const DEFAULT_MATCH = { blueName:"ทีมสีน้ำเงิน", redName:"ทีมสีแดง", blueScore:0, redScore:0, durationMs:300000, remainingMs:300000, running:false, startTs:null, endTs:null, phase:"idle", countdownValue:null, countdownEndTs:null, scoresVisible:true, matchId:null, historyEntryId:null, startedAt:null, finishReason:null, historySaved:false };
  const $ = (id) => document.getElementById(id);
  let db = null, roomRef = null, roomCode = "", state = Object.assign({}, DEFAULT_MATCH), clockFrame = null, countdownDriver = null, lastPhase = "idle", serverOffsetMs = 0, timeUpPending = false;

  const queryRoom = new URLSearchParams(location.search).get("room") || "";
  $("displayRoomCode").value = queryRoom.replace(/\D/g, "").slice(0, 4);

  function enterDisplay() {
    roomCode = $("displayRoomCode").value.replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(roomCode)) { showEntryError("กรุณากรอกรหัสสนามเป็นตัวเลข 4 หลัก"); return; }
    if ($("displayRoomPassword").value !== ROOM_PASSWORD) { showEntryError("รหัสผ่านห้องไม่ถูกต้อง"); return; }
    $("displayEntryError").hidden = true;
    $("displayEntry").hidden = true;
    $("matchDisplay").hidden = false;
    $("displayStatus").textContent = "ROOM " + roomCode;
    if (!firebase.apps.length) firebase.initializeApp(window.EK_FIREBASE_CONFIG);
    db = firebase.database();
    roomRef = db.ref("rooms/" + roomCode + "/match");
    db.ref(".info/connected").on("value", (snapshot) => {
      const online = !!snapshot.val();
      $("displayStatus").classList.toggle("online", online);
      $("displayStatus").textContent = "ROOM " + roomCode;
    });
    db.ref(".info/serverTimeOffset").on("value", (snapshot) => { serverOffsetMs = Number(snapshot.val()) || 0; });
    roomRef.on("value", (snapshot) => {
      if (!snapshot.exists()) return;
      state = Object.assign({}, DEFAULT_MATCH, snapshot.val() || {});
      renderState();
    }, (error) => console.error(error));
  }

  function nowMs() { return Date.now() + serverOffsetMs; }
  function liveRemaining(match) { if(!match.running)return Number(match.remainingMs)||0; if(match.endTs!=null&&Number.isFinite(Number(match.endTs)))return Number(match.endTs)-nowMs(); return !match.startTs?Number(match.remainingMs)||0:(Number(match.remainingMs)||0)-(nowMs()-match.startTs); }
  function formatClock(ms) { const safe=Math.max(0,ms),whole=Math.floor(safe/1000),min=String(Math.floor(whole/60)).padStart(2,"0"),sec=String(whole%60).padStart(2,"0"),milli=String(Math.floor(safe%1000)).padStart(3,"0"); return '<span class="clock-main">'+min+":"+sec+'</span><span class="clock-ms">.'+milli+"</span>"; }
  function paintClock(element,ms){const safe=Math.max(0,ms),whole=Math.floor(safe/1000),main=String(Math.floor(whole/60)).padStart(2,"0")+":"+String(whole%60).padStart(2,"0"),milli="."+String(Math.floor(safe%1000)).padStart(3,"0"),mainElement=element.querySelector(".clock-main"),milliElement=element.querySelector(".clock-ms");if(!mainElement||!milliElement){element.innerHTML=formatClock(ms);return;}if(mainElement.textContent!==main)mainElement.textContent=main;if(milliElement.textContent!==milli)milliElement.textContent=milli;}
  function phaseLabel(phase) { return phase==="countdown"?"เตรียมเริ่มการแข่งขัน":phase==="running"?"กำลังแข่งขัน":phase==="timeup"?"หมดเวลา · รอกรรมการจบแมตช์":phase==="paused"?"หยุดเวลา":phase==="finished"?"จบการแข่งขัน":"พร้อมเริ่ม"; }

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
    if(state.phase==="countdown")startCountdownDriver();else stopCountdownDriver();
    restartClock();
  }

  function setScore(id, value) { const el=$(id); if(el.textContent===String(value)) return; el.textContent=value; el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),180); }
  function winner(id, active) { const box=$(id); box.classList.toggle("winner",active); box.querySelector(".winner-label").hidden=!active; }
  function restartClock() { if(clockFrame)cancelAnimationFrame(clockFrame);clockFrame=null;timeUpPending=false;const tick=()=>{const remaining=liveRemaining(state);paintClock($("displayClock"),remaining);$("displayTimerBox").classList.toggle("danger",remaining>0&&remaining<=10000);if(state.running&&remaining<=0&&!timeUpPending){timeUpPending=true;markTimeUp();return;}if(state.running)clockFrame=requestAnimationFrame(tick);};tick();}
  function markTimeUp(){if(!roomRef)return;const transitionNow=nowMs();roomRef.transaction((current)=>{if(!current||!current.running)return;if(current.endTs!=null&&Number(current.endTs)>transitionNow)return;current.running=false;current.remainingMs=0;current.startTs=null;current.endTs=null;current.phase="timeup";current.updatedAt=transitionNow;return current;},(error)=>{if(error)console.error(error);},false);}
  function startCountdownDriver(){if(countdownDriver||!state.countdownEndTs)return;const tick=()=>{const value=Math.max(0,Math.ceil((Number(state.countdownEndTs)-nowMs())/1000));$("countdownNumber").textContent=value>0?value:"GO!";if(value<=0){stopCountdownDriver();completeCountdown();}};countdownDriver=setInterval(tick,100);tick();}
  function stopCountdownDriver(){if(countdownDriver)clearInterval(countdownDriver);countdownDriver=null;}
  function completeCountdown(){if(!roomRef)return;const transitionNow=nowMs();roomRef.transaction((current)=>{if(!current||current.phase!=="countdown"||Number(current.countdownEndTs)>transitionNow)return;const remaining=Math.max(0,Number(current.remainingMs)||Number(current.durationMs)||0);current.phase=remaining>0?"running":"finished";current.running=remaining>0;current.startTs=remaining>0?transitionNow:null;current.endTs=remaining>0?transitionNow+remaining:null;current.countdownValue=0;current.countdownEndTs=null;current.updatedAt=transitionNow;return current;},(error)=>{if(error)console.error(error);},false);}
  function showEntryError(message){$("displayEntryError").textContent=message;$("displayEntryError").hidden=false;}
  function playAudio(id) { const audio=$(id); if(!audio)return; audio.pause(); audio.currentTime=0; audio.play().catch(()=>{}); }

  $("displayRoomCode").addEventListener("input",()=>{$("displayRoomCode").value=$("displayRoomCode").value.replace(/\D/g,"").slice(0,4);});
  $("displayRoomPassword").addEventListener("input",()=>{$("displayRoomPassword").value=$("displayRoomPassword").value.replace(/\D/g,"").slice(0,4);});
  $("displayRoomCode").addEventListener("keydown",(event)=>{if(event.key==="Enter")$("displayRoomPassword").focus();});
  $("displayRoomPassword").addEventListener("keydown",(event)=>{if(event.key==="Enter")enterDisplay();});
  $("enterDisplay").addEventListener("click",enterDisplay);
  $("entryLogoRight").addEventListener("error",()=>{$("entryLogoRight").hidden=true;});
  $("logoRight").addEventListener("error",()=>{$("logoRight").hidden=true;});
  if($("entryLogoRight").complete&&!$("entryLogoRight").naturalWidth)$("entryLogoRight").hidden=true;
  if($("logoRight").complete&&!$("logoRight").naturalWidth)$("logoRight").hidden=true;
  $("fullscreenButton").addEventListener("click",()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen().catch(()=>{});else document.exitFullscreen().catch(()=>{});});
  $("displaySettingsButton").addEventListener("click",()=>{$("displaySettings").hidden=!$("displaySettings").hidden;});
  $("closeDisplaySettings").addEventListener("click",()=>{$("displaySettings").hidden=true;});
  $("displayTestCountdown").addEventListener("click",()=>playAudio("displayCountdownAudio"));
  $("displayTestWhistle").addEventListener("click",()=>playAudio("displayWhistleAudio"));
})();

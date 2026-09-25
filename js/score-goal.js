(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.EKScoreGoal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function adjust(match, side, amount, timestamp) {
    if (!match || !["red", "blue"].includes(side) || ![-1, 1].includes(amount)) return null;
    const key = side + "Score";
    const oldScore = Number(match[key]) || 0;
    const nextScore = Math.min(999, Math.max(0, oldScore + amount));
    if (nextScore === oldScore) return null;
    const next = Object.assign({}, match, { [key]: nextScore });
    if (amount > 0 && match.phase === "running" && match.running === true) {
      const remaining = match.endTs != null && Number.isFinite(Number(match.endTs))
        ? Number(match.endTs) - timestamp
        : match.startTs != null
          ? (Number(match.remainingMs) || 0) - (timestamp - Number(match.startTs))
          : Number(match.remainingMs) || 0;
      if (remaining > 0) {
        const duration = Math.max(0, Number(match.durationMs) || 0);
        next.remainingMs = duration ? Math.min(duration, remaining) : remaining;
        next.phase = "paused";
        next.running = false;
        next.startTs = null;
        next.endTs = null;
        next.countdownValue = null;
        next.countdownEndTs = null;
        next.updatedAt = timestamp;
      }
    }
    return next;
  }

  return { adjust };
});

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.EKTeamSwap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function toggleSides(match, updatedAt) {
    if (!match || typeof match !== "object") return null;
    return Object.assign({}, match, {
      sidesSwapped: match.sidesSwapped !== true,
      updatedAt: Math.max(Number(match.updatedAt) || 0, Number(updatedAt) || 0)
    });
  }

  return { toggleSides: toggleSides };
});

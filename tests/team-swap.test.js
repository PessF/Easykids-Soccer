"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { toggleSides } = require("../js/team-swap.js");

test("toggles the visual sides without moving team data", () => {
  const match = {
    redName: "Falcons",
    blueName: "Tigers",
    redScore: 4,
    blueScore: 2,
    phase: "running",
    running: true,
    remainingMs: 123456,
    endTs: 999999,
    matchId: "match-1",
    sidesSwapped: false,
    updatedAt: 100
  };

  const result = toggleSides(match, 200);

  assert.deepEqual(result, {
    redName: "Falcons",
    blueName: "Tigers",
    redScore: 4,
    blueScore: 2,
    phase: "running",
    running: true,
    remainingMs: 123456,
    endTs: 999999,
    matchId: "match-1",
    sidesSwapped: true,
    updatedAt: 200
  });
  assert.equal(match.sidesSwapped, false, "the Firebase transaction input is not mutated");
});

test("a second toggle restores the original orientation and preserves timestamps", () => {
  const match = {
    redName: "Red",
    blueName: "Blue",
    redScore: 1,
    blueScore: 3,
    phase: "paused",
    sidesSwapped: true,
    updatedAt: 500
  };

  const result = toggleSides(match, 400);

  assert.equal(result.sidesSwapped, false);
  assert.equal(result.redName, "Red");
  assert.equal(result.blueName, "Blue");
  assert.equal(result.redScore, 1);
  assert.equal(result.blueScore, 3);
  assert.equal(result.phase, "paused");
  assert.equal(result.updatedAt, 500);
});

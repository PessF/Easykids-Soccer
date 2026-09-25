"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { adjust } = require("../js/score-goal.js");

const running = {
  phase: "running", running: true, durationMs: 300000,
  remainingMs: 300000, startTs: 1000, endTs: 301000,
  redScore: 0, blueScore: 0
};

for (const side of ["red", "blue"]) {
test(`${side} goal pauses a running match`, () => {
    const result = adjust(running, side, 1, 11000);
    assert.equal(result[side + "Score"], 1);
    assert.equal(result.remainingMs, 290000);
    assert.equal(result.phase, "paused");
    assert.equal(result.running, false);
    assert.equal(result.endTs, null);
    assert.equal(result.goalEventId, undefined);
    assert.equal(running.phase, "running");
  });
}

for (const phase of ["idle", "countdown", "paused", "finished"]) {
  test(`score during ${phase} does not pause or trigger cheer`, () => {
    const result = adjust({ ...running, phase, running: false }, "red", 1, 11000);
    assert.equal(result.redScore, 1);
    assert.equal(result.phase, phase);
    assert.equal(result.goalEventId, undefined);
  });
}

test("subtracting a score does not pause or trigger cheer", () => {
  const result = adjust({ ...running, redScore: 2 }, "red", -1, 11000);
  assert.equal(result.redScore, 1);
  assert.equal(result.phase, "running");
  assert.equal(result.goalEventId, undefined);
});

test("score at limit does not trigger cheer", () => {
  assert.equal(adjust({ ...running, redScore: 999 }, "red", 1, 11000), null);
});

test("score after the clock has expired does not trigger cheer", () => {
  const result = adjust(running, "red", 1, 301000);
  assert.equal(result.redScore, 1);
  assert.equal(result.phase, "running");
  assert.equal(result.goalEventId, undefined);
});

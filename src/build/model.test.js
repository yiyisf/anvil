import test from "node:test";
import assert from "node:assert/strict";
import { phaseState, requirementUnderstanding } from "./model.js";

test("BUILD phase projection follows completed planning", () => {
  const data = {
    work: { status: "active" },
    activities: [
      { type: "alignment", status: "completed" },
      { type: "planning", status: "completed" },
    ],
  };
  assert.equal(phaseState("alignment", data), "done");
  assert.equal(phaseState("implementation", data), "active");
  assert.equal(phaseState("completed", data), "todo");
});

test("requirement understanding projects user answers and latest open question", () => {
  const understanding = requirementUnderstanding({
    status: "waiting_user",
    conversation: [
      { role: "assistant", text: "目标用户是谁？" },
      { role: "user", text: "内部工程师" },
      { role: "assistant", text: "是否需要保留旧接口？" },
    ],
    technical: { files: ["src/app/App.jsx"] },
  }, "修复旧接口兼容");
  assert.equal(understanding.overview, "修复旧接口兼容");
  assert.deepEqual(understanding.confirmed, ["内部工程师"]);
  assert.deepEqual(understanding.decisions, [
    { question: "目标用户是谁？", answer: "内部工程师" },
  ]);
  assert.deepEqual(understanding.open, ["是否需要保留旧接口？"]);
  assert.deepEqual(understanding.impact, ["src/app/App.jsx"]);
});


test("requirement understanding exposes the selected execution outcome", () => {
  const understanding = requirementUnderstanding({
    status: "completed",
    conversation: [
      { role: "user", text: "修复登录按钮间距" },
      { role: "assistant", text: "是否只调整桌面端？" },
      { role: "user", text: "桌面端和移动端都调整" },
    ],
    alignmentDecision: {
      status: "ready",
      route: "direct",
      reason: "范围明确且改动局部",
      risk: "low",
    },
  });
  assert.deepEqual(understanding.decisions, [
    {
      question: "是否只调整桌面端？",
      answer: "桌面端和移动端都调整",
    },
  ]);
  assert.deepEqual(understanding.outcome, {
    route: "direct",
    reason: "范围明确且改动局部",
    risk: "low",
  });
});

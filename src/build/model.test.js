import test from "node:test";
import assert from "node:assert/strict";
import { phaseState, requirementUnderstanding } from "./model.js";

test("BUILD phase projection follows implementation Activity state", () => {
  const data = {
    work: { status: "active" },
    activities: [
      { type: "alignment", status: "completed" },
      { type: "planning", status: "completed" },
      { type: "implementation", status: "running" },
    ],
  };
  assert.equal(phaseState("alignment", data), "done");
  assert.equal(phaseState("implementation", data), "active");
  assert.equal(phaseState("completed", data), "todo");
});

test("requirement understanding uses structured summaries, not raw responses", () => {
  const understanding = requirementUnderstanding(
    {
      status: "waiting_user",
      conversation: [
        {
          role: "assistant",
          text: "这里是很长的分析过程，不应出现在右侧决策记录。目标用户是谁？",
        },
        { role: "user", text: "选项 A" },
      ],
      decisionLog: [
        {
          question: "目标用户群体？",
          outcome: "仅供内部工程师使用",
        },
      ],
      alignmentDecision: {
        status: "needs_input",
        question: "是否需要兼容旧接口？",
      },
      technical: { files: ["src/app/App.jsx"] },
    },
    "修复旧接口兼容",
  );
  assert.equal(understanding.overview, "修复旧接口兼容");
  assert.deepEqual(understanding.confirmed, ["仅供内部工程师使用"]);
  assert.deepEqual(understanding.decisions, [
    { question: "目标用户群体？", answer: "仅供内部工程师使用" },
  ]);
  assert.deepEqual(understanding.open, ["是否需要兼容旧接口？"]);
  assert.equal(
    understanding.decisions.some((entry) => entry.question.includes("分析过程")),
    false,
  );
  assert.deepEqual(understanding.impact, ["src/app/App.jsx"]);
});

test("requirement understanding exposes the selected execution outcome", () => {
  const understanding = requirementUnderstanding({
    status: "completed",
    decisionLog: [
      {
        question: "适配哪些终端？",
        outcome: "桌面端和移动端均需调整",
      },
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
      question: "适配哪些终端？",
      answer: "桌面端和移动端均需调整",
    },
  ]);
  assert.deepEqual(understanding.outcome, {
    route: "direct",
    reason: "范围明确且改动局部",
    risk: "low",
  });
});


test("completed direct BUILD marks implementation and verification done", () => {
  const data = {
    work: { status: "completed", buildRoute: "direct" },
    activities: [
      { type: "alignment", status: "completed" },
      { type: "implementation", status: "completed" },
    ],
  };
  assert.equal(phaseState("alignment", data), "done");
  assert.equal(phaseState("implementation", data), "done");
  assert.equal(phaseState("completed", data), "done");
});

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
  });
  assert.deepEqual(understanding.confirmed, ["内部工程师"]);
  assert.deepEqual(understanding.open, ["是否需要保留旧接口？"]);
  assert.deepEqual(understanding.impact, ["src/app/App.jsx"]);
});

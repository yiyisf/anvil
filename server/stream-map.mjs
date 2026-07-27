/**
 * harness 流片段 → 前端事件
 *
 * 单独成模块是因为这段逻辑之前错得很安静：分支写的是
 *     part.type === "dynamic-tool" && part.toolName === "fileChange"
 * 而 harness 根本不发这个 type，条件永远为假，「改动文件」清单一直是空的，
 * 却没有任何报错。放在 harness.mjs 里就只能连着模型栈一起跑才能验，
 * 拆出来后可以直接喂假片段验证形状。
 *
 * ⚠️ 文件改动不是独立的一种片段：harness 把 HarnessV1StreamPart 的
 *    { type:"file-change", event, path } 翻译成一对 dynamic 工具调用
 *        { type:"tool-call",   toolName:"fileChange", input:{event,path}, dynamic:true }
 *        { type:"tool-result", toolName:"fileChange", ... }
 *    （见 @ai-sdk/harness 的 translateStreamPart）。
 *    它们的 type 以 "tool-" 开头，所以必须【排在通用工具分支之前】判断，
 *    否则会被当成一次名为 fileChange 的普通工具调用吃掉 ——
 *    既拿不到文件清单，工具列表里还会混进一堆 fileChange。
 */

/**
 * 把一个流片段翻译成 0 或 1 个前端事件。
 * @returns {{type:string}|null}
 */
export function mapStreamPart(part) {
  if (!part || typeof part.type !== "string") return null;

  if (part.type === "text-delta") {
    return part.text ? { type: "text", text: part.text } : null;
  }
  if (part.type === "reasoning-delta") {
    return part.text ? { type: "reasoning", text: part.text } : null;
  }
  // 必须在通用工具分支之前：tool-call / tool-result 都以 "tool-" 开头
  if (part.toolName === "fileChange") {
    // 一次改动会来 call 与 result 两条，只认 call，避免重复
    const path = part.type === "tool-call" ? part.input?.path : null;
    return path ? { type: "file", path } : null;
  }
  if (part.type.startsWith("tool-") && part.toolName) {
    return { type: "tool", n: part.toolName, a: shortArg(part.input) };
  }
  return null;
}

/** 工具参数取一小段用于展示 */
export function shortArg(input) {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 120);
  const v = input.path ?? input.file_path ?? input.command ?? input.pattern;
  return typeof v === "string" ? v.slice(0, 120) : JSON.stringify(input).slice(0, 120);
}

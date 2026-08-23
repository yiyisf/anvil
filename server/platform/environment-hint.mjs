/** Describes the host and command allowlist to an implementation agent. */
export function environmentHint(tools) {
  const windows = process.platform === "win32";
  return `

运行环境：
- 宿主系统：${process.platform}${windows ? "（Windows）" : ""}
- 可用命令仅限：${tools.join("、")}。其他命令一律不可用，不要尝试。
- 不要执行仓库里的脚本文件（如 ./mvnw、./gradlew、*.sh），它们不在可用命令内；
  请直接用上面列出的命令。${windows ? "\n- Windows 上没有 sh/bash 脚本执行能力，也不要用 Unix 专有命令（如 chmod、ls -la 的 GNU 选项）。" : ""}
- 路径统一用正斜杠，相对当前工作目录书写。`;
}

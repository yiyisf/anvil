/**
 * Windows 下从 where 输出里挑可执行文件的逻辑自检
 * 运行：node winpath-test.mjs
 */
import { pickWindowsBinary } from "./server/tools.mjs";

process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS";

let bad = 0;
const chk = (name, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "✔" : "✗"} ${name}\n    得到 ${got}\n    期望 ${want}`);
};

/* 1. Maven：无扩展名脚本排在 .cmd 前面（用户遇到的实际情况） */
chk(
  "mvn：跳过无扩展名脚本，选 .cmd",
  pickWindowsBinary(["D:\\mvn目录\\bin\\mvn", "D:\\mvn目录\\bin\\mvn.cmd"]),
  "D:\\mvn目录\\bin\\mvn.cmd"
);

/* 2. npm 同理 */
chk(
  "npm：选 .cmd",
  pickWindowsBinary(["C:\\nodejs\\npm", "C:\\nodejs\\npm.cmd"]),
  "C:\\nodejs\\npm.cmd"
);

/* 3. git：只有 .exe */
chk(
  "git：选 .exe",
  pickWindowsBinary(["C:\\Program Files\\Git\\cmd\\git.exe"]),
  "C:\\Program Files\\Git\\cmd\\git.exe"
);

/* 4. where 只返回无扩展名的脚本 → 尝试补扩展名 */
const fakeExists = (p) => p === "D:\\tools\\gradle.bat";
chk(
  "只有无扩展名时，补 .bat 后存在则用它",
  pickWindowsBinary(["D:\\tools\\gradle"], fakeExists),
  "D:\\tools\\gradle.bat"
);

/* 5. 都不存在时退回第一行（保持可诊断，不静默丢弃） */
chk(
  "都找不到时退回第一行",
  pickWindowsBinary(["D:\\x\\weird"], () => false),
  "D:\\x\\weird"
);

/* 6. 顺序反过来也要选对 */
chk(
  ".cmd 在前也正确",
  pickWindowsBinary(["C:\\m\\mvn.cmd", "C:\\m\\mvn"]),
  "C:\\m\\mvn.cmd"
);

console.log(bad === 0 ? "\nWindows 可执行文件选择逻辑全部通过。" : `\n${bad} 项未通过。`);
process.exit(bad ? 1 : 0);

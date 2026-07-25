import { Sandbox, ReadWriteFs } from 'just-bash';
import { registerTools } from './server/tools.mjs';
process.env.SANDBOX_TOOLS='node,git,sleep,nosuch';
process.env.TOOL_TIMEOUT_MS='2000';
const ROOT='/tmp/wdtest';
const sb = await Sandbox.create({fs:new ReadWriteFs({root:ROOT}),cwd:'/',useDefaultLayout:false});
registerTools(sb, ROOT, '/nonexistent');
const run = async (cmd) => {
  const c = await sb.runCommand({cmd:'bash',args:['-c',cmd]});
  const r = await (c.wait?c.wait():c.resultPromise);
  const o = await (typeof r.stdout==='function'?r.stdout():r.stdout);
  const e = await (typeof r.stderr==='function'?r.stderr():r.stderr);
  return `exit=${r.exitCode} | ${String(o||'').trim().slice(0,50)}${String(e||'').trim()? ' | ERR:'+String(e).trim().slice(0,70):''}`;
};
console.log("① 正常执行      :", await run('cd /REQ-1 && node -e "console.log(1+1)"'));
console.log("② 带空格的参数  :", await run('cd /REQ-1 && node -e "console.log(\'a b c\')"'));
console.log("③ 命令不存在    :", await run('cd /REQ-1 && nosuch --x'));
console.log("④ 超时终止(2s)  :", await run('cd /REQ-1 && sleep 10'));
console.log("⑤ 非零退出码    :", await run('cd /REQ-1 && node -e "process.exit(3)"'));

// 构建 narrative-prompt-polish：src → lib 直拷（无编译依赖，与 writing-pad 同构）。
import { rm, cp, mkdir, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
// preflight：build 前必过三关（语法/大小/单一 ModuleLoader.load）
import { execFileSync } from "node:child_process"
try { execFileSync("./scripts/preflight.sh", { stdio: "inherit" }) } catch (e) {
  console.error("[narrative-prompt-polish] preflight 失败, build 中断")
  process.exit(1)
}


const root = fileURLToPath(new URL("..", import.meta.url))
await rm(new URL("../lib", import.meta.url), { force: true, recursive: true })
await mkdir(new URL("../lib", import.meta.url), { recursive: true })
await cp(new URL("../src/index.js", import.meta.url), new URL("../lib/index.js", import.meta.url))
await cp(new URL("../src/client.bundle.js", import.meta.url), new URL("../lib/client.js", import.meta.url))
// 服务端子模块随行（index.js 相对导入它们）。
for (const f of ["config.js", "wire.js", "trust-fence.js", "intent.js", "polish.js", "surface-fold.js", "context-assembler.js", "trace-recorder.js", "api.js"]) {
  await cp(new URL("../src/" + f, import.meta.url), new URL("../lib/" + f, import.meta.url))
}
const copied = await readdir(new URL("../lib", import.meta.url))
console.log('built narrative-prompt-polish:', copied.sort().join(', '))
# asm.js Node.js 兼容性现状清单

> 更新时间: 2026-07-19 事实清偿(对照 CHANGELOG v1.5.16–v1.5.52 与代码现状逐项核实;审计主体仍为 2026-07-11 快照,上次全面审计 2026-04-01)。文中 v1.5.xx 标注均为重编号前的开发档案版本号(对应 CHANGELOG v1.x 条目),当前发布口径为 v0.2(2026-07-20)
> 审计范围: `runtime/node/`、`compiler/index.js`、`tests/fixtures/node/`、`tests/run_fixtures.mjs`
> 审计方法: 源码盘点 + fixture 全量运行 + 编译产物小测试(与 node 输出对照)
> 结论先行: asm.js 提供的是一组 Node 风格内建模块 shim;CJS/`node_modules` 的 **AOT 子集已落地(见下方状态更新)**,npm 真实包消费尚未验证。规划见 [ROADMAP.md](./ROADMAP.md) 方向三(N1–N5)。

> **状态更新(2026-07-16)**——**环形 `require()` 已落地**:参与 require 环的
> 本地 CJS 模块改用独立帧的惰性初始化函数(`__cjs_init_m<idx>`),首次 require 时执行,
> 体首经 `_cjs_publish` 把(部分)`module.exports` 装进 `_cjs_exports[idx]`——复刻 Node
> 「跑体前先装缓存」语义,故环内再入拿到部分初始化对象;初始化抛错被缓存(`_cjs_state=3`
> + `_cjs_error[idx]`)并在重 require 时重抛,不重跑。默认 AOT 模型把模块体内联进 `_main`
> 同帧按拓扑序顺序执行,真环无法交错(a 需 b 数据、b 又需 a)且共享帧互踩局部——故必须
> 独立帧 + 惰性执行。仅环内本地 CJS 模块走此路径,ESM / 无环 CJS 完全不变(编译器自身
> 全 ESM,自举 gen2==gen3 零影响)。`cjs/require-cycle-partial-exports`、
> `cjs/require-cycle-error-cached` 两 fixture 由此转绿(341/341)。
> **已知限制**:环内 CJS 模块若(a)顶层函数闭包捕获顶层可变量,或(b)使用 shim 注入
> (正则/JSON/eval),或(c)被 ESM `import` 而非 `require` 消费,则惰性路径尚未覆盖
> (fixture 未触及,见 `markCjsRequireCycles`/`registerCjsInitFunction` 注释)。
> - **CJS `require()` AOT 子集、`node_modules`+`package.json` `exports` 解析、ESM↔CJS 互操作、`node:` 子路径**已落地(v1.5.16;环形 `require` v1.5.47 补齐,见上)——§2/§4/§5 中相应 ❌ 行已过时。
> - **`process.env` 已接线**(v1.5.25,startup envp 解析);`process.nextTick`/全局 `setTimeout`/`setImmediate` 已可用(v1.5.16/v1.5.34)——§6 第 1/5 条已过时。
> - **`crypto.randomBytes`/`randomUUID`/`randomInt` 已为真熵源**(getentropy/getrandom,v1.5.25);`crypto.createHash` 落地(v1.5.20)——§6 第 7 条已过时。
> - **fs**:`existsSync`/`mkdirSync`/`rmdirSync` 已为真 syscall 实现(v1.5.20),`unlinkSync` 真删(2026-07-14);`child_process.execSync`/`spawnSync` 真子进程(v1.5.35);`statSync`/`readdirSync` 深度仍延后(自编译堆布局脆弱性,见 CHANGELOG v1.5.31–34 记录)。
> - **动态 `import()`(静态 specifier)**已落地(v1.5.x 初);运行时 specifier 归 L2 引擎库。
> - `path` 默认导入段错误(§6 第 4 条)、`util`/`url`/`querystring`/`assert`/`events`/`Buffer` 面已大幅补齐(v1.5.18/v1.5.28)。

状态图例: ✅ 已实现(行为接近 Node) / ⚠️ 部分实现(注明差异) / ❌ 未实现或纯占位

## 1. 总览

| 层次 | 状态 | 说明 |
|------|------|------|
| Node 风格全局对象与内建模块 shim | ⚠️ | 22 个 shim 模块 + `fs/promises`;`fs`/`path`/`process`/`console`/`timers` 子集可实用,其余多为形状占位 |
| 模块解析与 CJS/ESM 语义 | ⚠️ | ESM 本地导入与 bare→shim 映射(含 `node:` 前缀)可用;CJS `require()` AOT 子集、ESM↔CJS 互操作已落地(v1.5.16,环形 require v1.5.47),动态 `import()` 静态 specifier 可用(运行时 specifier 归 L2 引擎库) |
| `node_modules` / `package.json` / npm 包生态 | ⚠️ | 逐级向上查找 + `main`/`module`/`type`/`exports` 解析已落地(v1.5.16);npm 真实包消费未验证(N4);未命中解析的未知 bare import 仍静默退化为 `0` |

## 2. 实证依据(2026-07-11)

### 2.1 fixture 全量运行

`node tests/run_fixtures.mjs` → **PASS=65 FAIL=49 TOTAL=114**,其中 node 域 29 项 FAIL 的分布:

| fixture 组 | FAIL | 实证结论 |
|------------|------|----------|
| `tests/fixtures/node/packages/*` | 9/9 | 无 `node_modules` 解析;`package.json` `main`/`module`/`type`/`exports`(root/subpath/conditional/wildcard)全部不生效 |
| `tests/fixtures/node/cjs/*` | 9/9 | `require()` 无语义:`require("fs")` 得 `number`,本地 require 得 `0`,无模块缓存/循环依赖 |
| `tests/fixtures/node/interop/*` | 4/4 | ESM↔CJS 桥接缺失,其中 2 例直接 FATAL(`_object_set called with NULL object`) |
| `tests/fixtures/node/builtin-node-scheme-*` | 6/17 | `node:` 前缀基本可用(timers/os 全绿),但 `fs/promises`、`process.env`、`process.versions`、`util.types` 尚 FAIL |
| `tests/fixtures/modules/dynamic-import-*` | 8/8 | 动态 `import()` 一律 COMPILE_FAIL |

> **2026-07-19 注**:上表为 2026-07-11 审计快照。五组 FAIL 现已全部转绿——packages/cjs/interop 于 v1.5.16 落地,环形 require 两 fixture 于 v1.5.47 补齐(套件首次全绿 351/351),dynamic-import 组落地见顶部状态更新;当前套件 362/362(v0.2,2026-07-20)。

### 2.2 编译产物小测试(`node cli.js <file> -o <bin>`,macos-arm64)

| 测试 | 结果 |
|------|------|
| `fs.writeFileSync` + `readFileSync` + `existsSync` | ✅ 与 node 输出一致 |
| `import { join, dirname, ... } from "path"`(具名) | ✅ 与 node 一致 |
| `import path from "path"`(默认导入)后调方法 | ✅ 已修(2026-07-14):三因叠加——① `path.join` 与数组 join 同名被方法派发劫持当数组读;② 类静态方法不在 `_object_get` 可见的 props;③ class static `(...args){f(...args)}` rest+spread 产坏值。修:join 加运行时 tag 派发(数组→数组 join,非数组→用户方法;≥2 参/已知类落通用路径),path 默认导出改普通对象(属性=具名函数闭包)。`path.join/dirname/resolve` 全形态对齐 node |
| `path.join(..,'../x')` 归一化 | ✅ 已修(2026-07-14):结果含 `.`/`..` 段时走 normalize(普通路径保持逐字节旧输出以护自举定点) |
| `fs.unlinkSync` 实删 | ✅ 已修(2026-07-14):此前 no-op,现走 unlink/unlinkat(linux-arm64) 系统调用真删 |
| `fs.existsSync` 对不存在文件 | ✅ 已修(v1.5.20):`__syscall` macOS carry-flag 错误约定修正后,open 失败正确判 false(CHANGELOG v1.5.20:"unlocked fs.existsSync/mkdirSync/rmdirSync")。此前"恒 true 已被自举定点固化、修正会破 gen2==gen3"的担心已由该版本在自举门下消化 |
| `import { readFileSync } from "node:fs"` / `node:path` | ✅ 正常 |
| `process.platform` / `argv` / `cwd()` | ✅ 正常 |
| `process.env.HOME` / `process.env.PATH` | ✅ 已修(v1.5.25):启动时解析 POSIX envp 填入 `process.env`(fixture `builtin-node-scheme-process-env`) |
| `import { setTimeout, setImmediate } from "timers"` | ✅ 顺序正确(sync→immediate→timeout) |
| 全局 `setTimeout`(不 import) | ✅ 已修(v1.5.34):编译器内建识别全局 `setTimeout`/`setImmediate`/`clearTimeout`/`clearImmediate`(fixture `global-timers`) |
| `process.nextTick`(不 import process) | ✅ 已修(v1.5.16):原生全局 `process` 对象启动时注入(`runtime/core/process.js`,含 `nextTick`/`version`/`versions`/`env`),裸用可用;经 `node:process` 导入亦绿(fixture `builtin-node-scheme-process`) |
| `const fs = require("fs")` | ✅ 已修(v1.5.16 CJS AOT 子集;v1.5.35 修编译产物内 `require(builtin)` 导出形态误判):内建返回可用形态(fixture `cjs/require-builtin-fs`) |
| `import x from "leftpad"`(未知 bare 包) | ❌ 仍真实(2026-07-19 核):`resolveModulePath` 对未命中 node_modules 解析的 bare specifier 返回空串,导入被静默跳过,绑定仍退化为 `0`(E2 收口范围) |

## 3. 内建模块 shim 逐 API 状态

现有 `runtime/node/` 下 22 个 shim 模块 + `fs/` 子目录 + 编译器注入的 `__json_shim.js`(共约 2000 行)。

### 3.1 fs(`runtime/node/fs.js`,373 行,五目标 syscall 直连)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `readFileSync` | ⚠️ | 分块读任意大小文件;恒返回字符串(encoding 参数忽略,无 Buffer 返回);失败返回 `""` 而非抛 ENOENT |
| `writeFileSync` | ⚠️ | 支持 string/Buffer/字节数组;失败静默返回 |
| `appendFileSync` | ✅ | v1.5.43 修:此前用 `O_APPEND` 打开——但本文件 `O_*` 常量是 Linux 数值,macOS 上 Linux `O_APPEND`(0x400)恰与 macOS `O_TRUNC`(0x400)撞号 → 追加变截断覆盖。改为可移植的"读现有 + 拼接 + `writeFileSync`"(追加只增长,不触 `writeFileSync` 的截断缺陷);非自举热路径,不影响不动点。fixture `builtin-fs-streams` |
| `existsSync` | ✅ | open+close 探测,win32 走 `__winfs_*` |
| `chmodSync` | ✅ | win32 为空操作(无 POSIX 权限位) |
| `copyFileSync` | ⚠️ | read+write 组合,走字符串路径 |
| `openSync` / `closeSync` / `readSync` / `writeSync` | ⚠️ | syscall 直连;`offset`/`position` 参数忽略 |
| `accessSync` | ⚠️ | 基于 existsSync;失败返回 `-1` 而非抛错 |
| `unlinkSync` | ✅ | 真删(2026-07-14):unlink/unlinkat(linux-arm64 AT_FDCWD)系统调用;win32 无桥接仍 no-op |
| `mkdirSync` | ✅ | v1.5.20 真 syscall(mkdir/mkdirat),支持 `{recursive:true}` 逐级创建;win32 no-op。fixture `builtin-fs-mkdir-roundtrip` |
| `rmdirSync` | ✅ | v1.5.20 真 syscall(rmdir/unlinkat AT_REMOVEDIR);win32 no-op |
| `readdirSync` | ❌ | 恒返回 `[]` |
| `statSync` / `lstatSync` | ❌ | 假 `Stats`(size=0,`isFile()` 恒 true,`isDirectory()` 恒 false) |
| `createWriteStream` | ⚠️ | v1.5.43:真实 EventEmitter 式流(轻量 plain-object,非 `class`——避免把 stream 类拉进编译器模块图),`write`/`end`(带 cb)、`'finish'`/`'close'`/`'drain'`,数据经 `appendFileSync` 落盘;非追加模式打开先 `unlinkSync` 保证干净起始(绕 `writeFileSync` 不截断缺陷)。fixture `builtin-fs-streams` |
| `createReadStream` | ⚠️ | v1.5.43:真实流,`'data'`/`'end'`/`'close'`/`'error'`、`pipe()`、`encoding`/`highWaterMark`(分块交付)。经事件循环(queueMicrotask)异步交付整文件或按 hwm 分块。fixture `builtin-fs-streams` |
| 异步回调族(`readFile`/`writeFile`/`stat`/…) | ❌ | 不存在 |
| `watch` / `watchFile` / `Dirent`/`Dir` 遍历 | ❌ | `Dirent`/`Dir` 有类型形状,无真实数据源 |

### 3.2 fs/promises(`runtime/node/fs/promises.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `readFile` / `writeFile` / `appendFile` / `access` | ⚠️ | sync 版的 `Promise.resolve` 包装,限制同 3.1 |
| `mkdir` / `unlink` | ⚠️ | 包装的底层 sync 版已为真 syscall(v1.5.20 / 2026-07-14) |
| `readdir` / `stat` / `lstat` | ❌ | 包装的底层 sync 版仍为假值(见 3.1) |
| 经 `node:fs/promises` 导入 | ✅ | v1.5.16 `node:` 子路径解析落地,fixture `builtin-node-scheme-fs-promises` 已转绿(另有 `builtin-fs-promises-breadth`) |

### 3.3 path(`runtime/node/path.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `dirname` / `basename` / `extname` | ✅ | 实测与 node 一致 |
| `join` | ⚠️ | 具名导出版最多 5 段;结果含 `.`/`..` 段时走 normalize 折叠(2026-07-14,见 §2.2) |
| `normalize` / `relative` / `isAbsolute` | ✅ | 基础语义正确 |
| `resolve` | ⚠️ | 简化版:不基于 `cwd()`,首参相对路径时与 node 语义不同 |
| `sep` / `delimiter` | ⚠️ | 默认导出对象上已是字符串属性(v1.5.18);`sep` 全平台统一 `"/"`(win32 也用正斜杠,自举纪律所需) |
| `format` / `parse` | ⚠️ | 简化实现(root 判断仅看前导 `/`) |
| `posix` / `win32` 命名空间 | ❌ | 不存在 |
| **`import path from "path"` 默认导入** | ✅ | 已修(2026-07-14,三因叠加详见 §2.2):默认导出改普通对象(属性=具名函数闭包),`path.join/dirname/resolve` 全形态对齐 node |

### 3.4 process(`runtime/node/process.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `platform` / `arch` | ✅ | 来自 `__get_process()`,随编译目标 |
| `argv` / `argv0` / `execPath` | ✅ | 真实命令行参数 |
| `cwd()` / `chdir()` | ✅ | 委托运行时 |
| **`env`** | ✅ | v1.5.25 已接线:启动时解析 POSIX envp 填 `KEY=VALUE`(GC-safe),`process.env.X` 可读宿主变量;fixture `builtin-node-scheme-process-env` 转绿。win32 合成 argv 无连续 envp,env 保持空对象(见 `runtime/core/process.js`) |
| `exit(code)` | ✅ | syscall,退出码正确 |
| `pid` / `uid` / `gid` | ✅ | syscall 直取 |
| `ppid` / `euid` / `egid` | ❌ | 恒 `0` |
| `stdout.write` / `stderr.write` | ✅ | fd 1/2 直写 |
| `stdin` | ❌ | 占位(`read()` 恒 null) |
| `nextTick` | ✅ | 原生全局 `process` 对象启动时注入(v1.5.16,`runtime/core/process.js`),裸 `process.nextTick(cb)` 可用;经 `node:process` 导入 fixture `builtin-node-scheme-process` 绿。shim 内另保留 `__asmjsNextTick` 委托声明 |
| `version` / `versions` | ⚠️ | 编译产物内取自原生注入对象:`"v20.0.0"` / {node 20.0.0, v8 11.3.0, uv 1.0.0, modules 108, napi 8}(`runtime/core/process.js`),fixture `builtin-node-scheme-process-versions` 绿。**硬编码不一致仍在**:本 shim 文件写死 `"v18.0.0"`/{node 18.0.0, v8 10.2.0},与原生注入的 v20.0.0 及 `index.js` 汇总的 20.0.0 均不一致——三处(version 原生 20.0.0 / shim 18.0.0 / 汇总 20.0.0)未对齐,且全部为硬编码 |
| `hrtime` / `uptime` | ⚠️ | `Date.now()` 换算,非单调时钟 |
| `memoryUsage` / `cpuUsage` / `resourceUsage` | ❌ | 恒全零 |
| 事件族(`on`/`once`/`emit`/`listeners`/…) | ❌ | 占位(返回 this/空数组/false) |
| `binding` / `_linkedBinding` | ❌ | 显式抛错(符合"不静默"原则) |
| `exitCode` / `umask` / `kill` | ⚠️ | exitCode 可读写但不影响退出码;umask 恒 022;kill 空操作 |

### 3.5 console(`runtime/node/console.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `log` / `info` / `debug` | ✅ | fd1 直写 |
| `error` / `warn` | ✅ | fd2 直写 |
| `trace` | ⚠️ | 输出到 fd2,无栈回溯 |
| `time` / `timeEnd` / `timeLog` / `count` / `countReset` / `group` / `groupEnd` / `assert` / `clear` | ⚠️ | 存在,简化实现 |
| `dir` / `dirxml` / `table` | ⚠️ | 一律 `JSON.stringify` 后打印 |
| `profile` / `profileEnd` | ❌ | 空操作 |

### 3.6 os(`runtime/node/os.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `platform()` / `arch()` / `type()` | ✅ | v1.5.28 起经 `__get_process()` 随编译目标派生;`platform()` 映射 Node 名(macos→"darwin"),`type()` 给 Linux/Windows_NT/Darwin |
| `homedir()` | ❌ | 硬编码 `"/Users/user"` |
| `tmpdir()` | ⚠️ | 硬编码 `"/tmp"`(POSIX 上可用,win32 错误) |
| `hostname` / `release` / `uptime` / `loadavg` / `totalmem` / `freemem` / `cpus` | ❌ | 全部硬编码假值 |
| `endianness()` | ✅ | `"LE"`(五目标均小端) |
| `EOL` | ✅ | 字符串属性 `"\n"`(§3.6 旧注已过时) |
| `userInfo()` / `networkInterfaces()` / `machine()` / `version()` / `availableParallelism()` | ⚠️ | v1.5.39 补齐形状:`userInfo` 返回 `{uid,gid,username,homedir,shell}`(占位用户名),`networkInterfaces` 给回环 lo0(IPv4+IPv6),`availableParallelism` = `cpus().length`。fixture `builtin-os-userinfo-netif` |

### 3.7 timers(`runtime/node/timers.js`,经 `__asmjs_*` 事件循环桥接)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `setTimeout` / `clearTimeout` | ⚠️ | 真实回调调度(退出前 `_ev_run` drain),`node:timers` fixture 组全绿;**delay 参数忽略**(不按时间排序) |
| `setImmediate` / `clearImmediate` | ✅ | 事件循环桥接,与 setTimeout 的相对顺序正确 |
| `setInterval` / `clearInterval` | ⚠️ | v1.5.43:interval 建模为回调经 `setImmediate` 自我重排,`clearInterval(handle)` 置取消位;"setInterval + N 次后 clearInterval" 模式正确终止(fixture `builtin-timers-interval`)。**限制**:无真实定时(period 忽略、tick 间无延时);永不 clear 的 interval 会无限重排,进程到不了 drain-退出(近似 Node "运行至 clear" 语义) |
| 全局裸用(不 import) | ✅ | v1.5.34:编译器内建识别全局 `setTimeout`/`setImmediate`/`clearTimeout`/`clearImmediate`,回调经事件循环真实触发(fixture `global-timers`) |

### 3.8 events(`runtime/node/events.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `EventEmitter` `on`/`once`/`addListener`/`removeListener`/`removeAllListeners`/`emit`/`listeners`/`rawListeners`/`listenerCount`/`eventNames`/`set|getMaxListeners`/`prependListener`/`off` | ✅ | 同步派发;`emit` 遍历快照(once 派发中移除自身不漏后继) |
| `prependOnceListener`、无监听器 `emit('error')` 抛出、`removeListener` 经 once 包装器按原始 listener 匹配 | ✅ | v1.5.39 补齐(fixture `builtin-events-once-prepend-error`) |
| `events.once(emitter,name)`(→ Promise)、`events.getEventListeners`、`events.setMaxListeners`、`EventEmitter.once`/`errorMonitor`/`captureRejectionSymbol` | ⚠️ | `once()` 仅在事件**同步**触发时可解析;在 `setTimeout` 回调中触发因事件循环微任务未在计时器回调后排空而不解析(编译器/事件循环缺陷,非 shim) |

### 3.9 buffer(`runtime/node/buffer.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `Buffer.from` / `alloc` / `isBuffer` / `isEncoding` / `concat` | ⚠️ | 基于 JS 数组(`.data`)的近似实现,非 TypedArray 视图 |
| `write` / `toString` / `equals` / `copy` / `fill` / `slice` / `subarray` / `compare` | ⚠️ | 存在,编码支持有限(utf8 近似) |
| 定长 `readUInt8/16/32`/`writeUInt8/16/32`(LE/BE)+ 有符号族 | ✅ | 位运算实现 |
| v1.5.39 补:`toJSON()`、`base64url` 编解码、变长 `readUIntLE/BE`+`writeUIntLE/BE`+`readIntLE/BE`+`writeIntLE/BE`(byteLength 1..6,算术实现避 32 位溢出)、`values()/keys()/entries()` 迭代器 | ✅ | fixture `builtin-buffer-varint-json` |
| `indexOf` / `lastIndexOf` / `includes` / 数字下标 `buf[i]` | ❌ | **编译器缺陷**:`.indexOf()` 调用被内建数组派发遮蔽(即使挂实例属性也被 CALL 层拦截,返回错值),单/多字节搜索均不可用;`buf[i]` 恒 undefined(字节存 `.data` 非对象下标)。均需 codegen 修复 |

### 3.10 child_process(`runtime/node/child_process.js`)

| API | 状态 | 差异说明 |
|-----|------|----------|
| `spawnSync(cmd, args, {stdio:"inherit"})` | ⚠️ | **execve 就地替换当前进程**(macOS fork/posix_spawn 在 `__syscall` 约束下不可行):输出直达终端、退出码正确,但调用方后续代码不执行;**传给子进程的 envp 为空** |
| `spawnSync`(非 inherit) | ✅ | 真子进程(fork + 临时文件捕获 stdout/stderr + wait4);`{status, signal, stdout, stderr, output}`,args 各自独立(无 shell 重拆分),`encoding` 决定串/Buffer |
| `execSync` | ✅ | 真 `/bin/sh -c cmd`;非零退出抛错附 `.status`/`.signal`/`.stdout`/`.stderr`(fixture `child-process-exec-sync`) |
| `spawn` / `exec` / `execFile` / `execFileSync` | ⚠️ | v1.5.43:真实运行 + **异步流式接口**——子进程实为同步 fork+wait 运行,随后 stdout/stderr 作为轻量 Readable(`'data'`/`'end'`/`'close'`/`pipe()`,交付解码后的字符串)在微任务里回放,`'exit'`/`'close'`(带 code/signal)在输出之后触发(次序同 Node);`exec`/`execFile` 的 callback 得字符串 stdout/stderr + 非零退出的非空 error。fixture `builtin-child-process-spawn`。**限制**:同步运行故 `child.stdin.write` 为空操作(无法向已结束进程喂输入);异步 error 的 `.code`(位运算得的整数跨微任务边界)偶发拼接为空(codegen 装箱边角,见 §3.14 附注),`err` 真伪判定正确 |

### 3.11 其余 shim(形状占位为主)

| 模块 | 状态 | 说明 |
|------|------|------|
| `url` | ⚠️ | `URLSearchParams` 完整;`URL` 支持相对引用相对 base 解析 + RFC3986 点段归一(v1.5.39);`pathToFileURL`/`fileURLToPath` 可用。fixture `builtin-url-resolve`。仍缺:百分号编码归一、IDNA、`url.format`/legacy `url.parse` |
| `util` | ⚠️ | `format`/`inspect` 简版(v1.5.39:`inspect` 支持 Map/Set 带 size+嵌套、Date→ISO、`[Function: name]`;fixture `builtin-util-inspect-map-set`);`inherits`/`deprecate`/`promisify`/`callbackify` 近似;`types.*` 与 `is*` 族大量恒 `false`(`isPromise` 例外)。已知编译器缺陷:传入 `_inspect` 的函数值 `.name` 为 undefined(参数反射丢失),故对象内函数值显示 `[Function (anonymous)]` |
| `crypto` | ⚠️ | `randomBytes`/`randomInt`/`randomUUID`/`randomFillSync` 用内核熵源(getentropy/getrandom,v1.5.25);**`createHash` 的 sha256/sha512/sha384/sha1/md5 为真实算法**(sha256/1/md5 纯 32 位整数,v1.5.39;**sha512/sha384 用 [hi,lo] 双 32 位分量做 64 位运算**,无原生 64 位整数、无宽乘,`>>> 0` 约减 + 比较进位,v1.5.51,fixture `builtin-crypto-hash-real`/`builtin-crypto-sha512`),`createHmac`(sha256/sha512/sha384/sha1/md5)真实 RFC2104——**块长按算法取(sha512/384=128,其余=64)且全程走字节数组**(中间摘要含 NUL 时字符串拼接会被 asm.js 内嵌 NUL 截断算错,故与 PBKDF2 共用字节实现 `_hmacRaw`);**`createCipheriv`/`createDecipheriv` 支持 aes-128/192/256 的 cbc/ctr/gcm 三模式**(纯字节 AES 块;CBC + PKCS#7 填充,`setAutoPadding` 可关;CTR 计数器密钥流无填充;GCM 为 AEAD——CTR 加密 + GHASH 认证,`setAAD`/`getAuthTag`/`setAuthTag`,GHASH 在 GF(2^128) 逐位约减顶字节 0xe1,12 字节 IV 走 J0=IV‖0³‖01 快路、其余长度走 GHASH,解密时 tag 不符抛认证错;GF(2^8)/GF(2^128) 均用位移-异或农夫乘法,无宽整数乘;v1.5.49 CBC、v1.5.51 CTR+GCM,fixture `builtin-crypto-cipher`/`builtin-crypto-cipher-modes`,加解密 + auth tag + Node 互操作逐字节一致);**`pbkdf2Sync`/`pbkdf2` 为真实 HMAC-based PBKDF2**(RFC 2898,sha1/sha256/md5,全字节运算,与 Node 逐字节一致);**`hkdfSync` 为真实 HKDF**(RFC 5869,Extract+Expand over HMAC-sha256/512/384/1/md5,全字节运算,RFC A.1/A.3 向量 + Node 逐字节一致,v1.5.51,fixture `builtin-crypto-hkdf`;返回 Buffer,Node 返 ArrayBuffer,`Buffer.from(result)` 两端通用);sha224 仍为确定性占位;ECDH/`scryptSync` 占位。已知:(a) cipher 的 `.update()` 缓冲全量、`.final()` 一次性成块,故须用字符串编码链式(`c.update(x,'utf8','hex')+c.final('hex')`)或直接消费 `.final()` 返回的 Buffer——`Buffer.concat([update,final])` 此前因 asm.js `Buffer.concat` 名撞派发(数组方法劫持)返错值——该编译器车道问题 v1.5.51 已修(CHANGELOG:"Buffer.concat no longer mis-dispatches to String.concat");(b) `createHmac` 的字符串累积路径遇内嵌 NUL 字节会截断(ASCII 输入不受影响),故 PBKDF2 内部改走独立的全字节 HMAC(`_hmacRaw`)绕过;HMAC 密钥 > 64 字节的分支在大程序里受布局相关 miscompile 影响偶发错值(算法本身已验证正确);(c) **`pbkdf2`/`hkdf` 的异步回调形式不触发**——根因是编译器车道 bug:6 参数的对象字面量方法把第 6 个实参(callback)错传为 `object` 而非 `function`(独立 6 参函数正常、对象方法 3 参正常,仅对象方法 arity≥6 的末参失真),故守卫 `typeof cb==='function'` 落空静默丢弃;**改用 `pbkdf2Sync`/`hkdfSync` 同步形式**(逐字节正确),异步待编译器修 call-ABI 后自动可用 |
| `stream` | ⚠️ | **真实数据流动**(v1.5.43):`Readable`(custom `_read`、flowing/paused、`push`/`unshift`/`read`、`'data'`/`'end'`/`'readable'`、`pause`/`resume`、`pipe` 带背压、`Readable.from(array/iterator/asyncIterable)`)、`Writable`(`write`/`end`、缓冲 + `'drain'`/`'finish'`、`cork`/`uncork`、`highWaterMark` 背压)、`Duplex`/`Transform`(`_transform`/`_flush`)/`PassThrough`、`pipeline()`、`finished()`、objectMode 均可用(fixtures `builtin-stream-readable-pipe`/`-transform-pipeline`/`-duplex-objectmode`)。异步迭代 `for await (chunk of stream)` **不支持**(见 §3.14 codegen 缺陷 C3)。实现纪律:`Duplex`/`Transform` 经组合(`extends EventEmitter` + 内嵌 `Readable`)而非 `extends Readable`,`end` 经原型赋值——均为绕过 codegen 缺陷(§3.14) |
| `net` | ✅ | **真实事件驱动异步 TCP**(v1.5.47,R4 升级;底座为 R3 的 socket/bind/listen/accept/connect/read/write/close/getsockname/setsockopt 裸系统调用,三平台号已入 constants.js)。**异步就绪(R4 新)**:`socket.on('data')`/`server.on('connection')`/`socket.on('end'\|'close')` **自行触发**——用 `poll(2)`(linux-arm64 用 `ppoll`,macOS/linux-x64/号已入 constants.js)驱动的就绪泵。**不改 `_ev_run` 汇编**:泵是纯 JS,骑现有 `setImmediate` 队列——只要有已注册 fd 就用 `setImmediate` 自我重排一个"poll tick",每 tick 阻塞在 `poll` 上直到某 fd 可读,派发 JS 回调后再自排;末个 fd 注销后 tick 不再自排、事件循环自然终止。可用:`createServer`/`server.listen(port|0[,host])`(经 `getsockname` 支持临时端口)+ 异步 `'connection'`/`server.accept()`(同步版保留)/`server.close`/`server.address`;`net.connect`/`createConnection`/`Socket.connect`(真 `socket()`+`connect()`),`write`,异步 `'data'`(附 `'data'`/`'end'` 监听即进 flowing 模式启动读泵,Node 语义)与同步阻塞 `read([size])→Buffer|string`(R3 API 保留)并存,`end()`(异步 socket 半关 `shutdown(SHUT_WR)` 发 FIN 但保留读侧收对端回复;同步 socket 仍全关)/`destroy`/`pause`/`resume`/`setEncoding`;`isIP`/`isIPv4`/`isIPv6` 真值。单进程 loopback 全异步跑通(fixtures `builtin-net-tcp-loopback` 同步 + `builtin-net-async-echo` 异步双向)。**双向 Node 互操作已验证**(R3):asm.js↔Node 双向通。**实现纪律**:`Buffer` 别名导入(裸 `new Buffer` 被 builtin 拦截);sockaddr_in 平台差异(macOS 有 `sin_len` 字节、Linux `sin_family` 为 2 字节 LE);读泵 pollfd 结构经 `__alloc`/`__setChar`/`__getChar` 手搓(fd@0 int32 / events@4 int16 / revents@6 int16);安全网:纯超时空转 30 次(≈30s)后清空 watcher 防卡死(loopback 永不触发)。**仍缺**:定时器与 socket 混用时 setImmediate 抢占 setTimeout(`_ev_run` 既有优先级);POLLOUT/`'drain'` 背压(写恒同步成功,暂不需);把 poll 直接织入 `_ev_run` 汇编(当前 JS 泵已足,列为后续优化) |
| `http` | ⚠️ | **最小但真实的 HTTP/1.1**(v1.5.47,R4;构建于 `net` 异步就绪层之上,不新增事件循环基建)。**服务端**:`http.createServer((req,res)=>…)` / `server.listen(port|0[,host][,cb])` / `server.close` / `server.address`;`req` 为 `IncomingMessage`(`method`/`url`/`headers` 小写键 / `'data'`/`'end'`);`res` 为 `ServerResponse`(`writeHead`/`setHeader`/`getHeader`/`write`/`end`,缺省补 `Content-Length` 与 `Connection: close`)。**客户端**:`http.request(opts[,cb])` / `http.get(opts|urlString[,cb])` → `ClientRequest`;`'response'` 回 `IncomingMessage`(`statusCode`/`headers`/`'data'`/`'end'`)。**帧**:请求行 + 头 以 CRLFCRLF 收尾,体长取 `Content-Length`;缺省响应走 `Connection: close`,以 socket EOF 标记体结束。**chunked 传输编码(双向,v1.5.47 R5)**:`res.write()` 无 `Content-Length` 时自动 `Transfer-Encoding: chunked` 逐块发(`<hex>\r\n<data>\r\n` … `0\r\n\r\n`),`res.end` 补终止块;客户端设 `Transfer-Encoding: chunked` 后 `req.write()` 逐块编码;服务端与客户端均解码 chunked 体(累积到终止块再发一次解码后的 `'data'`)。客户端响应完成判定支持 `Content-Length` / chunked 终止块 / EOF 三态。**keep-alive 连接池化(v1.5.49 R6,已接线)**:`new http.Agent({ keepAlive:true })` **跨请求复用同一 TCP 连接**——响应完成时把 socket 停读(移出 poll 泵 watcher)并按 `host:port` 停进 `freeSockets` 空闲池,下一发往同名的请求从池里取回(经 fd 恒等 + Agent `reused`/`created` 计数验证:三连发复用同一 fd,`reused=2 created=1`)。**关键退出语义**:空闲池化 socket 已 `_stopRead()`(无 watcher),故绝不保活事件循环;进程仍干净退出(fd 由 OS 退出时关,或 `agent.destroy()` 主动关)。**per-request 监听器重置**:复用前清掉 socket 上一请求的 `'data'`/`'end'`/`'error'`/`'close'` 监听,旧解析器不会重触发。**池化时序**:socket 的入池/关闭在发出 `'end'` **之前**完成——用户 `'end'` 回调常同步发下一请求,先入池才能让它取回复用(否则池空、退化为新拨号)。`ClientRequest` 解析 `options.agent`(缺省 `globalAgent`,其 `keepAlive=false` → `Connection: close`、退出语义不变;`agent:false` 完全不池化);`_keepAlive` = 请求头 keep-alive 或 Agent 为 keep-alive。`Agent` 有 `maxSockets`/`maxFreeSockets`/`sockets`/`freeSockets`/`_acquire`/`_release`/`_track`/`destroy`。**服务端**支持一条连接上顺序多请求(`resetForNext` 复用)与**多并发独立连接**。fixtures:`builtin-http-loopback`(Content-Length POST 收发)、`builtin-http-chunked`(双向 chunked)、`builtin-http-keepalive`(池化复用同一 fd + 3000 字节大体 + 并发 `Connection: close` 连接 + 干净退出)。**编译器缺陷绕过(均已开 issue 给 ES 车道)**:(1) 顶层定义名全局共享——`Server`/`createServer` 与 net.js 同名会串类,故内部改名 `HttpServer`/`httpCreateServer`,公开名仅在 export 子句还原;(2) 具名 `export { … }` 列表尾逗号令解析器崩(`expected }, got ;`);(3) 类方法里同时捕获 `this`/`self` 时,兄弟闭包对被捕获 `let` 标量的写不互见——改用捕获对象 `const st={…}` 的属性存共享解析状态;(4) `String.split` 只认多字符分隔符的首字符,`split("\r\n")` 会漏 `\n`——改 `split("\n")` 再剥尾 `\r`(`indexOf` 多字符正常)。**仍缺**:`https`/TLS、POLLOUT/`'drain'` 写背压(net.js `write` 目前阻塞式全写)、`keepAliveMsecs` 空闲计时器主动关闭(当前靠停读 + OS 退出关,已足够不卡退出)、`maxSockets` 达上限时的请求排队(当前池空即新拨号)、`http.Server` 直继承 `net.Server` |
| `dns` | ❌ | 形状占位(无解析器) |
| `tty` | ⚠️ | `WriteStream.write` 可写 fd;`isatty` 简化 |
| `zlib` | ✅ | **真实 DEFLATE/INFLATE**(v1.5.45,纯 32 位整数,无 syscall)。解码器:stored/固定/**动态 Huffman**(canonical `counts[]`+`symbols[]` 解码,LZ77 反向引用窗口)——可读回 Node 参考 zlib 产出的动态 Huffman 流。编码器:LZ77(15-bit 哈希链,chain=128)+ 固定 Huffman 单块,产出真实压缩(实测 528B→62B)。容器:gzip(RFC1952,10B 头 + CRC32 + ISIZE)、zlib(RFC1950,`78 9c` 头 + Adler-32)、raw。API:`deflateSync`/`inflateSync`/`deflateRawSync`/`inflateRawSync`/`gzipSync`/`gunzipSync`/`unzipSync`(容器自判)、`crc32`(含 seed 形式)、回调式 `deflate`/`gzip`/… 同步执行后回调。**双向 Node 互操作已验证**:asm.js gzip/zlib 被 Node inflate 读回 ✓;Node gzip/zlib/raw/stored 被 asm.js 读回 ✓(fixtures `builtin-zlib-roundtrip`/`builtin-zlib-node-interop`)。**流式类(v1.5.49 R6,已实现)**:`createGzip`/`createGunzip`/`createDeflate`/`createInflate`/`createDeflateRaw`/`createInflateRaw`/`createUnzip` 返回真实的 Transform 风格流(`ZlibStream extends EventEmitter`)——`write()` 缓冲输入、`end()` 一次性跑同步编解码并把整块结果作为单个 `'data'` chunk 发出、随后 `'end'`/`'finish'`/`'close'`(全同步,无需事件循环);支持多次 `write()`、`pipe(dest)`(把输出转发进可写端并在结束时 `end()` 它)、`flush`/`destroy`。导出 `Gzip`/`Gunzip`/`Deflate`/… 构造器别名。单 chunk 交付规避了 `Buffer.concat` 的数组方法名撞派发问题。fixture `builtin-zlib-streaming`(gzip/deflate 流式往返 + 多写 + pipe 进 sink 验证)。**实现纪律**:`Buffer` 必须别名导入(`import { Buffer as _Buf }`)——裸 `new Buffer(...)` 被编译器 builtin 拦截返回无 `.data` 的对象;fixture 里比对字节须用 `.data[i]`(asm.js Buffer 不支持数值下标 `buf[i]`)。仍缺:brotli(占位)、增量流式(当前 `end()` 一次成块,非按 chunk 增量压缩)、DEFLATE 动态 Huffman 编码(用固定表,压缩率略低于 Node) |
| `vm` | ❌ | 占位 |
| `string_decoder` | ⚠️ | `write`/`end` 可用(v1.5.39,fixture `builtin-string-decoder`);`write` 直接 `toString`,无多字节边界处理。**编译器缺陷绕过**:类原型方法名 `end` 被误派发(返回 ""/令 main 无限重执),故 `write`/`end` 改为构造函数内的实例属性闭包 |
| `assert` | ⚠️ | `ok`/`equal`/`strictEqual`/`deepStrictEqual` 族 + `throws`/`doesNotThrow`;v1.5.39 补:断言错误 `code="ERR_ASSERTION"`、`match`/`doesNotMatch`、`ifError`、`throws(fn, /re/|Ctor|obj)`、`assert.strict` 命名空间(fixture `builtin-assert-match-code`)。**编译器缺陷绕过**:对作为函数参数传入的正则调用 `.test` 会崩,故经 `new RegExp(re.source, re.flags)` 重建本地正则再匹配。缺 `rejects`/`doesNotReject`(async) |
| `constants` / `_string` | — | 内部支撑(五目标 syscall 表 / JS↔C 字符串),非 Node 公开 API |

### 3.12 __json_shim.js(编译器注入的内建 shim,机制首铺)

| 项 | 状态 | 说明 |
|-----|------|------|
| 注入机制 | ✅ | `compiler/index.js`(~919 行)检测模块源码引用 `JSON.stringify`/`JSON.parse` 时自动前置 `import { __JSON_stringify, __JSON_parse } from "__json_shim"` 并改派调用点;裸名经 `runtime/node/` 解析(与 fs/path 同机制)——这是"编译器注入内建 shim"机制的第一个落地,后续内建可复用 |
| `JSON.stringify` 覆盖 | ⚠️ | 标量/串转义(含 `\uXXXX`)/数组/嵌套对象;`undefined`/函数按规范处理 |
| `JSON.stringify` 未覆盖 | ❌ | `replacer`/`space` 参数、`toJSON` 协议、循环引用检测(深度 200 兜底防炸栈) |
| `JSON.parse` | ⚠️ | 纯算术数字解析(gen1-safe 纪律),无 reviver |

### 3.13 完全缺失的核心模块

`https`、`module`、`readline`(及 promises)、`worker_threads`、`perf_hooks`、`async_hooks`、`tls`、`cluster`、`repl`、`inspector` —— 均无 shim 文件,bare import 会静默退化(见 6)。(`assert`/`querystring`/`http`/`dgram` 已有 shim,见上/下表。)

**`dgram`(v1.5.47 R5,最小真实 UDP/IPv4)**:`dgram.createSocket("udp4")` → `Socket`;`bind(port|0[,address][,cb])`(端口 0 取临时端口,经 `getsockname`)、`send(msg[,offset,length],port[,address][,cb])`、`'message'` 事件回 `(Buffer, rinfo{address,family,port,size})`、`address()`、`close()`。构建于 net 的**同一** poll(2) 就绪泵与 IPv4 sockaddr 编码之上(单事件循环)。**实现要点**:`sendto`/`recvfrom` 需 6 个系统调用参数,超过 asm.js `__syscall` 的 5 参上限,故改用 **`sendmsg`/`recvmsg`(3 参:fd/&msghdr/flags)** + 手搭 `struct msghdr`(56B 清零布局 name@0/namelen@8/iov@16/iovlen@24/…,macOS BSD 已验证、Linux LP64 宽度差异由清零+低字节覆盖;指针字段用 `__setPtr` 写)。fixture `builtin-dgram-udp4`(进程内 loopback 收发)。**仍缺**:udp6/IPv6、多播(`addMembership`/`setMulticastTTL`)、`setBroadcast` 实际生效、连接式 UDP(`connect`/`remoteAddress`)。

**`https`/TLS 可行性(blocked-on 记录,R5)**:未实现,且**近期不宜实现**。TLS 需一整套记录层 + 握手状态机 + X.509 证书解析/验证 + 非对称(RSA/ECDSA)与对称(AES-GCM/ChaCha20)密码学 + ASN.1/DER 解析 + 系统根证书信任链。asm.js 无 FFI/动态链接到 OpenSSL/BoringSSL(纯 AOT + 手写系统调用),故只能**全部自实现**——工作量与整套 crypto 库相当,远超单会话/单车道。`crypto` 现有 `randomBytes`/`createHash`(v1.5.20/25)可复用为握手熵/摘要,但缺 AEAD 与公钥原语。**建议**:作为独立的多会话专项(方向三 N 系新增子项),先实现 AES-GCM + X25519/ECDHE + P-256 ECDSA 验证 + 最小 DER 解析 + TLS 1.3(比 1.2 状态机小),再在其上包 `https`(复用 http.js 的帧解析,仅替换底层 socket 为 TLS record 层)。当前 `import https` 静默退化,应显式抛"未实现"以免误用。

### 3.14 shim 编写时踩到的 codegen 缺陷(交 Agent ES / 编译器组;均已在 shim 内绕过)

写 `runtime/node/stream.js`(v1.5.43)时定位到以下**编译器/codegen 缺陷**。它们不在 Node shim 车道内,shim 已用等价写法绕过,但根因需编译器组修复。全部在 macos-arm64、gen0(`node cli.js`)复现:

- **C1 — 类体方法名 `end` 误编译(高危、通用)。** 任何 `class X { end() {…} }` 一旦被调用 `x.end()`,控制流被破坏:程序 `main` 体被无限重执(反复打印 `main` 顶层输出直至挂)。最小复现:`class Foo{ end(){return 42;} } new Foo().end();` → 无限打印。判别:仅方法名字面为 `end` 触发(`close`/`finish`/`stop`/`done` 均正常)。疑与 AST 节点 `.end`(源码位置字段)在某遍历/标签生成里的处理相关(见 `compiler/functions/closures.js:54/72`、`statements.js:841` 的 `k === "end"` 跳过逻辑),但根因未定位到具体误发。**绕过**:把 `end` 用原型赋值定义——`X.prototype.end = function(){…}`(得到不同的函数 label,不再冲突)。计算键类体方法 `["end"](){}` 仍触发,原型赋值才安全。此前 `string_decoder`/§3.11 记录的同类绕过即此缺陷。
- **C2 — 大模块内 `class … extends Readable` 模块初始化崩(布局敏感)。** 在体量较大的模块里,新增一个 `extends <某含计算键方法/静态方法/getter 较多的基类>`(实测 `extends Readable` 必崩,`extends EventEmitter`/`extends Writable` 正常)会在**模块初始化期**崩溃,报 `_object_set called with NULL object! (A0=0)` 或直接 segfault(139),`import` 该模块即触发(构造函数尚未执行)。属"布局敏感潜伏缺陷"族(见 BOOTSTRAP_RULES §1.5):同样的 `extends Readable` 在小模块里正常,推大到某阈值即崩;移除任一无关代码(甚至几十字节)可让崩点漂移或消失。**绕过**:`Duplex`/`Transform` 改为组合式——`extends EventEmitter`、内嵌一个 `Readable` 实例做可读侧、可写侧用自由函数内联,彻底避免 `extends Readable`。
- **C3 — 类体计算键 `[Symbol.asyncIterator]()` 不被 `for await` 派发 + 原型赋值触发 C2 布局崩。** `class C { [Symbol.asyncIterator](){…} }` 的实例用 `for await (x of c)` 报 `not a function`(对象字面量上的同名方法正常派发)。改用原型赋值 `C.prototype[Symbol.asyncIterator]=function(){…}` 语义正确(小模块验证通过),但在 `stream.js` 这种大模块里该赋值又触发 C2 的布局崩。二者叠加导致**流的异步迭代无法交付**,故 shim 明确不支持 `for await (chunk of stream)`(用 `'data'`/`'end'`、`read()`、`pipe()`、`pipeline()` 消费)。
- **C4 — `Array.prototype[Symbol.iterator]` 不作为可取值暴露。** `[1,2,3][Symbol.iterator]` 为 `undefined`(而 `for…of`/展开 `[...a]` 靠编译器 intrinsic 正常)。`typeof (obj.next)` 直取迭代器则正常。**绕过**:`Readable.from(array)` 对数组走按下标迭代,不依赖 `[Symbol.iterator]()`。

## 4. 模块系统状态清单

| 能力 | 状态 | 实证 |
|------|------|------|
| ESM 本地相对导入(静态) | ✅ | 自举依赖(~90 模块编译器自编译到逐字节不动点) |
| bare import → `runtime/node/<name>.js` 映射 | ✅ | `fs`/`path`/`fs/promises` 等;未命中者返回空串被静默跳过 |
| `node:` 前缀 | ✅ | `normalizeNodeModuleName` 剥前缀 + v1.5.16 子路径(`node:fs/promises`);`node:timers`/`node:os`/`node:process`/`node:fs/promises` 等 fixture 组已全绿。未知 `node:` 名仍回落到汇总 shim `index.js` |
| 动态 `import()` | ⚠️ | 静态 specifier(字面量/顶层 const 串/静态模板)已落地:`modules/dynamic-import-*` 组全绿;不存在的模块产 rejected Promise(`dynamic-import-missing-reject`)。运行时拼出的 specifier 归 L2 引擎库(见顶部状态更新) |
| CommonJS `require()` | ✅ | v1.5.16 AOT 子集(CJS 标志文件包 `module`/`exports`/`__filename`/`__dirname`,静态 specifier 入模块图);v1.5.35 修编译产物内 `require(builtin)` 导出形态;模块缓存/`module.exports` 重绑定/环形依赖(v1.5.47 惰性帧,见顶部状态更新)。`cjs/*` 组全绿。`index.js` 汇总对象上的 `require()` 仍为查 `_cache`-否则返回 `{}` 的占位 |
| ESM↔CJS 互操作 | ✅ | v1.5.16:import CJS 默认/具名(自 `module.exports` 合成 named exports),require(ESM) 得 namespace;`interop/*` 4 fixture 与 `packages/*-bridge` 全绿 |
| 匿名默认导出(`export default class {}` / `function () {}`) | ✅ | fixtures `modules/default-export-anonymous-class` / `default-export-anonymous-function` 绿 |
| 仓库自身 `package.json` | ⚠️ | 仍未声明 `"type": "module"`,`node cli.js` 触发 ESM 重解析警告(不阻塞) |

## 5. 包生态状态清单

N1(包解析)与 N2(CJS+互操作)已落地(v1.5.16,环形 require v1.5.47);N3 深度、N4、N5 未完成。规划映射到 [ROADMAP.md](./ROADMAP.md) 方向三。

| 能力 | 状态 | 实证(fixture) | 规划 |
|------|------|----------------|------|
| `node_modules` 逐级向上查找 | ✅ | `packages/basic-node-modules-esm` PASS | N1(v1.5.16 落地) |
| `package.json` `main` / `module` 字段 | ✅ | `package-json-module-vs-main` PASS | N1(v1.5.16 落地) |
| `package.json` `type`(module/commonjs) | ✅ | `package-json-type-module-cjs-entry` PASS | N1(v1.5.16 落地) |
| `exports`(root / subpath / conditional / wildcard) | ✅ | `package-json-exports-*` 4 项 PASS | N1(v1.5.16 落地) |
| 扩展名补全(`.mjs`/`.cjs`/`.json`)与 `node:` 全集 | ⚠️ | 仅 `.js` 补全 + 目录 `index.js` | N1 |
| CJS 真语义(缓存/循环依赖/`module.exports` 重绑定) | ✅ | `cjs/*` 全绿(含环形 require 部分导出 + 错误缓存,v1.5.47;见顶部状态更新) | N2(v1.5.16 + v1.5.47 落地) |
| `require(esm)` / `import(cjs)` 桥接 | ✅ | `interop/*` 4 项、`require-esm-package-bridge`、`import-cjs-package-bridge` PASS | N2(v1.5.16 落地) |
| 内建模块 near-node 化(fs sync 全量 + async/promises 等) | ⚠️ | 见第 3 节各表 | N3 |
| npm 真实包消费(`ms`/`debug`/`minimist`/`semver`/…20 包验证集) | ❌ | 无 | N4 |
| `asm.js build` 包级入口(读 `package.json` `main`/`bin` 整包编译) | ❌ | 无 | N5 |
| 包管理器(安装/锁文件/发布) | ❌ | — | 明确不自研,兼容 npm/pnpm/yarn 的磁盘布局(ROADMAP 3.2) |
| N-API / `.node` native addons | ❌ | — | **明确非目标**(与 AOT 单二进制模型冲突,ROADMAP 3.3) |
| `worker_threads`/`cluster` 完整 Node 语义 | ❌ | — | 非目标(并行能力由方向五 C2 承接) |

里程碑挂钩(ROADMAP §7): M2 = N1+N2,M4 = N3(fs/path/buffer/events),M5 = N4 首批 10 包,M6 = N5 `asm.js build` + N4 二批。

## 6. 高危已知限制(会静默出错,重点)

| # | 行为 | 后果 |
|---|------|------|
| 1 | ~~**`process.env` 动态读取恒为空**~~ **已修(v1.5.25)**:启动解析 envp 填入 `process.env`(fixture `builtin-node-scheme-process-env` 绿);win32 无连续 envp,env 为空对象 | 原"依赖 `NODE_ENV`/`HOME`/`PATH` 的代码静默走错分支"风险消除;`GC_STATS` 等诊断逃生口走 asm 层 envp,本就不受影响 |
| 2 | 未知 bare import(如 `import x from "leftpad"`)编译通过,绑定静默为 `0`(**2026-07-19 核:仍真实**——未命中 node_modules 解析的 bare specifier 返回空串,导入被静默跳过) | 不是报错而是错误值,难排查(E2"静默退化转显式编译错误"收口范围) |
| 3 | ~~`require()` 任何目标都不报错,得 `number`/`0`~~ **大部已修**:内建/本地/node_modules 包 require 已有真语义(v1.5.16/v1.5.35,环形 v1.5.47);未解析目标仍无显式报错路径(`_requireCall` 标记后无 `_requirePath`,与 #2 同属静默退化族) | 常见路径已可用;未命中解析的 require 仍得错误值 |
| 4 | ~~`import path from "path"` 默认导入后调方法段错误(exit 139)~~ **已修(2026-07-14)**:三因叠加修复,默认导出改普通对象(见 §2.2) | 默认/具名/namespace 导入全形态可用 |
| 5 | ~~全局 `setTimeout`(不 import)回调静默不执行;全局 `process.nextTick` 直接崩溃~~ **已修**:全局 timers 经编译器内建识别(v1.5.34,fixture `global-timers`);裸 `process.nextTick` 经原生全局 process 对象(v1.5.16,`runtime/core/process.js`) | 风险消除 |
| 6 | `fs` 失败路径不抛错(readFileSync 返 `""`、writeFileSync 静默、accessSync 返 `-1` 而非抛错)**仍真实**;`mkdirSync`/`rmdirSync`(v1.5.20)、`unlinkSync`(2026-07-14)已为真 syscall;`readdirSync` 恒 `[]`、`statSync`/`lstatSync` 假 Stats **仍真实** | 覆盖面之外的 fs 调用不会失败但也不生效;失败不抛错会静默走错分支 |
| 7 | ~~`crypto.randomBytes`/`randomUUID` 基于 `Math.random`~~ **已修(v1.5.25)**:内核熵源 getentropy/getrandom;`createHash` 自 v1.5.20 起为真算法(sha 族见 §3.11) | 熵源风险消除;占位项(sha224/ECDH/`scryptSync`)仍不可用 |
| 8 | `os.platform()`/`arch()`/`type()` 已随编译目标(v1.5.28);**`os.homedir()`/`hostname()`/`release()`/`totalmem()`/`freemem()`/`cpus()` 等仍硬编码假值** | 交叉编译产物读到错误主目录/主机信息(`process.platform`、`os.platform()` 正确,应优先用) |
| 9 | `https` 等无 shim 核心模块(`module`/`readline`/`worker_threads`/`tls` 等,见 §3.13)bare import 静默退化(与 #2 同路径) | 不报错而拿到错误值;§3.13 建议的"显式抛未实现"尚未实施 |

## 7. 与 2026-04-01 审计相比的变化

| 项 | 2026-04 | 2026-07 |
|-----|---------|---------|
| `node:` 前缀解析 | 无 | ✅ 已支持(含子路径;fixture 组已全绿,未知 `node:` 名仍回落汇总 shim) |
| `fs/promises` | 无(列为缺失) | ⚠️ 已有 sync 包装版(9 个 API) |
| timers | 纯占位(回调塞全局变量,返回 -1) | ⚠️ setTimeout/setImmediate 经 `__asmjs_*` 事件循环真实调度,`node:timers` fixture 组全绿 |
| JSON shim | 列为"依赖语言层未实现能力" | ✅ `__json_shim.js` 编译器注入机制落地(无 replacer/space/toJSON) |
| Node 域 fixture 集 | 无 | 已建 `tests/fixtures/node/`(packages/cjs/interop/builtin-node-scheme);2026-07-11 时的 29 项 FAIL 已全部转绿(套件全绿,当前 362/362) |
| 包解析 / CJS / npm 消费 | 不支持 | 包解析与 CJS 已落地(N1/N2,含环形 require);npm 真实包消费(N4)仍未验证 |

## 8. 一句话结论

asm.js 当前是"自举够用且持续加深的 Node 风格 shim 子集"(sync fs/path/process/console/timers 可实用,net/http/dgram/zlib/crypto 已有真实实现),N1(`node_modules`+`package.json` 解析,v1.5.16)与 N2(CJS `require()` AOT 子集 + ESM↔CJS 互操作 v1.5.16、环形 require v1.5.47)已落地;距"Node 兼容"还剩 N3 内建深度(fs async/promises 全量、`statSync`/`readdirSync` 真值、`process.stdin`、os 真实数据源等)、N4 npm 包验证集、N5 `asm.js build` 包级入口。`process.env` 未接线、crypto 假熵源、全局 timers 不触发、path 默认导入段错误等旧坑已修;仍活跃的高危项是 §6 第 2/6/8/9 条:未知 bare import 静默为 `0`、fs 失败路径不抛错、os 部分硬编码假值、`https` 等无 shim 模块静默退化。对外表述请继续沿用 README 的 "Not Node-compatible yet"。

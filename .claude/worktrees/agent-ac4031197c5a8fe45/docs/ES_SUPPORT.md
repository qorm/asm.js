# asm.js ES 标准支持列表

> 状态基线: **v0.2.1**(2026-07-20;编译器全确定性 `gen1==gen2==gen3`,fixtures 362/362)。
> 本文件是**当前支持面清单**,不含修复过程——历史修复日志与旧版逐条注记已归档至 [archive/ES_SUPPORT_HISTORY.md](./archive/ES_SUPPORT_HISTORY.md),版本级变更以 [CHANGELOG.md](../CHANGELOG.md) 为准。
> 核对方法: `node tests/run_fixtures.mjs` 全量 + 逐特性最小程序与 `node` 输出逐字节对照 + es-compat 差分计分卡(`tests/es-compat/`,诚实覆盖率 ~42%) + test262 差分(`tests/test262/run.mjs`,当前基线 1,328/6,462 = 20.55%,stride-5 子集)。
> 图例: ✅ 支持(与 node 对拍一致)/ ⚠️ 部分支持(注明偏差)/ ❌ 未支持 / 🔷 引擎库(L2)形态专属,AOT 非目标

## 1. ES5 及更早

| 特性 | 状态 | 备注 |
|------|------|------|
| 控制流(if/for/while/do-while/三元/switch/空语句) | ✅ | 自举级 |
| 标签语句 / 带标签 break·continue | ✅ | |
| 函数/闭包/递归 | ✅ | 自举级;偏差:>6 形参只绑前 6(6 寄存器调用约定) |
| `try/catch/finally` + `throw` | ✅ | finally 跨 return/break/continue 亦执行;跨函数 throw 传播 |
| Error 族(8 个内建 Error 类) | ⚠️ | 构造/message/name/cause/instanceof/toString/`class X extends Error` 均可;引擎合成的 TypeError(解构 null/undefined、读 `null`/`undefined` 属性 `null.x`/`undefined.x`→`Cannot read properties of null\|undefined (reading 'x')`、计算下标 `null[k]`/`undefined[k]`(起抛可捕获 TypeError,同 `.x` 修法)、class·Map·Set·WeakMap·WeakSet 无 `new` 调用)为真 TypeError 对象(`e instanceof TypeError`/`e.name`/`e.message` 成立,可 catch)。偏差:无 `.stack`、`e.constructor` 未挂;`fn()`(值非函数)运行时仍抛裸字符串 |
| Array 方法簇 | ✅ | map/filter/reduce(Right)/forEach/find(Last)(Index)/indexOf/lastIndexOf/includes/slice/splice/shift/unshift/push(多参+spread)/pop/concat/join/sort/reverse/fill/copyWithin/keys/values/entries/at;方法可作一等值(`const f=arr.push; f.call(...)`) |
| String 方法簇 | ✅ | indexOf/charAt/charCodeAt/split(串+正则+limit)/slice/substring/replace/replaceAll/trim 系/大小写/repeat/includes/starts·endsWith/padStart·End/at/localeCompare 等;字符串 NUL 透明(`\x00`/` ` 转义保留,长度/索引/拼接/比较/JSON 与 node 一致;仅 `\0` 八进制转义仍丢弃,编译器以之作 EOF 哨兵);UTF-16 码元语义缺失见 §14 |
| Object 元操作 | ✅ | keys/values/entries/assign/create(含 descriptors)/defineProperty(-ies)/getOwnPropertyDescriptor(s)/getOwnPropertyNames/freeze/seal/preventExtensions/isExtensible/hasOwn/hasOwnProperty/isPrototypeOf/propertyIsEnumerable;枚举序符合 ES `[[OwnPropertyKeys]]`(整数键升序在前) |
| 属性描述符 | ✅ | per-property writable/enumerable/configurable、访问器 get/set、非枚举属性被 keys/for-in/JSON 过滤、`configurable:false` 拒删。偏差:redefine 不可配置属性不抛 |
| `delete` | ✅ | 稀疏洞语义 ❌(dense-with-undefined) |
| `Function.prototype.call/apply/bind` | ✅ | 偏差:`apply` 实参 >5 截断(调用 ABI) |
| 函数反射(`.name`/`.length`) | ✅ | 静态解析;`.name` 对运行时函数值(参数/成员链)经函数元数据侧表反射;`.length` 运行时值仍为 0 |
| 函数自定义属性(`fn.x = 1`)/ 声明身份 `f === f` | ✅ | 属性侧表;模板对象/数组 `.raw` 同机制 |
| `arguments.length` | ✅ | 真实 argc(调用 ABI) |
| `typeof` / `parseInt` / `parseFloat` / `Number()` / `String()` | ✅ | Number() 支持 0x/0o/0b 前缀;全局 isNaN/isFinite ✅;`typeof new Map()`/`new Set()` 正确返回 `"object"`(裸堆指针 tag 守卫) |
| `"use strict"` | ⚠️ | 可解析;严格模式语义未逐条落实 |
| `with` | ✅ | 读/赋值/更新/方法解析 |
| ES5 函数构造器(`function F(){}` + `new F()` + prototype) | ✅ | |
| 严格求值顺序 | ✅ | 成员赋值「对象→键→值」、计算键「键→值」、复合赋值基/键单次求值 |

## 2. ES2015 (ES6)

| 特性 | 状态 | 备注 |
|------|------|------|
| `let`/`const`/块级作用域/TDZ/循环每迭代绑定 | ✅ | 偏差:同块重复 let 不报错 |
| 箭头函数 / 默认参数 / rest | ✅ | |
| class(全家桶) | ✅ | 构造器/实例·静态方法/getter·setter/`extends`(含 `extends (任意表达式)` 值基类)/静态成员继承/`super`(实例+静态)/静态块/计算键(字段+方法+访问器)/类表达式/派生类字段初始化次序/私有字段·方法 `#x`/`#x in obj`/`prototype.constructor` 回指类(`C.prototype.constructor===C`、`inst.constructor===C`)/方法名可为 `end`·`return`·`proto` 等(不与构造器内部结构标签冲突)。偏差:`extends 内建类`(Error 除外)❌、类生成器方法 `*m(){}` ❌、方法/`constructor` 可枚举(应不可枚举)、箭头函数内 `super` ❌ |
| 模板字面量 / tagged template / `String.raw` | ✅ | 自定义 tag 的 `.raw` + 每站点模板对象身份 ✅;模板对象不冻结(node 为 frozen) |
| 解构(声明/赋值/参数/嵌套/默认/rest/迭代器协议源) | ✅ | 计算键在声明与赋值形均运行时求值(`({ [k]: t } = o)`);偏差:迭代器源急切物化(非逐元素交错) |
| 生成器 `function*`/`yield`/`yield*` | ✅ | next(v) 双向传值、`return()`/`throw()` 执行 finally、每协程异常链;类生成器方法 ❌ |
| Symbol | ⚠️ | 一等键(对象键/`sym in obj`/计算字面量/keys 排除/getOwnPropertySymbols)、Symbol.for/keyFor、`.description`;well-known:iterator/asyncIterator/toPrimitive/hasInstance/toStringTag ✅;`Symbol.species` ❌ |
| Map / Set | ✅ | 构造 iterable、迭代、forEach、SameValueZero(NaN、-0→+0) |
| WeakMap / WeakSet | ⚠️ | API 可用;键强持有(非真弱引用);对象头 weakness 标志区分品牌:`Object.prototype.toString.call` → `[object WeakMap]`/`[object WeakSet]`(不再误报 Map/Set);WeakRef ❌ |
| Proxy | ✅ | get/set/has/deleteProperty/枚举、描述符族陷阱(getOwnPropertyDescriptor/defineProperty/ownKeys/preventExtensions/getPrototypeOf)、**apply/construct**(可调用 proxy、`new p()`、typeof→"function")、基础不变式强制。偏差:`Object.keys(proxy)` 不做 enumerable 过滤、gOPD 返回描述符的深层不变式未校验 |
| Reflect | ✅ | get/set/has/deleteProperty/ownKeys/getPrototypeOf/defineProperty/apply/construct/getOwnPropertyDescriptor/preventExtensions/isExtensible |
| Promise | ✅ | 构造器/then(2 参)/catch/finally/resolve/reject/all/race/any(AggregateError)/allSettled;无 `new` 调用抛 TypeError;微任务时序对齐 node;定时器/setImmediate 回调内 resolve 的 Promise 反应由事件循环泵空;`console.log(promise)` → `Promise { <state> }`(此前 native 段错误)。偏差:同一 tick 内 `queueMicrotask` 与 Promise `.then` 分属两队列,交错顺序非严格 FIFO 合并;`console.log` 不展开已兑现值(打 `<fulfilled>` 非具体值) |
| `for-of` + 迭代协议 | ✅ | 数组/字符串(按码点)/Map/Set/生成器/自定义 `[Symbol.iterator]`(对象字面量**及类体** `[Symbol.iterator](){}`);spread/`Array.from`/`new Set(x)`/解构统一走协议;break 触发 `iterator.return()`(IteratorClose)。偏差:return/throw 提前退出路径不 close |
| 一等数组迭代器 | ✅ | `arr.values()`/`.keys()`/`.entries()`/`arr[Symbol.iterator]()` 返回真迭代器对象(带状态化 `next()` → `{value,done}`,自身可迭代);建模同生成器对象(next 闭包持 target/index/kind 状态 + Symbol.iterator 闭包返 this)。for-of/展开/`Array.from`/手动 `.next()` 均可 |
| `new.target` | ⚠️ | 可解析,恒为 undefined(完整语义押后) |
| 原型链(getPrototypeOf/setPrototypeOf/`X.prototype`) | ⚠️ | 用户类链 ✅;内建 `getPrototypeOf([]) === Array.prototype` 等身份边角 ❌ |
| `instanceof` | ✅ | 用户类/继承链/ES5 构造器/内建/`Symbol.hasInstance` |
| ESM 模块 | ✅ | 见 §12 |
| 尾调用优化 | ❌ | 非目标(主流引擎亦普遍未实现) |

## 3. ES2016

| 特性 | 状态 | 备注 |
|------|------|------|
| `**` / `**=` | ✅ | |
| `Array.prototype.includes` | ✅ | |

## 4. ES2017

| 特性 | 状态 | 备注 |
|------|------|------|
| `async function` / `await` | ✅ | **全形态完整**:声明/箭头/函数表达式/类方法/对象字面量方法均返 Promise;多实参;`await 非 promise` 直通。偏差:async 函数默认参数不触发 |
| `Object.entries` / `Object.values` | ✅ | |
| `String.prototype.padStart/padEnd` | ✅ | |
| `Object.getOwnPropertyDescriptor(s)` | ✅ | 单数+复数 |
| SharedArrayBuffer / Atomics | ❌ | 并发能力走方言 `js f(x)` spawn + Channel(见 [PARALLEL_DESIGN.md](./PARALLEL_DESIGN.md)) |

## 5. ES2018

| 特性 | 状态 | 备注 |
|------|------|------|
| 对象字面量 spread / rest 解构 | ✅ | rest 排除计算键 ✅ |
| `for await ... of` | ✅ | sync 可迭代、异步可迭代(对象字面量**及类体** `[Symbol.asyncIterator](){}`)、体内 await 的异步生成器 |
| RegExp:命名组/lookbehind/dotAll/sticky | ✅ | |
| `Promise.prototype.finally` | ✅ | |

## 6. ES2019

| 特性 | 状态 | 备注 |
|------|------|------|
| `flat` / `flatMap` | ✅ | |
| `Object.fromEntries` | ✅ | 数组/Map/Set/任意可迭代 |
| `trimStart` / `trimEnd` | ✅ | |
| optional catch binding | ✅ | |
| `Symbol.prototype.description` | ✅ | |

## 7. ES2020

| 特性 | 状态 | 备注 |
|------|------|------|
| 可选链 `?.` / `?.[]` / `?.()` | ✅ | 短路不求值;类型感知分派;私有字段 `o?.#x` 正确改写键。偏差:副作用基对象双求值 |
| `??` / `??=` | ✅ | 偏差:运行时未知类型返回数值 0 的位点仍可能误判 nullish(NaN-box 裸 0 表示边界) |
| BigInt | ⚠️ | 64 位子集:字面量/算术/比较/位运算/toString(radix)。任意精度 ❌、混型运算不抛 TypeError |
| `globalThis` | ⚠️ | typeof 正确;可用面未深测 |
| `String.prototype.matchAll` | ✅ | |
| 动态 `import()`(静态 specifier) | ✅ | 字面量/静态拼接/模板/const 绑定 → resolved Promise |
| 动态 `import()`(运行时 specifier) | 🔷 | L2 引擎库能力(同 eval) |
| `import.meta` | ✅ | |
| `export * as ns from` | ✅ | |

## 8. ES2021

| 特性 | 状态 | 备注 |
|------|------|------|
| 逻辑赋值 `\|\|=` / `&&=` / `??=` | ✅ | 含访问器成员的短路语义(不误调 setter) |
| 数字分隔符 `1_000_000` | ✅ | |
| `String.prototype.replaceAll` | ✅ | 字符串与正则模式 |
| WeakRef / FinalizationRegistry | ❌ | |

## 9. ES2022

| 特性 | 状态 | 备注 |
|------|------|------|
| 公有/静态/私有类字段与方法、静态块 | ✅ | 私有 brand check 无 TypeError(错误实例得 undefined) |
| `#x in obj` | ✅ | |
| top-level await | ✅ | |
| `Array/String.prototype.at()` | ✅ | 含负索引 |
| `Object.hasOwn` | ✅ | |
| `Error.cause` | ✅ | 全 8 个 Error 类 |
| RegExp `d` 标志(`.indices` / `hasIndices`) | ✅ | |

## 10. ES2023

| 特性 | 状态 | 备注 |
|------|------|------|
| `findLast` / `findLastIndex` | ✅ | |
| `toSorted` / `toReversed` / `toSpliced` / `with` | ✅ | `with` 越界不抛 RangeError(记偏差) |
| Hashbang `#!` | ⚠️ | 未验证 |
| Symbol 作 WeakMap 键 | ❌ | |

## 11. ES2024 / ES2025

| 特性 | 状态 | 备注 |
|------|------|------|
| `Object.groupBy` / `Map.groupBy` | ✅ | 非数组可迭代输入未支持 |
| `Promise.withResolvers`(2024)/ `Promise.try`(2025) | ✅ | |
| RegExp 内联修饰组 `(?i:...)`(2024) | ✅ | |
| RegExp `v` 标志 / `\p{...}` Unicode 属性转义 | ❌ | 需 Unicode DB,大项 |
| resizable ArrayBuffer / `Array.fromAsync` | ❌ | |
| ES2025 Set 组合子(union/intersection/difference/symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom) | ✅ | |
| `RegExp.escape`(2025) | ✅ | |
| Iterator helpers(2025) | ❌ | 刻意推迟(曾撞自举回归,见 memory 档案) |

## 12. 模块系统(ESM / CJS / 互操作)

| 能力 | 状态 | 备注 |
|------|------|------|
| 静态 `import`/`export`(named/default) | ✅ | 自举级(编译器自身 ~90 模块) |
| 循环依赖 / 初始化一次 / live binding / TDZ | ✅ | |
| 动态 `import()`(静态 specifier) | ✅ | 运行时 specifier 🔷 L2 |
| CommonJS `require()`(AOT 子集) | ✅ | CJS 文件读取期包装为 ESM;静态 specifier 入模块图。环形 require ✅(环上本地 CJS 模块编译为独立惰性初始化函数,函数体入口即发布 `module.exports`,循环再 require 读到部分对象,Node 语义;ESM/非环 CJS 不变) |
| `node_modules` + `package.json` 解析 | ✅ | `exports`(root/子路径/`*`/条件)、`main` vs `module`、`type`、`node:` 前缀含子路径 |
| ESM↔CJS 互操作 | ✅ | CJS default/具名合成、`require(esm)`→namespace |

## 13. 全局对象与内建运行时

| 对象/能力 | 状态 | 备注 |
|------|------|------|
| JSON | ✅ | stringify/parse 全参(replacer/space/reviver/toJSON、Date→ISO);循环引用不抛 |
| RegExp 引擎(自研回溯 shim) | ⚠️ 大面完整 | 字面量/`new RegExp`、flags `gimsyd`、命名组+`\k`+`$<n>`、lookaround、反向引用、matchAll、`replace(re, fn)`(含命名组末参)、split、内联修饰组;`.test`/`.exec` 对静态类型未知的接收者(如作为参数传入的正则)经 `__isRegExp` 运行时判别派发。❌:`\p{}`、`v` 标志、RegExp 子类化、`Symbol.match/replace/split`、`prototype.compile` |
| TypedArray / ArrayBuffer / DataView | ✅ | 11 种视图、缓冲区多视图共享内存、`.buffer` 身份稳定、`.byteOffset`、Uint8Clamped 饱和、DataView 全宽度×端序;非原地 `toReversed`/`toSorted`/`with`(返回同类型副本,原数组不变;`with` 支持负索引);原地 `copyWithin(target,start?,end?)`(memmove 语义,重叠双向正确、负索引;此前 native 段错误);串化 `String(ta)`/`""+ta`/`` `${ta}` ``/`ta.toString()` → 逗号连接元素(对齐 node,此前为垃圾浮点);`console.log(ta)` → `Type(len) [ e0, e1 ]`(顶层/嵌套/多参一致,对齐 node,此前打 `[object Object]`)。偏差:sort 比较函数忽略、subarray 为拷贝、`toSpliced` 未实现 |
| Math | ✅ | 全函数族(三角/双曲/对数/幂等)~1ulp;一元族可作一等值(`arr.map(Math.floor)`) |
| Date | ✅ | 构造/历法 getter·setter/parse/ISO/toLocale* 系/装箱语义;getTimezoneOffset 恒 0 |
| Number | ✅ | toString(radix)/toFixed/toExponential/toPrecision/toLocaleString;浮点打印 shortest round-trip(Dragon4,与 node 逐字节) |
| console.log | ✅ | 输出对齐 node `util.inspect`(嵌套对象/Map/Set/Date/Error) |
| `structuredClone` | ✅ | JSON-safe 数据深拷贝(undefined/函数/循环等记偏差) |
| 内建命名空间静态作一等值 | ⚠️ | Math 一元族/Object.keys·values·entries/Date.now/Array.isArray ✅;多参族(Math.max/pow 等)与 JSON.parse 等待 wrapper |
| `eval` / `new Function` | 🔷 | 引擎库 route B:AOT 程序可直接调用(编译器编入产物)。**直接 eval 词法作用域捕获 ✅**:`function f(){let x=10; eval("x=20"); return x}`→20——直接 `eval(str)` 读写外层函数局部(编译期序列化帧内名→槽布局 + 传入运行时 FP,片段入口 copy-in/出口 copy-out)。支持读/写/复合上下文/多变量/形参/字符串/块内 eval;间接 eval(别名/`(0,eval)`)保持全局语义。**捕获数组/对象经方法/成员变异 ✅**(round 2):`eval("a.push(1)")`/`eval("o.k=9")` 变异经共享堆传播、eval 返回后可见(push/pop/shift/unshift/splice/成员改写/新增属性/下标写)。**eval 内闭包捕获被捕获变量读用例 ✅**:`let base=10; eval("[1,2,3].map(v=>v+base)")`=`[11,12,13]`(同步执行的 map/reduce 加法)。**eval 内非逃逸闭包写回捕获标量 ✅**(round 3):`function f(){let s=0; eval("[1,2,3].forEach(v=>{s=s+v})"); return s}`=6——copy-in 对被片段内闭包捕获的名做 rebox-on-capture(建共享堆 box),闭包写入经 box、copy-out 回灌调用者槽(int/string 累加、双捕获变量、嵌套箭头)。**逃逸闭包 eval 后再改捕获变量 ✅**(round 4):`function f(){let base=10; let g=eval("(function(){return base})"); base=20; return g()}`=20——含直接 eval 的函数把全部局部保守升级为堆 box(调用者帧模型),调用者与片段闭包共享同一 box,逃逸闭包写/调用者后续写皆联动(编译器自身无 eval → 自举逐字节零影响)。**仍存局限**:sloppy `var`-in-eval 泄漏到宿主作用域(架构级,宿主帧无该 var 槽);`v*字面量`乘法/`filter` 在 eval 片段内为既有表达式 codegen 限制。见 [../engine/README.md](../engine/README.md) |
| Intl | ❌ | 明确非目标 |

## 14. 已知横切偏差(深层)

- **NaN ≡ boxed-int0 别名**:计算 NaN(`0/0` 等)的 `===` 自比较、`Number.isNaN(计算NaN)` 误判;位型检测路径(全局 isNaN)不受影响。
- **字符串 UTF-16 码元层缺失**(UTF-8 字节模型):`.length`/`charCodeAt`/`[i]`/`slice` 对非 ASCII 按字节;迭代(spread/for-of)按码点正确;非 ASCII 字面量/转义 cook 正确(与 node 逐字节)。修复需码元视图,属专项决策。
- **-0 打印为 "0"**(`Object.is(-0,0)`/`-0===0` 语义正确)。
- **调用约定 >6 形参截断**;`apply` >5 实参截断。
- 模板对象不冻结;WeakMap 键强持有;稀疏数组为 dense-with-undefined。

## 15. 方言扩展(非 ES,标注避免混淆)

- `js f(x)` spawn 语句 + `Channel` 内建(Stage-0 并发,[PARALLEL_DESIGN.md](./PARALLEL_DESIGN.md);linux-arm64 已落地 GOMAXPROCS>1 多 OS 线程 work-stealing 调度与 N 路 stop-the-world GC)。
- `--target wasm32-wasi` WebAssembly 目标([WASM_DESIGN.md](./WASM_DESIGN.md))。

## 16. 一句话结论
1. `[] + x` 错值(ToPrimitive)

经此前修复波,asm.js 的常用 ES 面(class 全家桶/async 全形态/迭代协议/属性描述符与枚举序/Proxy·Reflect/正则大面/typed arrays/JSON 全参)已与 node 对拍一致;自举链路覆盖的核心子集经逐字节确定性自举门(gen1==gen2==gen3)验证。剩余结构性缺口:字符串 UTF-16 码元语义、内建子类化与 `Symbol.species`、Iterator helpers、`\p{}`/`v` 正则、Intl(非目标)。

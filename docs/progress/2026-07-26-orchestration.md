# 2026-07-26 主控编排进度(S1 启动日)

> 上位蓝图: `plan.md`(唯一事实源)。本文档记录本次多 agent 编排的实施进度,收口后要点回写 plan.md。
> 基线: dev @ 09abe4c,test262 1604/6462 = 24.82%(2026-07-24 报告),fixtures 380/380(2026-07-26 实测,已从 plan.md 记录的 362 增长),S1 目标 >= 28%。

## 波次规划

### 波次 1 — 并行分析(进行中)

| 编号 | Agent 任务 | 状态 | 产出 |
|---|---|---|---|
| A1 | 架构与代码质量分析(lang/compiler/vm/backend/asm/binary/runtime) | 完成 | 见下「A1 结论」 |
| A2 | test262 CRASH 簇归因(480 项聚类 + 头部根因 + 最小复现) | 完成 | 见下「A2 结论」 |
| A3 | 红队安全审计(runtime 内存安全 / crypto / zlib / net / 仓库卫生) | 完成 | 见下「A3 结论」 |
| A4 | test262 FAIL 快速杠杆分析(4270 项聚类,找高性价比修复簇) | 完成 | 见下「A4 结论」 |

> **当前构建实测 27.00%(1745/6462)** — A2 重跑发现工作树已比提交基线(24.82%)高,近 S1 目标 28%。CRASH 头部修复(簇 A ~150 转 PASS)预期一举越过 28%。

### 波次 2 — 修复实施(待波次 1 结论)

- 原则: 每项修复配 gen0 最小复现;fixtures 不降(362);macos-arm64 gen1==gen2==gen3 字节定点不破;严禁复制大 codegen 方法。
- 候选项由 A2/A4 的头部根因排序产生,红队高危项(若有)优先。

## 治理门禁(每次改动)

1. `node tests/run_fixtures.mjs` 不低于 362
2. 自举定点字节一致
3. 修复配 repro,与 Node 对拍
4. 对象/数组头布局变更单次提交同步全部站点

## A1 结论(架构与代码质量,2026-07-26)

前 10 风险点摘要:
1. 上帝类 `Compiler` + 三 mixin 共享隐式 this 契约(compiler/index.js:249,3194 行 `Object.assign`)。
2. **内存布局遍历站点分散、无单一事实源**(最脆契约):对象头字段偏移在 runtime/types/object/index.js:30 定义,但 compiler 侧以裸魔数散布(statements.js 7 处、expressions.js 6 处等),靠人工纪律维系,一处漏改即段错误。
3. 超长 god-function:`compileBinaryExpression`(operators.js:243 约 1032 行)、`compileArrayMethod`(builtin_array_methods.js:80 约 698 行 switch)、`compileNewExpression`(expressions.js:212 约 641 行)、`compileMemberExpression`(members.js:626 约 613 行)、`compileClassDeclaration`(statements.js:2393 约 589 行)。
4. 增量纪律悬崖:复制大 codegen 方法 +341 行即触发 __text 非确定性(v1.5.52 教训)。
5. x64 自举定点回退(为规避而非修复;devirt 对 x64 整体关闭)。
6. 28GB 初始堆是重定位 bug 的规避(< 32GB 机器无法自举)。
7. 布局敏感潜伏 miscompile(源码体积/组合触发,难回归)。
8. 跨目标 backend/asm 结构性重复(base.js 仅 217 行,抽象共享度低)。
9. Builtin 方法编译器族巨 switch + legacy 死代码(`_compileArrayFilter_legacy` 142 行)。
10. 版本编号与基线口径文档间不一致(README v0.2.1 / plan.md v1.5.52 / BOOTSTRAP 仍写 281/283)。

重构建议(按性价比):
- **R1(最高,可能保定点)**: 抽出共享内存布局常量模块(vm/core 级 `object_layout.js`),compiler 与 runtime 双向 import,用具名常量替换全部魔数偏移。把人工原子性纪律编译期化,直接降低风险点 2 与 4。纯符号替换不改发射字节。
- R2: 拆分 `compileBinaryExpression` / `compileArrayMethod`(分派表 + 子方法),一次一个、每步过定点门禁。
- R3: 参数化去重 builtin 方法编译器族,先删 legacy 死代码。
- R4: 收敛 compiler/index.js 模块编排职责,顺手拆 `compiler/modules/`。
- R5: 文档基线/版本口径一次性对齐(零代码风险)。

### A1 补充(第二轮更深架构,新增 FP-safe/FP-sensitive 分级 — Wave 2 排序关键)

真·上帝方法修正:`compileCallExpression`(functions/functions.js:839-4848,**约 4010 行**,占该文件 83%,~295-314 个字符串名分派比较)才是最大维护负债,不是 compileBinaryExpression。

确定性面已验证 clean:emit 路径无 Date.now/Math.random/hrtime/熵;二进制时间戳字段硬编码 0;最低四层无 `.sort()`;名字计数器为 AST 遍历序 `n++`。

布局敏感风险(可能破 gen1==gen2==gen3):
- **x64 地址量级 label 分类(最高风险)**:asm/x64.js:1481/1486 按地址量级判 offset-vs-absolute,`.text` 超 ~4.2MB 即 SIGSEGV —— 正是 x64 自举回退的具体 blocker。
- 分支编码器静默截断无范围断言:arm64 cbz/cbnz imm19(±1MB)、b/bl imm26(±128MB)、x64 rel32(asm/arm64.js:1720/1664,asm/x64.js:1499)。
- REC_CAP=256 op 数悬崖(vm/index.js:14);死代码陷阱 `runtime/types/array/base.js`(未被 import 的 24 字节旧头,若重新接线即静默 miscompile)。
- 布局常量无单一事实源(与第一轮 R1 一致):对象头常量 file-local,GC 扫描(allocator.js:1853)/subscript/print/map 各自硬编码裸偏移。

改进项 FP 分级(**Wave 2 直接采用**):
- **FP-safe / 可立即做**:#1 抽布局常量模块;#2 删/隔离死代码 array/base.js;#4 分支编码器加范围断言(把静默 miscompile 变响亮编译错误,契合 plan.md S2「静默退化转显式报错」);#7 `this.ctx` swap/restore 封装为 `withContext` try/finally(消除「swap 与 restore 间 throw 污染全部输出」);#11 退休 stale self.sh;#12 校正 README 自举旧文案。
- **FP-sensitive / 须每步过 bootstrap-gate 且参数化去重严禁复制**:#3 修 x64 label 分类(x64 自举解锁);#5 参数化 9 份数组高阶方法副本(收 ~1400 行);#6 分解 compileCallExpression(数据驱动分派表);#8 全 11 个 binary emitter 采用共享 BinaryGenerator 基类;#9 NaN-box tag 内联走 helper;#10 修同名嵌套类 label memo 碰撞(functions.js:269,正确性)。

## A3 结论(红队安全审计,2026-07-26)

crypto(runtime/node/crypto.js,最高价值目标):
- **HIGH `timingSafeEqual` 非常量时间且泄漏长度**(crypto.js:1003 `a.equals(b)`,buffer.js:160 首字节差异即短路)——MAC/tag 字节搜索预言机。
- **HIGH GCM auth-tag 长度从不校验 → 截断-tag 伪造**(crypto.js:737 setAuthTag 存任意字节;final 仅比对 `expectedTag.length` 字节,1 字节 tag → 1/256 伪造概率;比较也非常量时间)。GCM 路径被 fixture 覆盖,是活路径。
- **HIGH `scryptSync` 静默返回全零密钥**(crypto.js:1026 `Buffer.alloc(keylen)`)。
- **HIGH 未知平台熵源全零填充**(crypto.js:31 `_entropyBytes`;Windows 等 randomBytes/UUID/randomInt 完全可预测)。
- MED/HIGH 熵源 syscall 返回值被忽略(crypto.js:20/28,EINTR/部分/ENOSYS 时返回零填充堆内容当"随机")。
- MED 不支持的 hash 算法静默返回 djb2 伪摘要(crypto.js:324,`createHash('sha224')` 得零强度输出而非抛错)。
- MED `randomFillSync` 无目标越界检查(crypto.js:956)。LOW randomInt 取模偏置 + 无范围校验(crypto.js:1010)。

其他子系统:
- **MED 编译器驱动命令注入**:compiler/index.js:2992 `execSync(\`ar rcs "${outputFile}" ...\`)`,输出路径含 `"`/反引号/`$(…)` 时执行任意命令。修法:`execFileSync('ar', ['rcs', outputFile, tempObjFile])`。
- **HIGH 未终止正则在 EOF 处死循环**:lang/lexer/index.js:479 用 `ch !== ""` 而 EOF 哨兵是 `"\0"`,输入 `/abc`(无闭合)使编译器 100% CPU 挂死。
- **HIGH 解析器无限递归 → 硬崩溃**:lang/parser/expressions.js:339 分组/箭头无深度上限,数千层 `(` 耗尽原生栈,自举二进制里是不可捕获 SIGSEGV 而非 RangeError。MED 箭头-vs-分组前瞻 O(N²)。
- MED/HIGH child_process 可预测 /tmp 捕获文件(符号链接/TOCTOU):child_process.js:128 无 `O_EXCL`/`O_NOFOLLOW`。
- MED allocator 接受负/超大 size,bump 指针边界检查可被回绕绕过(allocator.js:714/1254);MED(潜伏)`_free` 无双重释放校验(当前 `__free` 未被调用,潜伏)。

已审查并判定充分防护(未列为问题):GC mark bitmap 保守内部指针、net/fs/dgram 拷贝循环边界、execFile/spawnSync 位置参数无注入、无硬编码密钥、无计划外 eval。

### A3 补充(第二轮更深红队,内存安全为主 — 与上表交叉验证 GCM/timingSafeEqual,并新增以下 CRITICAL)

- **CRITICAL CR-1 TypedArray 元素写越界 → 任意 OOB 写原语**:runtime/types/typedarray/index.js:584 `_typed_array_set` 经 subscript.js:413 无边界检查;`const a=new Uint8Array(8); a[100000]=0x41` 写攻击者可控字节到缓冲区外,`a[-16]=…` 写下方。编译器快路径故意排除 TypedArray(members.js:767 仅 TYPE_ARRAY==1)。真 JS 静默忽略。
- **CRITICAL CR-2 DataView set 越界写**:typedarray/index.js:282 `_dataview_set` 无 `byteOffset+size <= byteLength` 校验。
- **CRITICAL CR-3 GCM 接受空/截断 tag → 完全认证绕过**:crypto.js:753 循环长度取攻击者提供的 `expectedTag.length`,`setAuthTag(Buffer.alloc(0))` 使循环体不执行 → `ok` 恒真。(与上表 GCM 项同源,此处确认 1 字节 tag → 1/256。)
- **CRITICAL CR-4 zlib inflate 空/截断输入死循环**:zlib.js:209,根因 `_readBit`(:89)越界返 0 而非 EOF,`while(!last)` 永不见 BFINAL=1。已实测复现(500 万+ 迭代无进展)。`inflateRawSync(Buffer.alloc(0))` 等可达。
- **CRITICAL CR-5 zlib 解压炸弹无输出上限**:zlib.js:161,`maxOutputLength` 被接受但忽略,微小载荷无限膨胀 → OOM。
- **HIGH H-1 TypedArray 元素读越界 → 内存泄露**(typedarray/index.js:469);**H-2 TypedArray-over-buffer 视图不校验 buffer 长度 → 越界别名视图**(:444/:1297);**H-3 ArrayBuffer.prototype.slice start/end 不 clamp → 越界读/泄露**(:139);**H-4 timingSafeEqual 非常量时间**(同上表);**H-5 HKDF 缺 `L<=255*HashLen` 约束、单字节计数器回绕**(crypto.js:893);**H-6 HTTP chunked 解码 O(N²)+ 无界缓冲**(http.js:75);**H-7 HTTP 头部无界缓冲 + 无超时**(http.js:275)。
- MEDIUM:M-3 `_typed_array_new` length×elemSize 无溢出/负数守卫(:426)、M-4 HTTP 请求走私 TE/CL 不协调、M-5 IV/nonce 长度不校验、M-6 PBKDF2 参数不校验、M-7 熵源零填充回退、M-8 keep-alive 流水线递归栈溢出。
- 最高杠杆单根因:**(a) 在 `_typed_array_get/set`、`_dataview_get/set`、`_typed_array_view`、`_arraybuffer_slice` 加索引边界检查 → 一举关闭 CR-1/CR-2/H-1/H-2/H-3/M-3**;(b) zlib `_readBit` 检测 EOF + 输出上限 → 关闭 CR-4/CR-5/M-2;(c) 修 GCM tag 比较 → 关闭 CR-3。
- 判定 clean:net/dgram 原始内存路径、SHA/AES/HMAC/GHASH 谱正确(GCM 不提前释放未验证明文)、cli.js/scripts 无命令注入、无提交私钥、*.bundle 已 gitignore。

优先级建议(合并两轮):1) **内存安全 CR-1/CR-2/H-1/H-2/H-3 一组边界检查**(最高,可控写原语);2) zlib CR-4/CR-5(EOF + 输出上限);3) GCM tag 长度校验 + 常量时间 + timingSafeEqual;4) 熵源/scryptSync/未知 hash/HKDF 改硬失败;5) 未终止正则死循环 + 解析器递归上限;6) `ar` 命令注入改 execFileSync。

## A2 结论(test262 CRASH 簇归因,2026-07-26)

注:A2 重跑了 test262(当前工作树构建),实测 **1745 PASS / 474 CRASH**(旧报告文件 1604/480 早于近期 S1 提交,已过期;A2 已重新生成 last_report.md/last_run.json)。

474 崩溃聚类(411 SIGSEGV / 19 SIGBUS / 44 timeout):

| 簇 | 描述 | 数量 | 崩溃位置 |
|---|---|--:|---|
| **A** | 真数组上具名属性写(`arr.foo=x`、`defineProperty(arr,..)`、`verifyProperty`) | **167** | `_object_set_entry` runtime/types/object/index.js:2160 放行 Array tag 0x7FFE 进对象头路径,:2246 解引用垃圾"prop key"(数组头仅 32B) |
| C | TypedArray 探测:`typeof Float16Array` 返回 "number"(未知全局=0),harness 压入 null ctor,`new TA` 解引用 null+0x20 | 52 | typeof 未知全局(编译器)+ compileDynamicNew classinfo 回退 expressions.js:1790(无 null/类型守卫) |
| F | 数组解构从自定义可迭代对象抽干永不 done 的迭代器 → 超时;`arr.length=2^32-1` 循环 | 44 | dstr lowering 抽干可迭代对象,忽略 next/return 协议 |
| B | 经内建原型对象写(`Array.prototype[1]="3"`)——`X.prototype` 求值为 undefined(0),写解引用 null | 35 | `_subscript_set` subscript.js:379 |
| D | Promise 组合子无可迭代守卫(`Promise.all(false)` 对 boolean 调 `_array_length`) | 32 | `_Promise_all` promise.js:832(及 any:1003/race:1114/allSettled:1179)——应 reject TypeError |
| H | 类体 async-gen / yield-star / eval-super 崩溃(异构) | ~50 | 生成器/异步生成器 lowering |
| E | `class X extends <builtin>`(Array/Set/Float64Array)——内建 ctor 非 classinfo 对象 | 14 | class extends lowering |
| G | 直接数组方法收到不可调用回调(`arr.forEach(5)`)内联 callIndirect 原始值 | 7 | builtin_array_methods.js ~1716(09abe4c 只修了 `_aref_invoke_cb`,未修此内联路径) |
| 尾 | Set set-like/proxy/spread 等杂项 | ~73 | 异构 |

**头部修复排序(count × 可解性)**:
1. **簇 A(167,最高杠杆且极易解)**:`_object_get` 已在 object/index.js:629 把 0x7FFE 路由到 `_closure_prop_get`(侧表),但 `_object_set_entry`/`_object_define` 缺对称分派。加 `0x7FFE -> _closure_prop_set`(:539 已定义)+ TYPE_ARRAY=1 类型字节 bail。因读路径已查侧表,expando 测试(含全部 RegExp `.index` 系)预期直接 flip 到 **PASS 而非仅 FAIL**。
2. **簇 C(52)+ E/new 守卫**:`typeof 未知全局` 须为 "undefined";compileDynamicNew(expressions.js:1790)须对非构造器抛 TypeError。守卫本身把 52 转为 run(多数随后 PASS)。
3. **簇 D(32)**:四个 Promise 组合子(promise.js:832/1003/1114/1179)加共享可迭代/类型守卫,非数组则 reject TypeError,崩溃测试正好断言此 rejection → 多数 PASS。
4. **簇 B(35)**:为 `Array.prototype`/`Object.prototype`/`Number.prototype` 造真单例对象(复用已有 `_get_ctor_proto`/TA_CTOR_TAGS 机制);廉价过渡是 null 守卫抛 TypeError 先去崩溃。

修复 1-4 合计覆盖 **~300/474 崩溃(63%)**,大部分预期转 PASS 而非仅 FAIL。G(7)是 callIndirect 前两行 callable 检查,可顺带并入。F(44 超时)需迭代器协议重写,可解性排其后。

簇 A 最小复现(已验证):`var a=[1,2,3]; a.foo=9;` → SIGSEGV(exit 139),lldb `EXC_BAD_ACCESS` at `ldr x0,[x24]`。faulting load = object/index.js:2246。

### A2 交叉验证(第二轮独立 CRASH 归因,结论高度一致 — 强化置信度)

第二轮独立聚类(数据源 last_run.json 480 例:SIGSEGV 415 / 超时 45 / SIGBUS 20)与第一轮**逐簇吻合**:同样把「数组写命名属性」定为最大簇(约 150-160,同根因 object/index.js:2136/2142 放行 0x7FFE)、同样识别 Promise 组合子无守卫(promise.js:832)、迭代器抽干超时(statements.js:576-610)、prototype 未物化 + `_subscript_set` 无 nullish 守卫(subscript.js:365)。两轮从不同复现到达同一头部根因,置信度高。

有价值增量:
- **TypedArray 由对象/array-like 构造(簇 B,56)**独立成簇且给出干净复现:`new Int8Array({length:3})` → `.length` 打印 12884969360(tagged 指针当长度),遍历即 SIGSEGV/超时。根因 `_typed_array_from` typedarray/index.js:771 仅识别 0x7FFE 装箱数组,否则把值直接当长度传 `_typed_array_new`(:370,长度无上限)。harness testTypedArray 用 makeArrayLike/makeIterable 喂对象实参,整目录被击穿。此簇同时修正大量同源 FAIL(`new Int8Array([...])` 读值也错)。→ 应作为 Wave 2 第 2 项,与安全红队 CR-1/M-3(TypedArray 越界/长度溢出)同源,合并处理。
- `class X extends <builtin>`(簇 E,~30):内置构造器无 classinfo 槽,父类槽读到 tagged 小值解引用。
- 类表达式 extends + 实例字段(簇 G,~15-20):expressions.js:200 compileClassExpression 与声明路径 classinfo/字段初始化不一致(父类路径 :1015 只认 Identifier)。

## A4 结论(test262 FAIL 快速杠杆,2026-07-26)

**头号发现:内建不是一等值**。`X.m(...)` 调用语法被编译器特判,但把同一个 `X.m` 当值读出得 undefined 或裸数字。已用最小复现验证(asm.js vs Node):`typeof Function.prototype`→undefined、`Function.prototype.call`→undefined ⇒ **propertyHelper.js 加载即抛,击杀全部 682 个含它的测试**;`typeof TypeError`→"number"、`var C=TypeError;new C()`→SIGSEGV、`(new TypeError()).constructor`→undefined ⇒ **assert.throws 永不 PASS**;`typeof Promise.all`/`p.then`/`Reflect`/`f.call`/`[][Symbol.iterator]` 全 undefined。

FAIL/COMPILE_FAIL 聚类(4378 重跑):

| 簇 | 描述 | 数量 | 根因 |
|---|---|--:|---|
| 1 | propertyHelper.js harness 加载即死 | 682 | `Function.prototype.call.bind(...)` 顶层抛 |
| 2 | assert.throws 结构性坏 | 227+ | `thrown.constructor` undefined + 错误构造器标识符是裸数字无 `.name` |
| 3 | 类 生成器/异步生成器方法不是真函数 | ~570 | `var ref=C.prototype.gen; ref()` SIGSEGV/不可调用 |
| 4 | 应抛的错误从未抛出 | 406 | 缺 callable/range/frozen-write/regexp 语法校验抛出点 |
| 5 | 描述符/属性反射缺口 | ~600+182 | `gOPD(fn,"name"/"length")`→undefined;内建方法非 namespace 自有属性;writable/configurable 不强制 |
| 6 | 负面解析被接受 | 353 | 类早错 143、delete 早错 39、RegExp 属性转义语法 39、use-strict+非简单参数 21 |
| 7 | COMPILE_FAIL 解析器缺口 | 108 | rest-obj `[...{x}]`、解构赋值 `({x=1}={})`、计算键 `[k??=v]` |
| 8 | 报告后已修 | 167 | 近期 S1 提交(重跑基线白得 +2.6%) |

跨切廉价 bug(污染全套特性探测):`typeof 未声明变量`→"number"(应 "undefined")、严格模式普通调用 `this`→global、`String(obj)` 忽略原型链 toString、for-in 跳过原型链、`"length" in []`→false、`Object.hasOwn`/`Symbol.species` 缺失。

**排序 backlog(杠杆 × 可解性,达 28% 约需 +205 flips)**:
1. 重跑基线 +167(+2.6%,已反映在 27.00%)。
2. **一等内建引用**(编译器,机器已存在 `emitBuiltinMethodRefClosure`/`emitMemoizedBuiltinRef`):(a) `Function.prototype.call/apply/bind` 值读 + method-ref 闭包 `.bind`(仿 members.js:852 Stage A);(b) 扩 `NamespaceStaticRef`(members.js:64)加 `Object.getOwnPropertyDescriptor/defineProperty/create/freeze`(运行时 helper 已存在 object/index.js:4946);(c) 错误构造器作 memoized 闭包带 `.name`(compileIdentifier members.js:342/437),`thrown.constructor` 返回同一闭包(`instanceof TypeError` 内联 operators.js:817 已按名匹配)。**预估合计 +250-350**。
3. 类 生成器/异步生成器方法提取(functions.js 分派 + coroutine.js):提取的原型引用须为可调用闭包,一个修复覆盖 ~570 测试(两个最差目录)。
4. 函数/内建自有属性反射 + 属性强制(object/index.js `_object_getOwnPropertyDescriptor`/hasOwnProperty/flags):解锁剩余 ~600 + 182 Object attr。工程量大但局部化。
5. 解析器:负面解析头部项(delete 早错、类字段 super/arguments、生成器中 yield 保留字、use-strict+非简单参数 ≈110)+ 解构 COMPILE_FAIL(~70)。
6. Quickies:`typeof 未声明`、严格 this、ToPrimitive 原型链 toString(coercion.js)。

**item 1 + 2 单独即可达 28% S1 目标;item 3 是其后最大单一语义簇。**

---

## 波次 2 — 实施规划(2026-07-26 派发,5 个 worktree 隔离 agent 运行中)

状态:W-A/W-B/W-C/W-D/W-E 已并行派发,各在隔离 worktree 内实施 + 验证,产出 patch 到 scratchpad。主控待全部返回后按互斥文件顺序 `git apply` 到 dev,再跑一次权威全链 gen1==gen2==gen3 + fixtures 作合并门禁。

集成进度:
- **W-C 完成**(2026-07-26):11 项安全缺陷全修,fixtures 380/0,patch 干净可 apply 到 dev(compiler/index.js + crypto.js + zlib.js)。timingSafeEqual 常量时间、GCM tag 长度校验+常量时间、scrypt/熵源/HKDF/PBKDF2/IV 全改硬失败、zlib inflate EOF 灭死循环(15s 超时验证)、解压炸弹输出上限、`ar` 命令注入改 execFileSync(注入 marker 验证)。
  - 副发现(超出范围,未改):**全局 `Buffer.from(string)` 在原生目标崩溃**——buffer.js 预存 bug,与本批无关,列入 Wave 3 待查。
- **W-B 完成**(2026-07-26):typedarray/index.js 全部边界检查 + TypedArray-from-object,fixtures 380/0,patch 干净可 apply。OOB **写**原语已闭合(setFloat64 越界抛 RangeError、`a[100000]=x` 变 no-op)、`new Int8Array({length:3,...})` 修正、slice 越界 clamp、`_typed_array_new` 长度溢出守卫。TypedArray test262 CRASH 56→54(崩溃转 FAIL,无 PASS 回退)。
  - **协调缺口(重要)**:直接 `ta[i]` 元素**读**内联在 `runtime/core/subscript.js`(W-A 的文件),未走 `_typed_array_get`,故多数 TypedArray SIGSEGV(内联越界读)仍在。修法:在 subscript.js 的 TypedArray 读路径加边界检查(越界返 undefined)。**已交由 W-A 追加**(W-A 拥有 subscript.js,避免文件冲突)。此前 W-B 的 `_typed_array_get` 守卫已保护所有内部方法调用者(indexOf/includes/join/sort/slice 等)。
- **W-E 完成**(2026-07-26):promise.js 四个组合子加参数守卫(非数组 reject TypeError),fixtures 380/0,patch 干净可 apply。Promise test262 **CRASH 25→5(−20),PASS 16→26(+10)**。
  - **运维教训(重要)**:worktree agent 共享 `refs/stash`,W-E 的 `git stash pop` 误取了另一 agent 触及 subscript.js/object/index.js 的 stash 并 drop(dangling 1d0ed15),W-E 已恢复自身改动。**风险**:W-A/W-D 若也用 stash 做 before/after,其工作树可能被污染。集成时须逐一核验 W-A/W-D patch 含预期文件与内容;必要时从 dangling commit 恢复。主 dev 树本身干净未受影响。
- **W-D 完成**(2026-07-26,FP-sensitive 批,**已过全链定点门禁**):lang/lexer + lang/parser,fixtures 380/0,**gen1==gen2==gen3 字节一致(MD5 f06ba1ca…)**,patch 干净可 apply(4 文件,与其他批互斥)。未终止正则死循环(`\0` 哨兵,1ms 报错)、解析器递归上限 1000(5000 层 `(`/`{` 抛 SyntaxError 而非 SIGSEGV)、三项早错(strict delete 裸变量 / 生成器 yield 绑定 / use-strict+非简单参数)。language test262 **PASS +20 / FAIL −20**,无回退。yield 广义保留字绑定与解构 COMPILE_FAIL 长尾按指示推迟(FP 风险)。
  - **工具发现**:`scripts/bootstrap-gate.sh` 无法在 worktree 内跑——`mkdir .git/bootstrap-gate.lock` 因 worktree 的 `.git` 是 gitlink 文件而 ENOTDIR,永久 spin。W-D 手工跑了等价链。**主控的权威集成门禁在主 dev 树跑(`.git` 是真目录)不受影响**。

## 集成收敛检查(2026-07-26)

四个已完成批次(W-B/W-C/W-D/W-E)patch 触及文件完全互斥,无冲突,均干净 apply 到 dev:
- W-B: runtime/types/typedarray/index.js
- W-C: compiler/index.js, runtime/node/crypto.js, runtime/node/zlib.js
- W-D: lang/lexer/index.js, lang/parser/{index,expressions,statements}.js
- W-E: runtime/async/promise.js
- W-A(完成): runtime/types/object/index.js, runtime/core/subscript.js

- **W-A 完成**(2026-07-26,最高杠杆):object/index.js `_object_set_entry` 把 0x7FFE/TYPE_ARRAY 路由到新 `_object_set_array`(canonical 数字索引走 `_subscript_set` 真元素写,非索引键走 `_closure_prop_set` 侧表),mirror 读路径;subscript.js `_subscript_set` 加 null/undefined 守卫抛 TypeError。fixtures 380/0,patch 仅 2 文件(+72/−2)无外来污染。**dense stride-1 实测:built-ins/Array CRASH 586→109(−477)PASS +94;built-ins/Object CRASH 291→50(−241)PASS +21**。发现 arm64 `VReg.RET` 与 `VReg.A0` 同物理寄存器 X0,已修加载顺序。W-A 亦遇 stash 竞态并自行恢复(佐证运维教训)。

## 集成完成(2026-07-26)

**五 patch 全部 apply 到 dev 工作树(未提交,遵守"仅在被要求时提交")**,11 个源文件改动。**权威门禁在主 dev 树跑通:gen1==gen2==gen3 字节一致 + fixtures 380/380。自举定点不破。**

- 门禁输出:`[gate] OK: gen1 == gen2 == gen3 (byte-identical fixed point)` / `[gate] PASS: fixed point + fixtures 380/380`。
- **test262 端到端(stride-5,与基线同口径):1842 / 6462 = 28.51% —— 越过 S1 ≥28% 目标**。
  - 轨迹:24.82%(提交基线,过期)→ 27.00%(A2 重跑工作树,Wave 2 前)→ **28.51%(Wave 2 集成后)**。本波次净 +97 PASS(vs 27.00%),vs 提交基线 +238。
  - CRASH:480 → **235**(约减半)。COMPILE_FAIL 108 不变。
  - 全量 stride-1 亦测:8987 / 32310 = **27.81%**,CRASH 1140。
  - 分区(stride-5,vs 提交基线报告):Array PASS 121→**266**(+145)/CRASH 136→**24**;RegExp PASS 49→**93**/CRASH 48→**0**(全去崩溃,数组 expando 修复所致);Object CRASH 56→**11**;Promise PASS 15→**25**/CRASH 32→**9**;language/expressions PASS 647→666、statements 484→493(早错);TypedArray CRASH 56→**41**(写侧已修,读侧待 Wave 2.1)。

### 剩余(Wave 2.1 / Wave 3)
- **TypedArray 内联读边界检查**(subscript.js 读路径,安全 H-1 内存泄露 + ~50 崩溃):W-B 已闭合写原语与 `_typed_array_get` 内部调用者,但直接 `ta[i]` 读内联未走守卫。因当前集成未提交、worktree 基线错位,推迟到本里程碑提交后针对已含改动的基线处理,避免 base 错位冲突。
- **Wave 3 FP-sensitive 编译器一等内建引用**(A4 item 2/3,预估 +250-350):待本里程碑提交、定点绿后单独派发。
- 全局 `Buffer.from(string)` 原生崩溃(W-C 副发现)。

**收敛判断**:CRASH(A2 两轮)与 FAIL(A4)在多处同源;安全红队(A3 两轮)的 CRITICAL 与 CRASH 簇同根因。据此按「文件不冲突 + FP 分级」切分为 5 个 worktree 隔离实施 agent 并行,再由主控顺序集成 + 集成后跑权威定点门禁。

治理:每 agent 在隔离 worktree 内 —— (1) fixtures 不低于 380;(2) 编译分析给定的 gen0 复现并与 Node 对拍;(3) 跑相关 test262 目录量化增益、确认无同区回退;(4) W-D(解析器)额外在 worktree 内跑 arm64 自举定点门禁(解析器改动是唯一可能破自编译的)。集成后主控跑一次全链 gen1==gen2==gen3 作为合并门禁。严禁复制大 codegen 方法。

| Agent | 拥有文件(互斥) | 任务 | FP 风险 |
|---|---|---|---|
| **W-A** | runtime/types/object/index.js, runtime/core/subscript.js | CRASH 簇 A(数组具名属性写路由到侧表,mirror 读路径 :629 的 0x7FFE→`_closure_prop_set`)~150 转 PASS;subscript.js:365 `_subscript_set` 加 null/undefined 守卫(簇 B/D 去崩溃) | FP-safe(runtime,不动 emit) |
| **W-B** | runtime/types/typedarray/index.js | 安全 CR-1/CR-2/H-1/H-2/H-3/M-3(`_typed_array_get/set`、`_dataview_get/set`、`_typed_array_view`、`_arraybuffer_slice` 加索引边界检查 + `_typed_array_new` 长度溢出守卫)+ CRASH 簇 B(`_typed_array_from` :771 加装箱对象/array-like 分支) | FP-safe |
| **W-C** | runtime/node/crypto.js, runtime/node/zlib.js, compiler/index.js | 安全 crypto(timingSafeEqual 自实现常量时间;GCM tag 长度校验+常量时间;scryptSync/未知平台熵源/未知 hash/HKDF/PBKDF2/IV 改硬失败;randomFillSync 边界)+ zlib(`_readBit` EOF 检测灭死循环 CR-4;输出上限灭解压炸弹 CR-5)+ `ar` 命令注入 index.js:2992 execSync→execFileSync | FP-safe(均非 codegen 路径;index.js 改动仅 .a 构建路径) |
| **W-D** | lang/lexer/index.js, lang/parser/* | 安全 DoS(未终止正则 lexer:479 用 `\0` 哨兵灭死循环;解析器加递归深度上限抛 RangeError)+ FAIL 簇 6/7(delete/类字段/yield 保留字/use-strict+非简单参数 早错 + 解构 COMPILE_FAIL 语法) | FP-sensitive(须在 worktree 内跑定点门禁,确认编译器自身仍自编译) |
| **W-E** | runtime/async/promise.js | CRASH 簇 D(`_Promise_all/any/race/allSettled` :832/1003/1114/1179 加可迭代/类型守卫,非数组 reject TypeError)~32 多数转 PASS | FP-safe |

**Wave 3(FP-sensitive 编译器一等内建引用,单独推进)**:A4 item 2/3(一等内建值引用 + 类生成器方法提取),预估 +250-350,是达标后最大杠杆但风险最高,待 Wave 2 集成定点门禁绿后单独派发,每步过门禁、参数化去重严禁复制。

## 结论与回写(2026-07-26 完成)

**S1 达标**。多 agent 编排一轮完成:Wave 1 四路分析(架构/安全/CRASH/FAIL,其中三路获冗余交叉验证)→ Wave 2 五批 worktree 隔离修复 → 主控集成 + 权威定点门禁。

交付:
- test262 stride-5 **24.82%/27.00% → 28.51%**(越过 ≥28%),CRASH 480→235;stride-1 全量 27.81%。
- 自举定点不破(gen1==gen2==gen3 字节一致),fixtures 380/380。
- 安全红队 15+ 项缺陷修复(含 OOB 写原语、GCM 绕过、zlib DoS、命令注入、解析器 DoS)。
- 回写:plan.md S1 段已标达成;两条运维教训入记忆(共享 stash、worktree 门禁)。

**变更未提交**,待主人指示。剩余 Wave 2.1(TypedArray 读边界)与 Wave 3(编译器一等内建引用,预估 +250-350)已登记。

## 发版 v0.2.3(2026-07-26)

主人指示"推个版本"。cli.js VERSION 0.2.2→0.2.3;CHANGELOG 加 v0.2.3 条目;版本 bump 后重跑定点门禁仍绿(gen1==gen2==gen3,fixtures 380/380);提交 48ad72c(遵循本仓约定,不带 Co-Authored-By 尾注——接管时已从全历史剥离);annotated tag v0.2.3;推送 qorm/dev + tag 成功。

## Wave 2.1 + Wave 3 派发(2026-07-26,承接"继续")

基线现为已提交 HEAD 48ad72c(含全部 Wave 2 改动),worktree agent 从此分叉无 base 错位。两批并行(文件互斥),均禁用 `git stash`(改用 `git checkout -- <file>` 或复制到 scratchpad 做 before/after,规避共享 refs/stash 竞态):
- **Wave 2.1**(FP-safe,worktree):subscript.js TypedArray 内联**读**路径加边界检查(越界返 undefined),闭合安全 H-1 内存泄露 + 清 ~41 TypedArray 崩溃。
- **Wave 3**(FP-sensitive,worktree,须 in-worktree 过定点门禁):编译器一等内建值引用(A4 item 2)——`Function.prototype.call/apply/bind` 值读、错误构造器作 memoized 闭包带 `.name` + `thrown.constructor`、扩 NamespaceStaticRef;解锁 propertyHelper.js/assert.throws,预估 +250-350。保守优先,破定点即回退。

**W-3 完成**(2026-07-26,Wave 3,**已过全链定点门禁**):落地子修复 #1(错误构造器一等 memoized 闭包)——assert.throws 最大单一解锁。`Error/TypeError/RangeError/SyntaxError/ReferenceError/EvalError/URIError` 现读作稳定 memoized 闭包带 `.name` 侧表属性,`thrown.constructor` 在 `__asmjs_err` 品牌错误对象上派发回同一闭包。改动:members.js `emitErrorCtorRef`(~253)+ compileIdentifier(~449)+ compileMemberExpression 的 constructor 分派(~892);functions.js `emitLoadClassInfo` 守卫(~242,内建错误超类无 classinfo 槽时 destReg=0,修 `class X extends Error` SIGSEGV);operators.js 未改。**gen1==gen2==gen3 字节一致(18595856 B),fixtures 380/0**。test262 测量片(Object,Math,language/statements)PASS **662→705(+43)**,statements +42(assert.throws 密集),无新 CRASH/COMPILE_FAIL。
- **保守放弃 #2/#3**(理由充分):#2 `Function.prototype.call/apply/bind` 需通用函数调用运行时 helper(`_fn_call`/`_fn_apply`/`_reflect_apply` 不存在),超范围;load-only stub 不能让 `verifyProperty` 工作,只增风险。#3 `Object.*` 值读被 #2 门控(propertyHelper.js 仍在 `Function.prototype.call.bind(...)` 行加载即抛)。故 **propertyHelper.js 的 682 测试尚未解锁**,需后续运行时 `_fn_apply` 工作(登记为下一杠杆)。

## Wave 2.1 + Wave 3 集成(2026-07-26)

W-A1(subscript.js)+ W-3(members.js/functions.js)互斥,apply 到 dev,**权威门禁绿:gen1==gen2==gen3 + fixtures 380/380**。**test262 stride-5:1979/6462 = 30.63%(28.51%→30.63%,+137 PASS)**,CRASH 235→236(持平)。错误构造器修复在全量的收益远超测量片 +43(assert.throws 遍布全套)。

## Wave 4 派发(2026-07-26,承接"继续推进",基线 bcd97f2 / v0.2.4)

三批并行,文件互斥,均禁用 `git stash`:

| Agent | 拥有文件 | 任务 | FP 风险 |
|---|---|---|---|
| **W-4** | runtime/core/jsvalue.js, compiler/expressions/members.js, compiler/functions/functions.js | **本阶段最大杠杆**:通用函数调用运行时 helper `_fn_apply`(复用 jsvalue.js:679 既有 magic 分派 invoker + `_bound_tramp` 绑定闭包布局)+ `Function.prototype.call/apply` 一等值化 → 解锁 propertyHelper.js(~682 测试);若前两步定点绿再扩 NamespaceStaticRef 的 `Object.*` | FP-sensitive(须 in-worktree 过定点链) |
| **W-5** | runtime/types/typedarray/index.js | TypedArray 剩余 41 崩溃(原型方法/harness 簇:copyWithin/every/filter/findIndex 经 testWithTypedArrayConstructors)聚类归因 + 修头部根因 | FP-safe |
| **W-6** | runtime/node/buffer.js | 全局 `Buffer.from(string)` 原生崩溃(import 形式正常)根因定位 + 修;根因若在范围外(编译器全局标识符解析/模块 shim 接线)则只出精确诊断不越界改 | FP-safe |
| **W-7** | runtime/core/process.js, runtime/core/print.js | 未捕获异常零诊断(`_throw_unwind_exit` 裸 exit(1))→ 输出 `Uncaught <Name>: <message>` 到 **fd 2**(不污染 stdout,fixtures 比对 stdout) | FP-safe |

**W-6 完成**(2026-07-26,**诊断型交付,拒绝越界改**):根因**不在** runtime/node/buffer.js,而在编译器:
- `compiler/index.js:1823` `_injectImplicitGlobalImports` 的 `IMPLICIT_GLOBALS` 表**遗漏 `Buffer`**(仅有 URL/URLSearchParams/btoa/atob),故不注入合成 import,buffer.js 根本不进模块图。
- `compiler/expressions/members.js:607` `compileIdentifier` 兜底把无法解析的名字编成 `movImm(RET, 0)`,于是全局 `Buffer` === 裸整数 0,与未声明标识符不可区分(实测 `typeof Buffer` → "number",与 `typeof Zork` 同)。
- 症状非 SIGSEGV,而是 `TypeError: not a function` 被运行时**静默吞掉**(见下 W-7)。仓库自身 `compiler/index.js:13` 早有绕行注释"全局 Buffer 在编译产物里解析有问题,具名导入才拿到真实类"——本次定位了该注释背后的真因。
- 七种全局形式(from(str)/alloc/from([..])/concat/isBuffer/hex/new Buffer)同一根因全坏;`new Buffer(n)` 最险:不抛错,静默产出空对象 → 数据静默错误。
- **主控已采纳其一行修复并自行 apply + 门禁**:`IMPLICIT_GLOBALS` 加 `Buffer: "buffer"`。实测七种形式与 Node 逐字一致,遮蔽保护仍在(用户自定义 `class Buffer` 仍优先),**gen1==gen2==gen3 + fixtures 380/380 通过**。

**W-7 完成**(2026-07-26):未捕获异常现输出 `Uncaught <Name>: <message>` 到 stderr 后再 exit 1。实现要点(process.js,print.js 未改):`_throw_unwind_exit` 前 call 新 `_uncaught_report`(:625-681);**复用既有整条打印链**(`_print_value_no_nl` 已把 `__asmjs_err` 品牌对象经 `_error_to_str` 渲染为 "name: message"),因该链硬编码 fd 1 且无可参数化入口,故用 `dup2(2,1)` 把 fd 1 重定向到 stderr(进程随即退出,无需还原)——**未新写也未复制格式化器**(遵守去重铁律);`_uncaught_reported` 重入位保证报告自身若再抛不递归回抛出路径;`_exception_value==0` 降级为 `Uncaught exception`;wasi/windows 无 dup2 保持静默(宁可无诊断也不污染 stdout)。
- 实测覆盖:Error/TypeError/RangeError/子类/裸值(42/"str"/{}/数组/undefined)/generator throw/穿 finally/message getter 抛错(不挂不递归)/`({}).f()` 分诊原案 → `Uncaught TypeError: not a function`。
- **流分离已由主控独立复验**:`2>/dev/null` 只剩 `x`,`1>/dev/null` 只剩 `Uncaught RangeError: r`,两者 exit 1。fixtures 380/0(无 stdout 比对 fixture 受影响)。
- 遗留(范围外,预存):spawned coroutine 逃逸异常走 `runtime/async/coroutine.js:1093`,打印 `panic: ...` 到 **stdout**,同样污染问题,待后续单独处理。

**主控集成**(Buffer 全局修复 + W-7):**gen1==gen2==gen3 + fixtures 380/380 通过**。

**W-5 完成**(2026-07-26,取证型交付):把 41 个 TypedArray SIGSEGV 的崩溃 PC 逐一符号化(编译器 `asm.labels` + Mach-O `__text` vmaddr 建映射)后全部归因:

| 簇 | 根因 | 数量 | faulting symbol |
|---|---|--:|---|
| **A** | **`typeof <未声明全局>` 返回 "number" 而非 "undefined"** → harness `testTypedArray.js` 的 `if (typeof Float16Array !== "undefined")` 探测把垃圾值 push 进构造器表,随后 `new Float16Array(...)` 在 `compileDynamicNew` 解引用 NULL | **35** | `_dnew_notcl+0x8` |
| B | `%TypedArray%.prototype.lastIndexOf` 不在编译器 TA 方法表 → 落到 `_array_lastIndexOf` 按普通数组 `data_ptr@24` 走 typed 布局 | 2 | `_array_lastIndexOf_loop+0x18` |
| C | `_object_has`(hasOwnProperty/`in`)无 TypedArray 守卫:把 TA `length@8` 当 count、TA 内联数据当 `props_ptr@32`,**把元素值当指针解引用**(fault addr `0x4044800000000000` 即 float64 的 41.0) | 2 | `_object_has_loop+0x18` |
| D | `%TypedArray%.prototype.set(nullish/primitive)` — `_ta_set` 无条件读 `srcLen` | 1 | `_ta_set+0x44` |
| E | `Object.getPrototypeOf([][Symbol.iterator]())` | 1 | `_object_getPrototypeOf_tag_ok+0x40` |

**关键收敛**:簇 A(35/41)与 W-6 的 Buffer 根因**同源**——均为 `compileIdentifier` 对无法解析名字兜底 `movImm(RET,0)`;A4 的 FAIL 分析亦列 `typeof 未声明→"number"` 为跨切廉价 bug。三路独立分析指向同一处编译器缺陷。

W-5 范围内只有簇 D 可修,已修 3 项(`_ta_set` 规范守卫 tag 分派 nullish→TypeError/offset<0→RangeError;`_dataview_new` 接收者守卫;`_arraybuffer_bytelength` 守卫)。fixtures 380/0;TypedArray CRASH 42→41(仅 −1,**因簇 A 掩盖全部信用**)。W-5 用**受控 what-if 实验**证明其修复真实:文本移除 harness 的 Float16Array push(模拟正确 typeof)后,HEAD 为 10 PASS/11 CRASH,带其补丁为 **11 PASS/10 CRASH**——`set/array-arg-return-abrupt-from-toobject-offset.js` 成为真 PASS。
- 自觉规范偏差(已注释):`_ta_set` 对 srcLen **clamp** 而非溢出抛 RangeError,因 `ta.buffer` 在动态构造 TA 上返回 undefined(编译器 `.buffer` 分派需静态 `inferObjectType`),真抛会使一测试 PASS→FAIL;完全不设界则两测试 FAIL→CRASH(array-like length getter 返巨值致无界循环)。clamp 是唯一零回退变体,且越界写已被 `_typed_array_set` 边界守卫丢弃,内存安全不受损。

**W-8 派发**(承接 W-5 的"最大剩余杠杆"):runtime/types/object/index.js 的 `_object_get_ptrscan` / `_object_has_loop` 加非属性容器(TypedArray/DataView/ArrayBuffer)类型字节守卫。W-5 抽样 8/37 个 DataView 崩溃全部是同一 `_object_get_ptrscan+0xc`,预计覆盖 ~37 DataView + 2 TypedArray 崩溃。

**待 W-4 返回后处理**(需 members.js,当前 W-4 持有):`typeof 未声明标识符` → "undefined"(**35 崩溃 + 全套特性探测解毒**,最高优先)、`compileDynamicNew` 非构造器守卫(expressions.js:1782)。

**W-4 完成**(2026-07-26,**本阶段最大杠杆,已过定点链**):**propertyHelper.js 现完整加载**。
- 通用函数调用 helper(jsvalue.js:882-1039,新 `generateFnProtoInvoke`):`_fp_call_tramp`(参数下移一格 + argc 重算 + 尾槽填 undefined,避免调用点残留垃圾)、`_fp_apply_tramp`(从装箱数组读入 5 槽)、二者 `jmp` 汇入**单一共享分派点** `_fn_invoke_tail`(复用 `_validate_callable` 守卫,按 magic 分派同 `_bound_tramp`/`_aref_invoke_cb`)——**未复制任何大 codegen 方法**(遵守铁律)。ABI 参数窗 A0-A4,故 `.call` 最多转发 4 参、`.apply` 最多 5 参(与既有 `_bound_tramp` 同类截断)。
- `Function.prototype.call/apply` 一等值化(members.js:1030-1054,memoized 槽 + 静态原型链守卫 + 遮蔽检查);`NamespaceStaticRef` 扩 `Object.getOwnPropertyDescriptor/create/freeze` + `Array.prototype.push`(propertyHelper 在步骤 2 后正好死在这行)。
- 两处崩溃守卫(修其自测出的 8 例 FAIL→SIGSEGV 新回退,收回 7 例):`_fn_invoke_tail` 接收者卫生(裸标识符 `Object`/`Array`/`Function` 编译成裸哨兵 1/2/3,与堆指针不可区分,下游解引用地址 2 段错;仅在此新路径归一为 undefined)、`_fpg_arr_push` tag 检查。
- 保守放弃:`Object.defineProperty` 作值(无通用运行时 helper,编译期从描述符字面量分解,唯一运行时入口是 proxy trap 路径;写一个超出许可文件范围)、`Function.prototype.bind` 作值(需运行时合成绑定闭包,propertyHelper 不需要;`f.bind(...)` 调用形式不受影响且已验证)。
- 数字:`built-ins/Object,Math,Array --stride 5` **452→504(+52,33.68%→37.56%)**,其中 Object 149→201;广扫 `--stride 20`(含 language/)**490→517(+27),0 PASS 回退,0 新崩溃**。fixtures 380/0,**FIXED_POINT OK(gen1==gen2==gen3)**。
- 残留:`defineProperty/15.2.3.6-4-581.js` FAIL→CRASH,已独立复现为 `obj[name]`(变量键)读装箱原始值接收者段错,属 subscript.js 范畴、超范围;此前被 propertyHelper 加载即死所掩盖。

**W-8 完成**(2026-07-26,命中预测):**DataView CRASH 37→0**,`built-ins/Object` 逐位相同(零回退)。
- 根因三处同源:`_object_get` 的类型字节黑名单**独缺 `TYPE_DATA_VIEW`(14)**(DataView 块 32B `[type@0,data_ptr@8,byteOffset@16,byteLength@24]`,块尾恰为 32,故 `props_ptr@32` 读到**相邻块**、`count@8` 读到 data_ptr 天文值,Phase-A 指针扫描解引用野指针);`_object_has` 只守 `TYPE_ARRAY`(TypedArray 上把 `length@8` 当 count、内联元素数据当 `props_ptr`,把元素**值**当指针传给 `_object_key_eq`);`_prop_in` 同一个洞。
- 改法:模块头补齐具名常量 `TYPE_MAP/SET/ARRAY_BUFFER/DATA_VIEW/TA_LO/TA_HI`(**呼应 A1 的 R1 布局常量单一事实源建议**);`_object_get` 加 DataView 冷分支(`byteLength`/`byteOffset` 读 @24/@16,其余键落 notfound → undefined);`_object_has`/`_prop_in` 拆出共享索引路径并把 TypedArray 纳入,Map/Set/ArrayBuffer/DataView/Symbol 一律返 false。**无新增抛出,普通对象与 Proxy 路径逐字节不变**。
- 数字:DataView PASS 8→13/CRASH **37→0**;Object 143→143 CRASH 8→8(逐位相同);TypedArray 13/42 不变。fixtures 380/0。
- 诚实报告:TypedArray CRASH 未降(该 stride 下 42 例全是 prototype 方法故障,属 W-5 领域;分诊预估的"~2 例 hasOwnProperty 故障"在此样本未出现,但其 TA 半边已由 repro 证明)。`dv.buffer` 仍 undefined(DataView 块不存源 ArrayBuffer 引用,需加第 5 槽的布局变更,超出"加守卫不重构"授权)。`"toString" in o` 返 false 为预存缺陷(Object.prototype 不在运行时原型链上),与本次无关。

**主控集成 W-5+W-4+W-8**:**gen1==gen2==gen3 + fixtures 380/380 通过**。
- 注:首次全量测量因中途 apply W-8(每个用例现编译,源码变动会污染结果)已主动中止,重跑一次干净测量。

## Wave 7 派发(2026-07-26,基线 v0.2.7 / 6e35933)

四批并行,文件互斥,全部承接前几波 agent 自己定位并主动留下的杠杆:

| Agent | 拥有文件 | 任务 | FP 风险 |
|---|---|---|---|
| **W-18** | compiler/functions/functions.js, compiler/expressions/members.js | 内建命名空间物化为真运行时对象(~150 个 Object FAIL)。`typeof Math` 现为 "number"、`gOPN(Math).length` 为 0。以 **Math 为试点**(纯静态无构造器语义),**必须保持 `Math.abs(x)` 调用快路径不变**(改成动态属性加载即性能回退且可能破定点);可选延伸 JSON;明令不碰 Object/Array(带构造器语义,风险高) | FP-sensitive |
| **W-19** | compiler/async/async.js | 生成器 stub **参数急切绑定**:规范要求 FunctionDeclarationInstantiation 在**调用时**执行,`function* g({}){}; g(null)` 应立即抛 TypeError。v0.2.6 的 22 例 dstr 回退即此根因(前 agent 已精确定位在 `emitGeneratorStub` 的 `_generator_new` 之前,并主动不做)。**必须保持函数体惰性**(急切跑体是更严重的回退) | FP-sensitive |
| **W-20** | runtime/types/object/index.js | `_object_get` 缺 `0x7FFC` 字符串接收者路由(`f(x){return x["1"]}` 传字符串得 undefined);次要:`Object.prototype` 不在运行时原型链(`"toString" in o` 为 false)——明令只做窄版或报告,禁止强推原型链大改 | FP-safe |
| **W-21** | lang/parser/statements.js, compiler/functions/statements.js | 参数位 rest 模式目标(~32),**parser+codegen 联合修**。前 agent 已实现 parser 半边但**主动回滚**(codegen 只认 `SpreadElement(Identifier)`,`function f(...[a,b]){}` 编译通过却什么都不绑),NOTE 留在 statements.js:272。**明令禁止只落 parser 半边**,验收看**绑定值**而非能否解析 | FP-sensitive |

## Wave 5 收口(2026-07-26,四批全部集成,门禁绿)

**W-11 完成**(API 中断后续跑恢复):**最有价值的贡献是"先复现再动手"**——任务书列的 5 个缺口中 **3 个在 v0.2.5 已修**(`gOPD(fn,"name"/"length")` 正确、writable/configurable 强制正确、原型访问器正确),我的任务书基于过期分析,它核实后未去"修"正常代码。
- 落地 4 项(object/index.js):`_js_prop_key` 补 ToPropertyKey(bool/null/undefined/object/array/function → `_valueToStr`);`_object_keys` 经共享前导 + S5 过滤位复用为 `_object_own_keys`,`_object_gopn` 委托之(**加第二入口标签复用同一枚举体,未复制 codegen**);`_object_getPrototypeOf` nullish→TypeError、无原型→`_js_null`、原始值→undefined(此前返裸 0 即浮点 +0.0);`gOPD` 键经 `_js_prop_key` 归一。
- 数字:**built-ins/Object PASS 201→212(+11),FAIL −9,CRASH −2**;Math/Array 零变动。fixtures 380/0。
- 诚实标注:`_js_prop_key` 那一项在这三个目录**净零**,它主动说明"保留是因为对拍 Node 16 项属性操作均正确且守卫复现干净,但这是中心归一器,若要最小爆炸半径这是最该先丢的一项"。
- **指出最大剩余杠杆(编译器侧)**:`Object.defineProperty` **只处理对象字面量描述符**(functions.js:3513-3524 从 AST 抽取 get/set/value/writable/...,动态描述符静默变成 `value=undefined, attrs=0`),独占 **~260/469 个 Object FAIL**(defineProperty 168 + defineProperties 92 + create 44);内建命名空间(Math/Object/Array)根本不是运行时对象(`typeof Math` → "number"),再占 ~150。

**W-12 完成**(API 中断后续跑恢复,**已过定点链**):
- **Fix 1 根因漂亮**:Pratt 循环是 `while (precedence < peekPrecedence())`,故 `parseExpression(Precedence.ASSIGN)` **永远吃不掉赋值运算符**(`3 < 3` 为假)。所有产生式为 `AssignmentExpression` 的语法槽都误传 `ASSIGN` 而非 `ASSIGN - 1`,共 **19 处**(三元 consequent、对象/数组模式默认值与计算键、字面量 spread、yield 参数、`import(...)`、类计算键与字段初始化器、函数参数默认值...);仓内已有 3 处写对的 `ASSIGN - 1` 正是佐证。模板替换位改 `LOWEST`(其产生式是 `Expression`)。
- Fix 2:对象模式此前只收 `IDENT` 属性名,现支持字符串/数字字面量与保留字键(字面量键无简写形式,故要求 `: target`;数字经 `String(value)` 归一使 `1.0` → `"1"`,保持 codegen 走既有静态键路径)。
- 数字:**COMPILE_FAIL 81→23(−58,−72%)**,PASS +3。**它主动点破**:58 例里多数转成 FAIL 而非 PASS——解析器缺口此前**掩盖**了下游运行时缺口;+3 CRASH 亦经双版本解析器比对确认全是"HEAD 解析器直接拒绝"的文件,**无一例从可用状态回退**。探针 23/24 与 Node 一致(此前 7/24)。
- 附赠工具:**纯解析器 test262 记分板**(直接解析 20439 源文件不编译,~60s vs ~9min),测得 FALSE_REJECT 584→279。列出后续清单:`(a,b)` 括号序列表达式**根本不解析**(对自举编译器是醒目的洞)、参数位 rest 模式目标、`yield` 无 RHS 遇 `:`、`fnGenDepth` 嵌套函数未重置、`await` 作普通标识符。

**W-10 完成**(**已过定点链**,本波最大增益):
- **根因**:`compileClassMethod`(functions/statements.js:3149)**完全没有生成器处理**,只认 async 非生成器方法。`*g(){}` 的方法体被当普通函数发射,体内 `yield` 于是在**主栈上无协程**执行 `_coroutine_yield` → 首次调用即 SIGSEGV;`typeof` 报 "function" 是因为原型槽确实存着带 tag 的函数指针——**看着可调用,结构上不是生成器**。仓内两条兄弟路径(顶层 `function*`、生成器函数表达式/对象字面量方法)早已正确:发射生成器 stub + 真体挂 `<label>_gbody` 经 `_coroutine_entry` 进入。
- 修法:复用既有 `emitGeneratorStub`/`emitAsyncGeneratorStub`,**未复制 codegen**;并设 `ctx.inCoroBody` 与 `ctx.inAsyncGenerator`。因 stub 把 `A5` 存入 `CORO_THIS`,`c.g()` 与提取后 `C.prototype.g.call(c)` 走同一 stub,`this` 绑定一致。
- **主动申报越界一格**:缺陷在 `compiler/functions/statements.js` 而非任务书写的 `functions.js`,并说明为何不能用 mixin 影子法绕(`CompileContext.clone()` 不携带 `inCoroBody`/`inAsyncGenerator`)。该文件与其他 peer 不冲突,合并干净。
- 数字:**expressions PASS +33 / CRASH −8;statements PASS +49 / CRASH −4;合计 PASS +82**(32.13%→34.27%,stride-5 外推全量约 +410)。逐测试:**104 新增 PASS,6 CRASH→FAIL(改善),22 回退**。
- **22 例回退已彻底解释且属正确性提升**:全是 `class/dstr/{gen,async-gen}-meth-*-{null,undefined}`,此前**靠 bug 意外通过**(方法体当普通函数内联跑,解构 null 在调用时抛);现在正确返回生成器对象、解构延到协程体内。规范要求参数绑定在**调用**时急切执行,这个 eager-binding 缺口是**生成器 stub 机制的预存问题**(独立等价用例 `generators/dstr/obj-init-undefined.js` 在基线即 FAIL),修它要动 `emitGeneratorStub` 里 `_generator_new` 之前的参数绑定,影响全部三条生成器路径,是更大的 FP-sensitive 改动,已明确不在本批尝试。净账:22 个意外通过换 104 个真通过 + 12 个更少崩溃。
- 它实现了 spawned coroutine 的 stderr 改动但**主动回滚**:会打破金标 fixture `js-spawn-panic`(该 fixture 把 panic 串钉在 stdout),改 fixture 超其范围。

**主控补完 W-10 的遗留项**:按 `_uncaught_report` 同一约定给 `runtime/async/coroutine.js` 的 panic 路径加 `dup2(2,1)`(linux-arm64 用 dup3),并更新金标 fixture `js-spawn-panic`:stdout 只留 `main-ran`,说明串移至 stderr。实测 `2>/dev/null` 只剩 `main-ran`、`1>/dev/null` 只剩 panic 行,exit 均 1。**注意**:fixture 运行器只捕获 stdout,故 panic 文本本身不再被 fixture 断言(exit code 与前置输出仍断言)——已写入 fixture description。

**主控集成 W-9+W-10+W-11+W-12+coroutine stderr**:**gen1==gen2==gen3 + fixtures 380/380 通过**。

## 发版 v0.2.5(2026-07-26)

cli.js 0.2.4→0.2.5;CHANGELOG 加 v0.2.5;门禁绿;提交 d62812d;tag v0.2.5;**dev + main + tag 三者均推送 qorm**。
- 全量 stride-5:**2065/6462 = 31.96%**(30.63%→31.96%,+86 PASS)。分区:Object 148→201(+53)、Set 20→40、Array 266→280、Map 7→16、language/expressions 666→718、statements 493→545。
- 诚实标注:① W-8 的 DataView CRASH 37→0 **不体现在此数字**(DataView 不在被跟踪目录集内),收益真实但离线;② CRASH 235→240(+5),系 propertyHelper 加载后**新可达代码路径**暴露的既有缺陷(W-4 已预告 1 例 FAIL→CRASH),非新引入的回退。

## Wave 5 派发(2026-07-26,基线 d62812d / v0.2.5)

| Agent | 拥有文件 | 任务 | FP 风险 |
|---|---|---|---|
| **W-9** | compiler/expressions/{members,expressions,operators}.js | **三路分析共同指向的编译器缺陷**:`typeof 未声明标识符` 返回 "number"(compileIdentifier 兜底 movImm 0)→ 应为 "undefined";+ `compileDynamicNew` 非构造器守卫抛 TypeError。经崩溃 PC 符号化证明覆盖 **35/41 TypedArray 崩溃** + 全套特性探测解毒 | FP-sensitive |
| **W-10** | compiler/functions/functions.js, runtime/async/coroutine.js | 最大单一语义 FAIL 簇(~570):类 生成器/异步生成器方法非真可调用函数(`var ref=C.prototype.g; ref()` 崩/不可调用);顺带把 spawned coroutine panic 从 stdout 移到 stderr | FP-sensitive(编译器自身重度使用生成器/async,门禁即真考) |
| **W-11** | runtime/types/object/index.js | propertyHelper 解锁后新可达的**描述符/属性反射缺口**(~600 + 182):函数 name/length 作自有属性、namespace 方法作自有属性、writable/configurable 写删强制、原型访问器描述符、Object.hasOwn。Object 现 201 PASS 不得下降 | FP-safe |
| **W-12** | lang/parser/, lang/lexer/ | v0.2.3 批次主动推迟的两项:解构语法长尾(COMPILE_FAIL ~70:`[...{x}]`/`({x=1}={})`/`[k??=v]`)+ 负面解析早错(~110,仅实现精确可控子集;**禁止**广义保留字绑定拒绝) | FP-sensitive |

**W-9 完成**(2026-07-26,**已过定点链,零回退**):
- **推翻了任务书里的顾虑**:该架构**能**区分"名字解析不到"与"解析到恰好是 0 的值"——解析是纯编译期查找(getLocal/getMainCapturedVar/hasFunction/import 绑定/内建名表),故静态可判,已声明变量持 0 永不进新路径。
- 实现:members.js:134-166 两张名表(`IDENT_BUILTIN_NAMES` 镜像 compileIdentifier 的特判名;`IDENT_KNOWN_GLOBAL_NAMES` 列经其他路径支持的全局;**故意不含** Float16Array/SharedArrayBuffer/Atomics/WeakRef/Intl);members.js:433-455 新 `isUnresolvableIdentifier`(逐分支镜像 compileIdentifier,仅当会落到终末 `movImm(RET,0)` 才返 true;`with` 作用域/非 Identifier/缺 ctx 方法一律返 false 保守走旧行为);operators.js:1494 一元路径直接发射字符串 "undefined"。
- Fix 2:`compileDynamicNew` 守卫(expressions.js:1804-1830),`_dnew_notcl` 处只接受两种合法位形(裸指针 high16==0、装箱对象 0x7FFD),拒 NULL,其余抛 TypeError。Fix 2b:`compileUserClassNew`(:1029-1046)此前对完全无法解析的名字**静默伪造空对象**(`new Zork()` 悄悄成功),现抛 TypeError。
- **自我纠偏(值得记录)**:Fix 2b 初版判据过宽,实测**净损 5 PASS**(`new Boolean(true)`/`new Number`/`new String` 依赖该静默回退做 `(false||y)===y` 同一性测试);改用同一个 `isUnresolvableIdentifier` 谓词后 5 例回退全部消除,同时保留 Zork/Float16Array 抛错。偏差已注释:规范此处要 ReferenceError,但运行时仅有 `_throw_type_error` 且 runtime/ 超范围。
- 数字(4115 测试,基线同目录集重跑以保证逐测试可比):**TypedArray CRASH 41→5、PASS 13→26**;expressions PASS 718→720、CRASH 75→73;statements PASS 545→547。合计 PASS 1276→1293,CRASH **178→140**。逐测试 diff:**0 回退,17 增益(15 CRASH→PASS,2 FAIL→PASS)**。fixtures 380/0,**FIXED_POINT_OK(验证两次)**。
- 主控集成 W-9:**gen1==gen2==gen3 + fixtures 380/380 通过**。

**W-12 中断**(2026-07-26):API 连接错误致 agent 在"round 2"开始时终止,worktree 留有 3 个 parser 文件的**未验证**改动(无 fixtures/无定点/无 test262)。解析器改动是 FP-sensitive,未验证部分工作不可信。**已用 SendMessage 带上下文续跑**,指令:只做收敛与验证,不开新工作;拿不准的部分一律回滚;必须过 FIXED_POINT_OK 才算成功;全部回滚只交诊断亦可接受。

## 发版 v0.2.4(2026-07-26)

cli.js 0.2.3→0.2.4;CHANGELOG 加 v0.2.4;版本 bump 后重跑门禁仍绿;提交 ff81f63;tag v0.2.4;**dev 与 main 双分支 + tag 均推送 qorm**(吸取上次 main 漏推教训,本次同步双分支)。

---

**W-A1 完成**(2026-07-26,Wave 2.1):subscript.js `_subscript_get` TypedArray 内联读路径加边界检查(越界跳 `_subscript_get_arr_oob` 返 undefined,10 行,复用 length@8 偏移无新魔数)。9 种元素类型 repro 全对拍 Node,**安全 H-1 越界读/内存泄露闭合**,fixtures 380/0,patch 干净可 apply。**但 TypedArray stride-5 CRASH 41→41 未变**——经查这 41 项是原型方法/harness 路径(copyWithin/every/filter 等经 `testWithTypedArrayConstructors`),非直接 `ta[i]` 内联读(那些已走 bounds-safe `_typed_array_get`)。即:安全价值真实,但崩溃数收益未兑现(原假设有误)。仍纳入集成(正确的安全修复,无回退)。剩余 TypedArray 崩溃根因转入后续(原型方法/harness 簇,非本批)。

# 2026-08-01 主控编排进度

> 本文档是本轮"整体分析 → 目录规划 → 多 agent 实施 → 红队复核"的实时台账。
> 上位蓝图:`docs/PROJECT_DIRECTORY_PLAN.md`。治理铁律:`BOOTSTRAP_RULES.md` §1.5/§2/§3、`plan.md` §2。
> 历史背景:`docs/progress/2026-07-29-orchestration.md`(Wave 2–13,止于 v0.3.13)。
> 轮次起点:2026-07-31 23:48 EDT(UTC 2026-08-01 03:41)。

## 1. 当前事实基线(本轮实测,非实现者自述)

| 项目 | 当前值 | 证据 |
|---|---|---|
| 分支 / 提交 | `dev` / `51aea65`(tag `v0.3.13`) | `git log`;`node cli.js --version` = asm.js 0.3.13 |
| test262(已提交) | 3043/6462 = **47.09%**(stride-5,CRASH 169) | CHANGELOG v0.3.13 条目;`tests/test262/last_report.md` |
| fixtures | **385 manifest,权威 runner `PASS=385 FAIL=0 XFAIL=0 XPASS=0`**(含工作树 WIP) | `node scripts/run-fixtures.mjs` 本轮实测 |
| 自举平台 | macOS-ARM64(原生)+ Linux-ARM64 保持 `gen1==gen2==gen3`;x64 回退 | 07-29 台账 §1 |
| 工作树 | **未提交 WIP 4 文件 +439 行:I2(Map/Set/Promise 构造器物化)**——`compiler/expressions/members.js` +311、`runtime/types/map/index.js` +65、`runtime/types/set/index.js` +47、`runtime/async/promise.js` +16;疑为 07-31 token 配额截断的上一会话遗留。未跟踪:`.claude/`(不碰) | `git status --porcelain`、`git diff --stat` |
| WIP 语法/套件 | 4 文件 `node --check` 全过;fixtures 385 全绿(无回归) | 本轮实测 |

## 2. 整体分析

### 2.1 项目形态

零依赖自举 JS→原生 AOT 工具链(~9.6 万行 JS):`lang/`(lexer/parser/analysis)→ `compiler/`(模块图、lowering、编排)→ `vm/`(虚拟指令 seam)→ `backend/`(arm64/x64/wasm32)→ `asm/`(编码/重定位)→ `binary/`(Mach-O/ELF/PE/Wasm);`runtime/` 编译期现生成机器码(GC、NaN-boxing 值、类型内部方法、async、Node shim);`engine/` eval 片段编译。目录职责与跨层边见蓝图 §2/§3。

### 2.2 本轮在蓝图中的位置

- 蓝图 P0(GATE/TARGET/FACTS)已于 07-29 Wave 2 全部收口(见 07-29 台账 §8)。
- P1 安全失败开放(crypto/vm/--lib/TMP)已于 Wave 3 收口;test262 可复现性(pin+SHA)收口。
- 当前主线 = **test262 度量驱动收口**(plan.md S1→S4 的滚动延续):v0.3.5 43.89% → v0.3.13 47.09%,杠杆排序见 07-29 台账 §11。**下一杠杆即 I2(Map/Set/Promise 物化,预估 ~38-61 翻转),其 WIP 已在树中**。
- 同时开放的既有债(07-29 台账 §11):Date 11 例边角 SIGSEGV、解析器早期错误残留(类别 A 对象模式绑定点 + Tier 2/3)、`looksLikeCjsSource` 文本扫描误判(P2,运行期 NULL 崩)、`resolvePackageSpecifier` 损坏 package.json 静默丢弃(P2)、`--static` codegen 缺陷(P2)。

### 2.3 本轮审计新发现(主控探针实测)

I2 WIP 功能大体完备(49 例差分探针 47 例与 Node 逐字一致),但有 **1 个 P0 级缺口 + 2 个规格偏差**:

1. **P0:方法值错误接收者 → SIGSEGV(exit 139)**。物化后的原型方法闭包直连无类型守卫的运行时 helper(`_map_get` 等按 `[this+8]` 裸读):`Map.prototype.get.call({}, "k")` 等 19 例错误接收者探针,Node 全抛 TypeError,编译产物**首例即段错误零输出**。暴露面 = MAP/SET/PROMISE_PROTO_METHODS 全表 + size 访问器 + forEach/clear wrapper + Promise 静态。同型前科:Wave 10 Date 11 例 SIGSEGV、S1 崩溃簇。
2. t33 `Set.prototype.keys === Set.prototype.values`:Node `true`(同一函数对象),产物 `false`(两次独立物化)。修法:`_set_values` 闭包物化一次、两槽共享(此时 name 应为 "values",与 Node 一致)。
3. t36 `Promise()` 裸调用消息:Node `Promise constructor cannot be invoked without 'new'`(带引号),产物缺引号。Map/Set 消息已一致(t34/t35 过)。

## 3. 本轮目标与约束

### 目标

1. **Wave 1:I2 收口**——闭合 §2.3 全部三项(P0 守卫、keys/values 同一性、消息对齐),差分电池扩大到反射/变更中迭代/奇异接收者全类。
2. **Wave 2(并行,owner 互斥)**:Date 8 例运行时 SIGSEGV 加固;解析器早期错误类别 A 对象模式绑定点;`looksLikeCjsSource` AST/词法感知化(修运行期 NULL 崩)。
3. 每波独立红队二次审计;主控串行完整门禁(fixtures + `gen1==gen2==gen3`)。
4. 台账实时同步;CHANGELOG/发布待主人指示(本轮不主动 git 变更)。

### 强制约束(承袭)

- 任何源码改动必须重跑 arm64 全链 `gen1==gen2==gen3`;探针字节不变不构成安全证据;跑定点链前先 `rm -f gen1 gen2 gen3`。
- 完整 bootstrap gate 只能由主控在主树串行执行;实施 agent 仅跑局部检查(node --check、/tmp 差分、scoped fixtures)。
- 一个文件同一时刻只有一个实施 owner;只读审计不取得 ownership;红队不参与被审计实现,不接受实现者自测作为唯一证据。
- 不使用共享 `git stash`,不批量 `git add .`,不触碰 `.claude/`;未经主人要求不提交。
- 编译器/运行时源码遵守 BOOTSTRAP_RULES §1 gen1-hostile 禁令(禁 typed-array 别名读位、禁 float64 位模式整数比较、数组增长用 `.push()`、字段偏移 8 对齐、|imm|≤65535 等)。
- 增量纪律:严禁复制大 codegen 方法,增量参数化去重。

## 4. Agent 编排

### Wave 1+2 并行(4 实施 agent,owner 互斥,均禁 git 变更、禁自举链)

| Agent | 任务 | 独占文件 | 局部验证 |
|---|---|---|---|
| `i2_impl` | I2 收口:P0 接收者守卫 + t33 同一性 + t36 消息 + 扩大差分 | `compiler/expressions/members.js`、`runtime/types/map/index.js`、`runtime/types/set/index.js`、`runtime/async/promise.js` | /tmp 差分电池(功能 + 19 例错误接收者 + 反射)+ `node --check` + scoped fixtures |
| `date_impl` | Date 8 例运行时 SIGSEGV:this 类型守卫 ×5、setter ToNumber ×2、扩展年份 toString ×1(subclassing 与 Symbol.toPrimitive 涉 compiler,缓) | `runtime/types/date/index.js` | /tmp 差分(Node 对拍)+ scoped fixtures |
| `parser_impl` | 解析器早期错误类别 A 对象模式绑定点(rest/computed/colon/shorthand/shorthand-default 保留字),零误拒 | `lang/parser/*.js` | test262 目标用例正负向 + 全 fixtures(语言面改动,允许跑全套件) |
| `cjs_impl` | `looksLikeCjsSource` 改 AST/词法感知(复用 `astHasRealTopLevelEsm` 思路),修注释/字符串含 "export " 的 CJS 误判致运行期 NULL 崩;两调用点(:1464/:2816)一致处理 | `compiler/index.js` | /tmp 差分(词法矩阵:CJS 注释/字符串/模板/正则含 import/export 文字)+ node/ suite fixtures |

### 红队(实施后,4 路独立只读审计)

| Red | 审计对象 | 必查 |
|---|---|---|
| `rt:i2` | i2_impl | 19 例错误接收者复现零崩溃;keys/values 同一性;四条语法快路(new/X.m/x.m/instanceof)行为不变;git diff 无越界 |
| `rt:date` | date_impl | 8 例复现;既有 Date 功能无回归(差分);守卫不拒合法接收者 |
| `rt:parser` | parser_impl | 负向该拒尽拒、正向零误拒(fixtures + 合法语料抽样);`{ if:1 }` 属性名类不误伤 |
| `rt:cjs` | cjs_impl | 词法矩阵逐例对拍 Node;真 ESM 不受影响;NULL 崩用例修复 |

### 主控(Phase E)

串行:`git diff --stat` owner 越界核查 → 红队收口 → `rm -f gen1 gen2 gen3` → `bash scripts/bootstrap-gate.sh`(全链定点 + fixtures)→ test262 复跑(固定 pin)→ 台账同步。

## 5. 分层验收矩阵(本轮)

| 变更面 | 必跑 |
|---|---|
| runtime map/set/promise/date | Node 差分(功能+错误接收者+反射)、fixtures es 套件、完整自举定点(主控) |
| lang/parser | 负向 SyntaxError 用例、合法语料零误拒、全 fixtures、完整自举定点(主控) |
| compiler/index.js(CJS 检测) | 词法矩阵差分、node/ 套件、完整自举定点(主控) |
| 全部 | 红队二次复现;P0 零未处理 |

## 6. 风险登记

| 风险 | 等级 | 措施 |
|---|---|---|
| I2 守卫改动触及共享 helper,误伤编译期快路 | 高 | 守卫只加在 `_aref_*` 包装层/闭包表改指,快路直连 helper 不动;红队专项验证快路 |
| parser 改动误拒合法程序 | 高 | 零误拒为硬验收;fixtures 全绿 + 合法抽样;疑保守则拒做并记录 |
| 4 agent 并行同树,局部测试互相干扰 | 中 | 限定各自 scoped 测试;完整套件/门禁只由主控串行 |
| 子代理 API 不稳定(07-31 SSL/429 前科) | 中 | 超时即 resume 同一 agent;失败切片主控自接,不强行放量 |
| WIP 作者不明,隐含未完成语义 | 中 | 差分电池为验收准绳;未覆盖处记偏差,不臆测补全 |

## 7. 变更日志

- 2026-07-31(EDT):创建台账。主控完成整体分析:读取 BOOTSTRAP_RULES/plan.md/蓝图/07-29 台账/README/tests README;实测 git 状态(v0.3.13、4 文件 I2 WIP)、fixtures 385 全绿、49 例 I2 功能差分(47/49 与 Node 逐字一致,t33/t36 偏差)、19 例错误接收者探针(**产物 SIGSEGV exit 139,判 P0**)。定 4 实施 agent 并行 + 4 路红队 + 主控串行门禁的编排。
- 2026-07-31(EDT):Wave 1+2 四路实施 agent 并行派工(agent-0 i2_impl / agent-1 date_impl / agent-2 parser_impl / agent-3 cjs_impl),owner 互斥;蓝图台账指针已同步本文件。
- 2026-08-01(EDT 00:26):**agent-3 cjs_impl 完成**。改动仅 `compiler/index.js`(删 `cjsHasEsmSyntax` 子串扫描,新增 `sourceHasTopLevelEsmDecl` 词法状态机,`looksLikeCjsSource` 改据之;两调用点 :1455/:2803 经此函数天然一致)。证据:词法矩阵 31 例对拍 28 逐字节全等、3 例与 HEAD 逐字同错(解析器既有局限/错误路径差异,非新引入);652 文件差分扫描仓库源码与 fixtures 零翻转;fixtures 全量 PASS=385 FAIL=0 XFAIL=0 XPASS=0,Wave 4 两项未回退。未跑自举链(留主控门禁)。其余 3 agent 仍在跑。
- 2026-08-01(EDT 00:3x):**agent-2 parser_impl 完成**。改动仅 `lang/parser/`(statements.js +`isBindingWordToken`/`CONTEXTUAL_WORD`;expressions.js `parseObjectPattern` 5 绑定点统一走 `checkYieldAwaitBinding`+`checkReservedBinding` 双检查;rest 位词形 token 门修掉 `{...123}` 垃圾 AST)。证据:对拍 DIFF 29→4(余 4 全在划定范围外);负向该拒尽拒 THROW=0;正向零新增误拒;fixtures 全量 385/0/0/0(复跑两次一致);全仓 636 个 .js 新 parser 零解析错误;定向 test262 5 目录 483 例 PASS=281(19 个 `*-err.js` FAIL 为运行时 TypeError 语义,与本改动无关)。已知代价:test262 `obj-ptrn-elem-id-static-init-await-invalid` 由"碰巧拒"翻转为误收(1 例,根因是 Wave-11 深度机制不跨函数边界重置,包装会扩散误拒,违反零误拒铁律,故不动)。剩余缺口(数组模式侧/类静态块/let 绑定名/赋值解构路径/类方法体 strict)全部对拍确认系既有,非本次新增。其定向 test262 复跑改写的报告文件已从 HEAD 还原。剩 agent-0/agent-1 在跑。
- 2026-08-01(EDT 00:5x):**agent-0 i2_impl 完成**(含 P0 收口)。改动仅 4 个独占文件:Map/Set 守卫宏层(tag 判→掩码脱壳→堆界→类型字节→weakness,成功纯尾调零帧)+14 薄壳、clear/forEach 内联守卫;`_fmt_receiver` V8 %r 格式化;Promise 原型 3 守卫(修掉 WIP 值路径 then 丢 onRejected 的 bug)+7 静态守卫;members.js 四表改指守卫壳、`cfg.aliases` 机制(t33 `Set.prototype.keys===Set.prototype.values` 且 name==="values")、t36 消息补引号、sizeGetter 分品牌、`_reEnsureSlot` 标签去重。证据:差分电池 **49+19+39+51+25+12+612=807 例全过零崩溃**(29 守卫入口×21 接收者类型扫掠);fixtures 385/0/0/0;快路字节不变(结构性论证:new/X.m/x.m/instanceof 分支零触碰)。剩余偏差全部对拍确认为引擎层既有或已记录项,无 I2 新引入。注:00:50–00:54 树曾短暂不可编译(`_date_this_get` 断链,date_impl 执行中间态),对方已修复;I2 全部验证在树稳定后完成。剩 agent-1 在跑。
- 2026-08-01(EDT 01:0x):**agent-1 date_impl 完成,4/4 实施收口**。改动仅 `runtime/types/date/index.js`(+636/−35):this 校验族(`_date_this_ptr/get/named`、`_date_recv_desc`、`_date_write_num_rev`)接入全部 `_aref_date_*`;aref setter 真 ToNumber 原子多字段重写 + setTime TimeClip + `_date_set_part(s)` 尾部 TimeClip;`_date_toString` 全新实现(负年 "-0001" 四位式,实测 Node v25 如此,±YYYYYY 六位只属 toISOString/parse)、toISOString ±YYYYYY、parse 扩展年(拒 "-000000")、`_date_get_part` 负年 floor 修正。证据:7 组差分电池 ~340 行全同(TZ=UTC 对拍 Node v25.9.0);目标 8 例 7 翻 PASS;附带翻转 +6/−0;fixtures 全量 385/0/0/0。**新发现(编译器域,立项候选)**:零参直调 setter SIGSEGV(builtin_collection_methods.js:339)、直调 setter NaN 族 fcvtzs→0、直调 `d.toString()` 正时间戳 SIGSEGV(functions.js:4201 `_is_asmjs_err` 前导)、Invalid 直调 getter 返 1970、变量名 valueOf/toString 被闭包捕获求值错误(疑似编译器标识符特判)。期间 compiler 曾被并行 agent 短暂改坏(00:14–00:17)已恢复。
- 2026-08-01(EDT 01:0x):**Phase E 启动**。owner 越界核查通过:工作树 9 个 M 文件全部落在各自 owner 边界内(members.js+promise+map+set=agent-0、date=agent-1、parser×2=agent-2、compiler/index.js=agent-3、PROJECT_DIRECTORY_PLAN.md=主控),test262 报告文件已被各 agent 从 HEAD 还原。**4 路红队独立审计并行派工**(agent-4 rt:i2 / agent-5 rt:date / agent-6 rt:parser / agent-7 rt:cjs):均为新鲜上下文 coder,只读仓库、禁 git 变更、禁自举链,探针隔离在各自 /tmp/rt-*,要求对实现者电池抽查诚实性(≥5 例手验),发现按 P0(崩溃/劣化)/P1(新引入偏差)/P2(既有)分级,逐项 PASS/FAIL 汇报。红队清零后主控串行门禁。
- 2026-08-01(EDT 01:3x):**rt:cjs 通过(0 P0 / 0 P1)**。红队用 `git archive` 三树隔离法(HEAD / HEAD+仅被审计 diff / 完整工作树)独立复现:6 项必查全 PASS——23 例 CJS 对拍(16 例 HEAD 崩/new 修,含 NULL 崩机理独立复现)、9 例真 ESM 三树逐例相同、Wave 4 两 fixture 不回退(suite node 104/0、modules 28/0)、自写扫描器对 589 仓库文件 + 103 探针文件独立重跑差分(仓库零翻转;探针 39 处翻转全为修复方向)、diff 无夹带、§1 合规。5 例 P2 全部三树对照证明系既有。实现者探针抽查诚实(自报 3 FAIL 未粉饰)。
- 2026-08-01(EDT 01:4x):**rt:i2 核心通过(P0 崩溃确凿修复、132 例零崩溃、t33 达成、快路与 HEAD 产物逐字节一致、§1 合规、探针诚实),但判 3 个 P1(均消息文案级,无崩溃)**:
  - F1:t36 直调路径未修——`Promise(fn)` 直调被 `compiler/functions/functions.js:1627-1636`(HEAD 既有)通用拦截,消息 `Constructor Promise requires 'new'` ≠ Node 逐字;值路径已正确;Map/Set 直调通用消息恰与 Node 逐字相同故只 Promise 露馅。
  - F2:RegExp 接收者 `_fmt_receiver` 打 `#<Object>`(Node `[object RegExp]`)——运行时 regexp 经 `__RE_new` 是普通对象,`_fr_regexp` 分支不可达。
  - F3:原型系接收者打 `#<Object>`(Node 沿原型链打 `#<Map>`/`#<Set>`/`[object Object]`)——物化原型无品牌、无原型链。
  处置:待 rt:date/rt:parser 收尾后 resume agent-0 修 F1(特许扩边界至 functions.js 单点)+F2/F3 尽力修,不可修部分转声明偏差;再复审。P2 四项(finally 微任务序、console.log 半截输出、forEach 内 clear 遍历、clear 快路返回值分叉)均 HEAD 逐字节对拍确认既有,入台账。
- 2026-08-01(EDT 01:5x):**rt:date 通过(0 P0;8 例目标全闭合、零劣化;§1 合规;探针诚实),判 2 个 P1(均在本轮新代码内,valueOf 副作用可观测)+ 1 个建议顺手修**:
  - P1-1:`_aref_date_sp*` 的 `_nan` 支路无条件写回 NaN,覆盖 valueOf 内 `d.setTime(1000)` 的修复(规范:t 为 NaN 时返 NaN 且不写 [[DateValue]])。
  - P1-2:`_date_set_parts` 在 `_number_coerce` 之后才读时间戳(规范:ToNumber 前读 t),valueOf 内改时间可观测。
  - P2-1(建议顺手修):`_dgp_dow` 负分数日截断未 floor(HEAD 既有),但**新 toString 继承该错**(`new Date(-1).toString()` weekday 错),修复暴露面变大。
  另纠正实现者声明一处:零参直调 setter 实测是 `Uncaught TypeError: not a function`(exit 1)而非 SIGSEGV,根因(builtin_collection_methods.js:339 零参门)属实。
  处置:rt:parser 收尾后 resume agent-1 修 P1-1/P1-2/P2-1(date/index.js 内),再复审。P2-2~P2-8 全部 HEAD 逐字确认既有,入台账。
- 2026-08-01(EDT 02:0x):**rt:parser 5/6 必查项 PASS,但硬验收"正向零误拒"FAIL:1×P0 + 1×P1**(643 例电池 + 675 文件语料三方对拍 node/worktree/HEAD;实现者探针诚实,其电池未覆盖 BIGINT 键故漏网):
  - P0:BIGINT 字面量键 `var {1n: a} = o` 新误拒(3 变体;node 与 HEAD 均收)。修法:键分支收 `TokenType.BIGINT`,`keyNeedsColon=true`,键按数值字符串归一("1n"→"1",勿复刻 HEAD 的 "1n" 错义)。
  - P1:`let` 作绑定名在 let/const/catch 词法声明下被新收(9 变体;node/HEAD 恒拒)。修法:声明种类上下文传入或调用点补查;对照项 `function f({let}){}` 与 sloppy `var {let} = o` 不许误拒。既有缺口 `let let = 1` 是另一路径,不扩散。
  - P2(声明外但 HEAD 同,入账):嵌套普通函数不重置生成器/异步上下文、import/export 作 sloppy 绑定目标、名为 undefined/yield 的绑定语义(yield 绑定编译产物 SIGSEGV 用既有语法 `var yield = 13` 即可复现,走既有 parse 路径,非本 diff 引入)。
- 2026-08-01(EDT 02:0x):**P0/P1 清零派工**:resume agent-0(F1 特许扩边界至 `compiler/functions/functions.js` 单点特判 Promise 直调消息;F2/F3 尽力修,不可修转声明)、agent-1(P1-1/P1-2/P2-1,date/index.js)、agent-2(BIGINT 键 + lexical-let,lang/parser/)。三者文件互斥;各跑红队电池回归 + fixtures 全量;完成后再派红队复审。
- 2026-08-01(EDT 02:3x):**agent-0 三个 P1 全部修复**:F1 functions.js:1633 三元特判(Map/Set/WeakMap/WeakSet 原模板字节不变);F2 发现可靠品牌——`__RE_new` 产物持 `__isRegExp` 隐藏自有槽,`_fmt_receiver` 镜像引擎 `_object_proto_toString` 既有判别法 → `[object RegExp]`;F3 三原型单例身份比较 → `#<Map>`/`#<Set>`/`#<Promise>` + catch/finally 对 Promise.prototype 按 V8 then 文案特判(Node 实测:RegExp.prototype/Date.prototype 本就打 `[object Object]`,修复面严格限定三原型)。验证:自有 7 组电池 + fix123 51 例 + 红队电池全 MATCH(余 DIFF 逐一与红队存档的 HEAD 基线二进制逐字节核对为既有);fixtures 385/0/0/0。残留声明:手工伪造 `{__isRegExp:1}` 误判(与引擎自身品牌检查同类);`Object.create(Map.prototype)`/`Object.create(null)` 无原型链不可辨维持 `#<Object>`。待复审。
- 2026-08-01(EDT 02:5x):**agent-2 P0+P1 全部修复**:P0 键分支新增 BIGINT 分支(与 STRING/INT/FLOAT 并列,`keyNeedsColon=true`,键按数值字符串归一 `String(parseBigIntLiteral().value)`——`1n`→"1"、`0x1n`→"1"、`1_000n`→"1000",gen1 自举安全;绑定位仍拒 `{x: 1n}`/`{...1n}`);P1 `lexical` 标志沿模式递归透传(刻意不走 parser 状态字段,避免泄漏进默认值表达式/嵌套形参),`checkLexicalLetBinding` 接入 let/const/for-of/for-in/catch 五入口,`parseArrayPattern` 只透传不加检查(数组侧缺口维持上轮口径)。验证:红队 643 例电池 17 个 flag 全部"同 HEAD"(0 新增)、675 文件语料 NEW-REJECT=0/NEW-ACCEPT=0、BIGINT 键程序端到端与 node 逐字节一致、fixtures 385/0/0/0。待复审。剩 agent-1 在修。
- 2026-08-01(EDT 03:0x):**agent-1 两 P1+dow 全部修复,3/3 清零完成**。P1-1:`_nan` 支路按"强转前 Invalid 标志"分流,强转前已 Invalid 只返 NaN 不 store;P1-2:薄壳化拆分(`_date_get_part_ts`/`_date_set_parts_t` 零代码复制),并**纠正规范模型**——系统化 node 探针裁决 V8 真实顺序按 setter 分流:part 1-6 全部强转前读 t;part=0(setFullYear 系)year 强转后、month/date 强转前读;P2-1:`_dgp_dow` 负分数日 floor(仿 `_dgp_days_ok` 形态),getDay/getUTCDay/toString 三获益。编译器直调路语义逐字节不变(薄壳)。验证:我方 7 组电池全绿、红队 a1/a2/a3/a9/c1 MATCH、fixtures 385/0/0/0、test262 九目录与前轮持平。直调路同类问题维持编译器域台账。待复审。
- 2026-08-01(EDT 03:2x):**复审 rt:i2 通过**(agent-4):F1/F2/F3 逐项 FIXED——t36/p1-map/p2-set/p3-promise/rx 等电池升 MATCH,转声明项行为与声明逐字相符;全量回归无新 DIFF(余项均首轮已证既有);崩溃扫描 32 产物零命中;非 Promise 构造器直调消息与 HEAD 产物逐字节一致;`__isRegExp` 槽为 regexp_shim 既有(该文件未改动);diff 无夹带(functions.js 仅一处三元)。无新 P0/P1。
- 2026-08-01(EDT 03:4x):**复审 rt:date 通过**(agent-5):P1-1/P1-2/P2-1 逐项 FIXED;83 行顺序矩阵与 node 零差异;setFullYear 顺序模型经红队独立探针裁决属实(part=0:year 强转后读 t、month/date 强转前读、NaN→+0;part 1-6 全强转前读)——注:该 part=0 行为与 ES 规范字面步骤(t 先读)有出入,但与语义基准 node 一致,按本项目"node 为基准"口径验收;首轮电池全量重跑无新 DIFF、直调路与 HEAD 留档逐字节一致、无夹带、§1 合规。无新 P0/P1/P2。剩 rt:parser 复审在跑。
- 2026-08-01(EDT 03:5x):**复审 rt:parser 通过**(agent-6):P0/P1 逐项 FIXED——BIGINT 键归一 10 例 AST dump 与 node 语义键一致(含 2^64 精确 20 位串)、拒绝位(`{x:1n}`/`{...1n}`/`var {1n}`)未误伤;9 变体 lexical-let 全拒、对照项零误拒;正确红利:透传使 `let [{let}]`/`let {...let}` 等嵌套形态一并转为拒(HEAD 曾误收);643 例电池 agree 625→626、17 个 mismatch 与上轮逐一相同零新增;675 文件语料 NEW-REJECT=0/NEW-ACCEPT=0;diff 无夹带。新发现 2 例均判 P2 既有(表达式引用位 LET token 无 prefixParseFn;对象字面量大数 INT 键保留原文,HEAD 同)。**4/4 红队复审全部通过,P0/P1 清零。**
- 2026-08-01(EDT 04:0x):**主控串行门禁 PASS**。门禁前 owner 终检:10 个 M 文件全部在授权边界(functions.js 经 diff 确认仅 :1633 一处三元特判)。`rm -f gen1 gen2 gen3 && bash scripts/bootstrap-gate.sh`:**gen1 == gen2 == gen3 逐字节定点;fixtures PASS=385 FAIL=0 XFAIL=0 XPASS=0(discovered 385 == baseline 385)**。门禁日志中 2 行 "Unhandled expression type: SpreadElement" 警告经 HEAD 对照确认系既有已知路径(expressions.js:193 与 builtin_array_methods.js:659 注释在 HEAD 均存在),非本轮引入。test262 复跑已按基线配置(pin 9e61c128、默认目录、stride-5、jobs-8)启动。
- 2026-08-01(EDT 04:1x):**test262 复跑完成,全类单调向好、零回退**。3063/6462 = **47.40%**(基线 3043/6462 = 47.09%,**+20 PASS / +0.31pt**);FAIL 3181→3167(−14);CRASH 169→163(−6);COMPILE_FAIL 69→69(0)。PASS 增量恰等于 FAIL+CRASH 减量,聚合层面无 PASS 流失;逐测试翻转清单不可考(HEAD 未提交 per-test 的 last_run.json,仅 1.2MB 工作区文件,记账限制)。区域亮点:Map 36.6%→51.2%(+6)、Promise 34.5%→42.8%(+12,CRASH 13→7)、expressions 51.2%→51.4%(+3)。**两处负向翻转已定位归因**:statements −1 PASS→FAIL = `obj-ptrn-elem-id-static-init-await-invalid`(零误拒铁律的已记录代价);String +1 CRASH = 已知非确定 String flake 簇(同代码定向复跑 86 PASS/5 CRASH vs 官方 94/2,同代码两次结果不一致即非确定性实证,与 v0.3.12 布局敏感 flake 同族)。last_report.md 与 last_run_summary.json 已由官方复跑更新(committed 产物,属预期改动;定向复跑后已从备份还原官方版)。**本轮编排全程收口:分析→规划→4 实施→4 红队→P0/P1 清零→4 复审→门禁→test262,全部通过。**
- 2026-08-01(EDT 04:3x):**主人指示"提交版本,然后继续"**。按仓库惯例执行 v0.3.14 发布:CHANGELOG.md/CHANGELOG.zh-CN.md 双语条目已写入(四个工作流 + 红队过程 + 残留归因);随后 `git add` 15 个文件(9 代码改动 + PROJECT_DIRECTORY_PLAN.md + 2 changelog + 2 test262 报告 + 新台账)+ commit + 附注 tag v0.3.14;不 push(主人未指示)。Wave 3(JSON 物化 / String.fromCharCode·fromCodePoint 方法值 / Number 静态族)随之启动。

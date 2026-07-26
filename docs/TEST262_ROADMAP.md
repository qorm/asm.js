# test262 完整支持路线图 — 从 22.25% 到完整一致

> 日期:2026-07-23(制定) · 状态:**执行中** · **当前:36.99%**(2390/6462,stride-5 子集;CRASH 175、COMPILE_FAIL 40,更新于 2026-07-26 / v0.2.9)
> 轨迹:20.55%(v0.2.1)→ 22.25%(v0.2.2)→ 28.51%(v0.2.3)→ 30.63%(v0.2.4)→ 31.96%(v0.2.5)→ 33.63%(v0.2.6)→ 35.52%(v0.2.7)→ 36.04%(v0.2.8)→ **36.99%(v0.2.9)**
> 参考:[Yuku](https://github.com/yuku-toolchain/yuku)(zig 规范一致 parser/工具链)、[Kiesel](https://codeberg.org/kiesel-js/kiesel)(zig 引擎,[20→25% devlog](https://linus.dev/posts/kiesel-devlog-1/))、[LibJS test262 仪表盘](https://serenityos.github.io/libjs-website/test262/)、[test262.fyi](https://test262.fyi/)
> 关联:plan.md S1/S4、docs/SHAPE_IC_DESIGN.md、记忆 test262-s1-progress

---

## 1. 目标与范围

**目标**:在 test262 可运行子集上达到**完整一致**(对标成熟引擎 90%+)。

**范围界定**(诚实):我们的 test262 数字基于**选定子集**——`language/{expressions,statements}` + 13 个核心 `built-ins/`(Array/Object/String/Number/Math/JSON/Map/Set/TypedArray/RegExp/Promise/Boolean/Symbol),stride=5 抽样 6462 项。**排除**:intl402(国际化,小引擎通常不做)、staging(提案)、dynamic-import/SharedArrayBuffer/decorators 等特性门(1383 项)。"完整支持" = 在此 in-scope 子集上 90%+,而非全量 ~48000 项。

**当前分类**(5024 失败 / 6462):
| 状态 | 数 | 性质 |
|---|---|---|
| FAIL | 4435 | 能编译运行但断言失败(语义缺口) |
| CRASH | 485 | SIGSEGV/SIGBUS/timeout(多为非泛型内建) |
| COMPILE_FAIL | 104 | parser 缺口 |

---

## 2. 参考项目方法论(可迁移)

**Yuku**(规范一致 parser/工具链,zig,866★):
- **test262 驱动**:以 test262 为语法一致性 oracle,AST 精确匹配 Oxc/ESTree。
- **parser 是地基**:先把语法层做到规范一致(含**早期错误 early errors**、Unicode 标识符、负向解析测试),再谈其余。其 parser→analyzer(作用域/符号/跨文件链接)→codegen 分层,各层经规范验证。
- **启示**:COMPILE_FAIL + 负向解析测试(我们 517 个 `__negative__`)正是 Yuku 的强项域——parser 规范一致是通往高通过率的**第一道门**。

**Kiesel**(zig 全引擎):4 个月 600 提交从 20%→25%;自建 test262 harness;**按根因归类失败、按依赖序修地基**(先对象模型/内建,后特性)。

**LibJS**(SerenityOS C++):**公开 conformance 仪表盘**(test262.fyi 每日跑多引擎);**逐内建系统化一致**;per-feature 期望清单(标记已知失败、追踪回归)。~60%+ 经年累积。

**共性方法论(本规划采纳)**:
1. **test262 作 oracle**(非手写测试),通过率是硬指标。
2. **公开追踪仪表盘** + per-feature 期望清单(回归防护)。
3. **按根因/特性归类,按依赖序修**——地基(对象模型/强转/函数/错误)先于特性。
4. **parser 完整性是闸门**(编译不过无从运行)。

---

## 3. 缺口全景(特性级,实测)

按 test262 特性标签归类失败(一个用例可带多标签,有重叠):

| 特性簇 | 失败数 | FAIL/CRASH/COMPILE | 依赖地基 |
|---|---|---|---|
| **核心语义(无特性标签)** | **1637** | 1353/253/31 | 对象模型/强转/相等/错误——**一切的根** |
| destructuring-binding | 949 | 880/38/31 | 迭代+属性访问+默认值 |
| async-iteration | 774 | 724/27/23 | Symbol.asyncIterator+生成器+async |
| class | 765 | 730/28/7 | 函数构造+原型+私有字段 |
| generators | 637 | 599/24/14 | Symbol.iterator+函数 |
| **负向测试(__negative__)** | **517** | 517/0/0 | **早期错误(parser+runtime)** |
| class-fields-public | 366 | 346/16/4 | class |
| default-parameters | 326 | 304/12/10 | 函数+强转 |
| Symbol.iterator | 325 | 250/73/2 | Symbol+对象模型 |
| class-methods-private | 271 | 264/4/3 | class+私有品牌 |
| TypedArray | 261 | 203/58/0 | 对象模型+缓冲 |
| class-static-methods-private | 245 | 240/1/4 | class |
| class-fields-private | 189 | 180/8/1 | class |
| regexp-unicode-property-escapes | 133 | 133/0/0 | RegExp 引擎 |
| BigInt | 119 | 107/12/0 | 数值塔 |
| Symbol.asyncIterator | 112 | 106/6/0 | async-iteration |
| object-rest | 76 | 72/4/0 | 解构+枚举序 |
| Proxy / Reflect.construct | 26 / 51 | — | 元编程陷阱 |

**结论**:最大两块是**核心语义(1637,地基不足)**与**负向测试(517,早期错误)**;特性簇(destructuring/class/generators/async ~3100)都**建立在地基之上**。修地基撬动面最大。

---

## 4. 架构地基(一切特性的前提)

test262 高通过率的真正瓶颈不是特性,是**底层语义机制**。以下六块是 1637 核心失败 + 全部特性簇的共同前提:

1. **规范对象模型**:属性描述符 `{value,writable,get,set,enumerable,configurable}`;`[[Get]]/[[Set]]/[[DefineOwnProperty]]/[[Delete]]/[[HasProperty]]` 内部方法;原型链遍历;**枚举序**(整数键升序 → 字符串键插入序 → Symbol 键);普通对象 vs 异质对象(array/string/arguments 的 length/索引 exotic 行为)。**当前:对象即字典,无描述符/无标准内部方法/枚举序为插入序——这是最大架构缺口。**
2. **类型强转**:`ToPrimitive(hint)`(valueOf/toString 顺序)、`ToNumber`/`ToString`/`ToBoolean`/`ToPropertyKey`/`ToLength`/`ToIntegerOrInfinity`/`ToObject`。当前零散在各 helper,无统一规范路径。
3. **相等与比较**:`SameValue`/`SameValueZero`/抽象相等 `==`(含对象→原语)/严格 `===`/关系 `<,>,<=,>=`(字符串词典序)。
4. **函数对象**:`[[Call]]`/`[[Construct]]`、`.length`/`.name`、`bind` 绑定函数、闭包、`new.target`、rest/default 参数、this 绑定规则。**当前:函数非一等对象(.length/.name/bind 缺),构造器语义不全。**
5. **错误处理**:Error/TypeError/RangeError/ReferenceError/SyntaxError 正确构造与 `instanceof`;throw/try/catch/finally;`error.cause`;**早期错误**(parser 在解析期抛 SyntaxError——517 负向测试)。**当前:运行时 helper 难以抛异常(异常帧契约 #38),负向测试大面积失败。**
6. **泛型内建**:数组方法对**任何类数组 this** 工作(读 length + 逐索引 `[[Get]]`)。**当前:数组方法假设真数组(0x7FFE),非数组 this 即 SIGSEGV——485 CRASH 的首因(~136 Array)。**

---

## 5. 分阶段路线图

> 产量为**估算**(基于缺口归类,实测校准);工作量为人/会话量级。每阶段过 bootstrap-gate(gen1==gen2==gen3 + fixtures + test262 只升)。

### S1 — parser 完整性 + 易修 CRASH(22.25% → 28%,**已达成并超额:36.99%**)
- **参考 Yuku**:parser 规范一致。COMPILE_FAIL **104 → 43**(v0.2.6):19 处 `AssignmentExpression` 优先级槽误传 `Precedence.ASSIGN`(Pratt 循环 `precedence < peekPrecedence()` 致永不消费赋值符)已修;对象模式支持字符串/数字/保留字键。
- **负向解析测试**:已落地 strict `delete` 裸变量、生成器 `yield` 绑定、`"use strict"` + 非简单参数、未终止正则(死循环)、解析器递归上限。仍偏宽松,余量见下 S1 续项。
- **CRASH 480 → 180**。头部根因(均已修):数组具名属性写误入对象头路径(~150,含全部 RegExp `.index` expando)、`typeof <未声明>` 返 "number" 致 harness 推入垃圾构造器(35)、Promise 组合子无可迭代守卫(32)、DataView 缺类型字节守卫(37,离线目录)、类 生成器方法无协程(体内 `yield` 跑主栈)。
- **一等内建值**:通用函数调用 helper(`_fp_call_tramp`/`_fp_apply_tramp` → `_fn_invoke_tail`)使 `Function.prototype.call/apply` 可作值读取,**test262 `propertyHelper.js` harness 首次加载成功**;错误构造器 memoized 闭包带 `.name` + `thrown.constructor`,解锁 `assert.throws`。
- **产量**:实测 **+1001 PASS(1328 → 2329)**。**工作量**:中(多 agent 编排 8 波)。
- **v0.2.7 续批(已完成)**:`Object.defineProperty` 动态描述符(此前静默退化为 `value=undefined, attrs=0`,Object PASS 193→278)、`arr["0"]` 字符串键索引(键经 `_syscall_arg` 得内容指针致恒越界,连带 `var {0:f}=a` 解构)、`Object.keys(fn)` 段错误(四个枚举器把函数值送进普通对象路径)、`for-in` 数组键返数字非字符串、`(a, b)` 括号序列表达式(根因是箭头参数启发式不回溯)。附带修出**潜伏全局缺陷**:shim import 注入把 `"use strict"` 挤离首 token,致真实编译中**顶层严格早错从未触发过**。
- **v0.2.8 续批(已完成)**:`Math` 物化为真反射对象(**仅在裸标识符位惰性物化**,三条快路径均在此之前解析,hello-world 二进制与 HEAD 逐字节一致;Math 20→27、Object 280→295);生成器参数急切绑定(仅上提可抛步骤,判据与函数体自身守卫**完全一致**故不会凭空造抛,函数体仍惰性);参数位 rest 模式目标 parser+codegen **联合**落地(含箭头形式,不支持形式改为**干净编译错误**而非静默错编);字符串接收者属性路由(`_object_get` + `_subscript_get` 双路);`gOPD` 函数值支持(附带修出 `fn.x=1` 会永久杀死 `fn.name` 的潜伏 bug)。
- **v0.2.9 续批(已完成)**:`%TypedArray%` 内建物化(**最大单簇 74 例**——`harness/testTypedArray.js` 第 1 行 `Object.getPrototypeOf(Int8Array)` 返 undefined,整个 harness 在读第一个属性时即死,测试体从未执行;TypedArray 20→53,6.9%→18.4%);String 全 ES 空白集 trim + 参数 `ToString` 强转(用户 `toString`/`Symbol.toPrimitive` 现在真的会跑**且其抛出会传播**)+ `repeat(Infinity)` 由**挂死**改为 RangeError(String 全目录 297→346);RegExp 构造期急切编译并抛 SyntaxError(须把解析器单一错误通道拆成**真语法错**与**合法但未实现**(`\p{}`)两类,否则新抛会误伤)+ 标志校验 + RepeatMatcher 捕获重置 + ES2025 重复具名组(RegExp 96→120)。
- **顺带修复测试基础设施真缺陷**:`tests/run_fixtures.mjs` 用 `/tmp/fx_<dir 末 16 个十六进制字符>` 命名产物,而 16 个十六进制字符只编码路径**末 8 个字符**,故同名 fixture 在不同 worktree 下命中同一 `/tmp` 文件;并行 agent 各自跑 fixtures 时互相覆盖二进制,产生随机 stdout 串味(实测一次 `async-arrow-multiarg-2` 期望 5 得 7,一度被误判为编译器 miscompile,经二分排除)。已改为 pid+时间戳+相对路径并显式清理;两次故意并发运行均 380/380 且零残留。
- **S1 剩余(已定位,未做)**:**`String.prototype` 不作为对象存在——门控 465 个 String 测试(该目录 38%),是目前发现的全仓最大单一杠杆**;`RegExp.prototype` 同样缺失(70);`\p{…}` 属性转义(123);`v` 标志/unicodeSets(21);`Array.prototype.constructor` 缺失(69,全在 `split`);UTF-8 字节串 vs UTF-16 码元(String+RegExp 共 ~27);函数 `length`(arity)与内建 `name` 的元数据消费端(见 v0.2.9 后续批);`Object.prototype` 不在运行时原型链(**已论证不可用白名单绕过**:`Object.create(null)` 与普通字面量的 `__proto__` 均为 0,运行时不可区分,白名单会让 `"toString" in Object.create(null)` 错误为真,破坏原型污染防护所依赖的 null 原型字典)。

### S1.5 — `language/` 根因图(2026-07-26 实测,3828 项 stride-5)

> 首次对最大池做根因聚类。方法:每个失败**按序首匹配只归入一个簇**(无重复计数),492 项(20%)留作长尾。计数 ±2%(超时敏感)。

| # | 根因 | 计数 | 侧 | 可解性 | 已复现 |
|---|---|--:|---|---|---|
| 1 | **早期错误未抛**(重复 `constructor`、重复绑定、非法赋值目标) | 306 | parser | 中(规则多但各自机械) | 是 |
| 5 | **async 异常不转 rejection**——async 函数体内 `throw` **直接终止进程**(`panic: uncaught exception in spawned coroutine`)而非 reject;`yield*` 无迭代器协议校验 | 266 | runtime | **架构级**(协程边界需 abrupt-completion 契约) | 是 |
| 2 | **数组解构急切抽干可迭代对象**——`emitDestructurePattern` 用 `_array_spread_into` 物化后再按下标读:无逐元素交错、无 `IteratorClose`、无限迭代器**挂死** | 241(含 24 超时崩溃) | 编译器+运行时 | **架构级**(需真 IteratorRecord,**不可打补丁**) | 是 |
| 4 | **类元素属性特性错**:4a 原型方法/访问器被定义为 `enumerable:true`(规范为不可枚举)164;4b **静态方法根本没物化为构造器自有属性**(`gOPD(C,'m')===undefined` 而 `typeof C.m==="function"`)64 | 228 | 编译器+运行时 | **机械**(描述符管线已存在) | 是 |
| 3 | **私有 生成器/异步生成器方法不可调用**(`*#m(){}`)——公有/静态生成器方法均正常,是私有名路径没接到协程接线 | 207 | 编译器 | 中 | 是 |
| 6 | **无法解析的标识符读出数值 `0` 而非抛 ReferenceError**(`compileIdentifier` 兜底 `movImm(RET,0)`);`assert.throws(ReferenceError,…)` **0 PASS / 261 run** | 149 | 编译器 | **机械→中**(判定谓词已存在于旁边的 `typeof` 路径) | 是 |
| 7 | 缺失的规范 TypeError(不可迭代解构源、私有 brand 检查、无访问器的 `[[Get]]/[[Set]]`) | 118 | 混合 | 中 | 是 |
| 8 | **NamedEvaluation 缺失**(解构默认值/逻辑赋值 RHS/类表达式绑定的匿名函数无 `.name`) | 111 | 编译器 | **机械**(扩展已覆盖两种形式的推断) | 是 |
| 9 | **普通函数没有 `.prototype` 对象 → `obj.constructor` 为 undefined** | 105 | 编译器+运行时 | 中 | 是 |
| 10 | 私有名以普通字符串键建模(`"#__classexpr1#f"`),经 `Object.keys`/`gOPN`/`hasOwnProperty` **泄露** | 51 | 编译器 | 中(需独立私有名空间) | 是 |
| 11 | `class X extends <内建>` 编译/运行崩溃 | 23(全 CRASH) | 编译器 | 中 | 是 |
| 12 | `eval` 内含 `super`(类字段/派生构造器)→ SIGSEGV | ~32 | 编译器/engine | 中 | 否 |

**判定为重复、不另计**:`Object.prototype` 不在原型链(是簇 4/7/9 与长尾的**贡献因子**,非独立簇);函数 `.name/.length` 反射门(簇 9 的子情形);**`Symbol.species` 在这两个目录里出现次数为 0**(根本不是 `language/` 议题);UTF-8 vs UTF-16(在 String/RegExp,不在此);一般求值顺序**已正确**(仅迭代器那处即簇 2)。

**CRASH 108 项判定:不适合作为下一目标**。与早期 built-ins 各波不同,`language/` 的崩溃**多是簇 2/5/12 的症状**而非独立缺陷——仅约 29 项廉价且孤立,其余 ~55 项会随那三簇一并消失。

**最高杠杆项 = 簇 9(函数 `.prototype`/`.constructor`),理由是认识论而非计数**:`assert.throws(Test262Error,…)` 是 **0 PASS / 199 run**、源码含 `.constructor` 的是 **0/93**——这是硬零而非低百分比,意味着**全语料范围内**凡用自定义错误构造器的测试,其正确与否当前对 harness **完全不可见**(实测确认:`T.prototype` 为 undefined、`e.constructor` 为 undefined)。其中约 85 项**行为其实已正确**,只因 harness 读 `thrown.constructor.name` 而判负。先修它,再重测,下面所有优先级才可信。

**建议工序**:A(测量解封)簇 9 → 簇 6;B(性价比)簇 4 → 簇 8 → 簇 3;C(架构,按依赖排序)簇 2 → 簇 5 → 簇 1(计数最大但**故意排最后**:各规则独立可并行,且过早做会在不改善引擎语义的情况下抬高通过率,并有过度拒绝而**破坏自举**的最高风险)。

### S2 — 对象模型 + 强转 + 错误地基(28% → 40%)
- **属性描述符 + [[DefineOwnProperty]]**:Object.defineProperty/getOwnPropertyDescriptor/freeze/seal/preventExtensions/isExtensible;描述符反射(528 property-descriptor 失败)。
- **泛型数组方法(完整)**:所有数组方法对类数组 this 工作(消灭 ~136 Array CRASH + 相关)。
- **类型强转统一**:ToPrimitive(hint)/抽象相等边界/关系比较。
- **错误处理**:规范错误类型 + instanceof + 运行时抛异常机制(解 #38 契约)。
- **函数 .length/.name + bind**。
- **撬动**:核心语义 1637 的大部分。
- **产量**:+~780。**工作量**:大(架构)。**依赖**:S1。

### S3 — 类 + 迭代 + Symbol(40% → 55%)
- **完整 class**:字段(public/private)、静态、方法、计算键、extends/super、私有品牌(#)。(class 簇 ~1100)
- **Symbol + well-known**:Symbol.iterator/toPrimitive/toStringTag/species/match/replace/split。(Symbol 簇 ~500)
- **迭代协议**:for-of、内建 Symbol.iterator。(Symbol.iterator 325)
- **生成器**:function*、yield、生成器协议。(generators 637)
- **解构完整**:绑定/赋值解构、默认值、rest、计算键。(destructuring 949)
- **产量**:+~970。**工作量**:大。**依赖**:S2(对象模型+函数)。

### S4 — async + 内建穷尽 + TypedArray(55% → 70%)
- **async/await + 异步迭代**:async functions、for-await、异步生成器。(async-iteration 774 + async-functions 95)
- **Promise 完整**:组合子(allSettled/any/race)、species。
- **TypedArray 完整**(261)+ resizable ArrayBuffer(57)。
- **RegExp 高级**:unicode property escapes(133)、v-flag、modifiers。
- **内建方法规范边界穷尽**:String/Number/Math/Object 逐方法对齐 spec。
- **产量**:+~970。**工作量**:大。**依赖**:S3(迭代+Symbol)。

### S5 — Proxy/Reflect + BigInt + strict(70% → 85%)
- **Proxy**(全陷阱 + revocable)+ **Reflect**(Reflect.construct 51)。
- **BigInt**(119)+ 混合运算。
- **strict mode** 语义(横切:只读赋值抛错、删除不可配置抛错、this 严格等)。
- **Date/JSON** 边界。
- **产量**:+~970。**工作量**:大。**依赖**:S2(对象模型)。

### S6 — 模块 + annexB + 长尾(85% → 95%+)
- **ES 模块**:import/export、动态 import(当前特性门排除,需解锁)。
- **annexB**:legacy web 兼容(__proto__、String.substr 等)。
- **长尾边界**:剩余 corner case。
- **产量**:+~650。**工作量**:大。**依赖**:S1-S5。

---

## 6. 一致性基础设施(贯穿)

1. **harness 增强**(现有 `tests/test262/run.mjs`):
   - 完整 frontmatter 解析(flags/includes/features/negative)。
   - **per-test 期望清单**(仿 LibJS):`tests/test262/expectations.json` 标记已知失败,检测**回归**(新失败报警)+ **进展**(已知失败转 PASS 提示移除)。
   - 负向测试精确相位校验(parse vs runtime,当前仅粗校)。
2. **conformance 仪表盘**(仿 test262.fyi/LibJS):按特性/目录的通过率趋势,每周复盘(plan.md 已定周日复盘)。
3. **差分探测**(已验证有效):对新增内建做 vs-node 差分,抓静默值 bug(见 es-compat-table-testing 记忆)。
4. **CI 集成**(S4 plan.md 已列):test262 跑入 CI,通过率只升门禁。

---

## 7. 独特约束与风险

### 🔴 自举字节定点(asm.js 独有,Kiesel/LibJS/Yuku 皆无)
asm.js **自举 + gen1==gen2==gen3 字节一致**。每个一致性修复(尤其改 codegen/运行时/内建)都必须保持定点。这是**比非自举引擎慢得多**的根本原因:
- 改编译器源码 → 自编译产物变 → 须验证新链收敛(布局敏感,见 layout-position-nondeterminism)。
- **缓解**:① 每修过 bootstrap-gate;② 大批量用"定点迁移"机制(plan.md S5:受控打破一步再收敛);③ 运行时 helper 优先于编译器 codegen 改动(helper 改不触发布局);④ 增量小步,忌大重构。

### 其他风险
| 风险 | 对策 |
|---|---|
| 值 bug 转化低(单修非唯一阻塞,解构 getter 实测 +0) | 优先 CRASH(干净翻转)+ 地基(撬动面大),非逐点值 bug |
| 架构改动破坏定点 | 运行时优先;每阶段过门;定点迁移机制 |
| 对象模型重构波及自编译 | 分阶段、增量、双轨(新路径 + legacy 回退) |
| 性能 vs 一致(AOT 模型) | 一致性优先,性能用形状 IC/解箱补偿(支柱①②) |
| 配额/会话量限制 | 阶段化,每阶段独立可交付;仪表盘追踪跨会话进展 |

---

## 8. 成功指标

- **通过率**:S1 ≥28% → S2 ≥40% → S3 ≥55% → S4 ≥70% → S5 ≥85% → S6 ≥95%(in-scope 子集)。
- **每阶段**:bootstrap-gate 全绿(gen1==gen2==gen3 + fixtures + test262 只升)。
- **回归零**:expectations.json 无新增已知失败。
- **诚实记录**:每阶段实测产量 vs 估算,校准后续(本会话已确立:估算 ~200+ 的解构 getter 实测 +0——产量须实测,不凭归类)。

---

## 9. 下一步(本会话之后)

**S1 收尾**(达 28%):① 负向解析测试(parser 早期错误,参考 Yuku)② 数组方法泛型第一刀(消灭 Array CRASH)。
**S2 启动**(地基):属性描述符 + [[DefineOwnProperty]] + 泛型数组方法完整 + 错误抛出机制——这是撬动 1637 核心失败的最高杠杆,也是后续全部特性的前提。

> **总判断**:test262 完整支持是**多阶段架构工程**(非逐 bug 修补),核心在**对象模型 + 强转 + 函数 + 错误**四块地基,而非特性堆叠。asm.js 的自举定点约束使其比 Kiesel/LibJS 慢一个量级,须以"运行时优先 + 增量过门 + 定点迁移"纪律推进。Yuku 启示 parser 层可快速达标(test262 驱动),地基层须持久战。

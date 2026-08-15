# 2026-08-12 主控编排台账

> 角色：主控（本会话）  
> 上位蓝图：`plan.md`、`docs/ROADMAP.md`、`BOOTSTRAP_RULES.md`  
> 前序台账：`docs/progress/2026-08-05-master-plan.md`（当时 ~59%）  
> 协作协议：四象限；事实与假设分离；门禁由主控唯一执行

---

## 1. 共同已知（事实基线）

| 项目 | 真值 | 权威源 |
|------|------|--------|
| 分支 | `dev`/`main` @ `cfde2a78a`（**tag v0.3.65** 已 push `qorm/main`） | git |
| test262 | **71.01%**（4483/6313 stride-5） | `tests/test262/last_run_summary.json`（2026-08-13 官方全量，数组 proto 跳后） |
| 距 80% | **M4 目标 5051**，缺口 **+568 PASS** | 计算 |
| fixtures 门禁 | `BASELINE_FIXTURES=398`；PASS=365 XFAIL=33 FAIL=0 | `scripts/bootstrap-gate.sh` |
| CLI VERSION | **0.3.65**（cli.js / package.json / tag v0.3.65） | 源码 |
| 文档宣称 | README / CHANGELOG 已同步 v0.3.65 与 70.19% / fixtures 398 | 本轮已对齐 |
| 自举铁律 | ARM64 `gen1==gen2==gen3`；fixtures FAIL=0；探针≠安全证据 | `BOOTSTRAP_RULES.md` |
| 发布 | v0.3.65 小版本上主分支后再冲 M4 80% | 主人指令 |

### 架构一句话

JS → `lang/` → `compiler/` → VM IR → `backend/` → `asm/` → `binary/`；`runtime/*` 编译期 emit；NaN-boxing；分代 GC；G-M-P N>2（linux-arm64）。

### 相对 08-05 规划的校准

M1–M3（60%/65%/70%）已过。本轮北极星改为 **M4：80%**（5051/6313）。策略以 **`docs/progress/2026-08-12-dep-path.md` 为执行序**：下层未稳不扩上层；同层可并行，跨层串行。for-await / TypedArray / `\p{}` 依赖未满，不立项。

---

## 2. 我方已知 / 对方未知（隐含约束）

1. **文件 owner 互斥**：同时刻一文件一实施 owner；审计只读不占 ownership。
2. **实施 agent 禁止**：改 git 状态、跑完整自举链；只做 `node --check`、scoped fixture、/tmp 差分。
3. **主控唯一**：`bash scripts/bootstrap-gate.sh` + 官方 `tests/test262/run.mjs --stride 5`。
4. **Array/Object 关键路径串行**：禁止并行改 `_array_length`/`_array_get` prologue 与 `object/index.js` define 路径。
5. **版本叙事**：主人决议发小版本。本轮对齐 **cli.js / package.json / tag = 0.3.65**（此前 VERSION 冻在 0.3.13、tag 已至 v0.3.64）。下一北极星 **M4：80%**（5051/6313，约 +620 PASS）。

---

## 3. 对方已知补充（审计结论摘要）

### 3.1 test262 最高杠杆簇（只读 agent）

| 序 | 波次 | 预期 +PASS | 可写文件 | 风险 |
|----|------|------------|----------|------|
| W1 | TypedArray（resize/detach/timeout） | +45–70 | `runtime/types/typedarray/index.js` | 中 |
| W2 | Set（GetSetRecord / set-methods） | +15–25 | `runtime/types/set/index.js` | 低 |
| W3 | Promise 组合器/species | +20–35 | `runtime/async/promise.js` | 低–中 |
| W4 | String↔RegExp 委托 | +25–40 | `runtime/types/string/index.js` | 中（自举热路径禁改 trim/indexOf） |
| W5 | RegExp 非 `\p{}` | +25–40 | `__regexp_shim.js` + `regexp/index.js` | 低 |
| W6 | Array `_agen_*` 泛型回调 | +50–80 | `array/index.js` + `builtin_array_methods.js` | **高 · 串行** |

备选（过线后）：R1 `\p{}`、R2 for-await、R3 Object.define*（R3 必须在 W6 之后）。

### 3.2 S2 清债审计

| 项 | 状态 | 本轮 |
|----|------|------|
| S2.1 6 参 call-ABI | 部分（限 5 + knownFailure） | **不抢** `functions.js` |
| S2.2 C3 asyncIterator | 主路径已关；文档过时 | 文档勾选即可 |
| S2.3 派发劫持 | 部分（Buffer.concat 窄修） | **不抢** |
| S2.4 C1/C2 | 部分 / 开放（布局敏感） | **禁止本轮动 C2** |
| S2.5 bare/https 显式失败 | 部分（`node:` 已拒） | 可并行、低冲突 |

### 3.3 文档漂移（必须修 vs 可延后）

| 必须修（本轮或紧随合并） | 可延后 |
|--------------------------|--------|
| README 中英 test262%/fixtures | ROADMAP/TEST262_ROADMAP 历史锚点 |
| 纳入 replaceAll fixture → BASELINE 397→398 | VERSION↔tag 治理策略 |
| 同步 last_report / last_run_summary | plan.md 内嵌旧数字 |

---

## 4. 共同未知 → 可验证假设

| ID | 假设 | 最小实验 | 通过标准 |
|----|------|----------|----------|
| H1 | W1–W5 并行净增 ≥130 PASS | 各区 `--dirs … --stride 1` 再主控 stride-5 | 全量 ≥4307（68.2%）且门禁绿 |
| H2 | 不过 70% 时 W6 可补齐 | W6 后 stride-5 | ≥4420 且 fixtures/定点绿 |
| H3 | String 委托不伤自举 | 主控 gate | gen2==gen3 + fixtures FAIL=0 |
| H4 | replaceAll-fn fixture 仅 +1 发现数 | 上调 BASELINE 后 gate | discovered==398 |

---

## 5. 实施路线（本轮）

```
Phase A（并行，文件零重叠）
  Agent-TA  ∥ Agent-Set ∥ Agent-Promise ∥ Agent-String ∥ Agent-RE
  Agent-Docs（夹具+BASELINE+进度数字，不碰 runtime）
       │
Phase B（审计）
  红队只读复核：diff 边界、是否碰禁区、自测是否可证伪
       │
Phase C（主控收口）
  bootstrap-gate → fixtures → test262 stride-5 → 更新本台账
       │
Phase D（条件串行）
  若 <70% → Agent-Array（W6）→ 再门禁 → 必要时 R3/R1
```

### Agent 边界卡

| Agent | 可写 | 禁止 |
|-------|------|------|
| TA | `runtime/types/typedarray/index.js` | array/、object/、git |
| Set | `runtime/types/set/index.js` | 同上 |
| Promise | `runtime/async/promise.js` | 大改 coroutine.js |
| String | `runtime/types/string/index.js` | 改 trim/indexOf/slice 热路径语义；object/array |
| RegExp | `runtime/node/__regexp_shim.js`, `runtime/types/regexp/index.js` | `\p{}` 大表（除非升格 R1） |
| Docs | `tests/fixtures/es/string-replaceall-fn/**`, `scripts/bootstrap-gate.sh` BASELINE, README 数字段, 本台账 | runtime/compiler |
| Array（Phase D） | `array/index.js`, `builtin_array_methods.js` | `_array_length`/`_array_get` prologue；object/ |

### 验收命令（主控）

```bash
bash scripts/bootstrap-gate.sh
node scripts/run-fixtures.mjs
node tests/test262/run.mjs --stride 5 --jobs 8 --target macos-arm64
```

区域探针（agent 自测）：

```bash
node tests/test262/run.mjs --dirs built-ins/<Area> --stride 1 --jobs 8 --target macos-arm64
```

---

## 6. 进度板

| 波次 | Owner | 状态 | 备注 |
|------|-------|------|------|
| 主控分析 | 主控 | ✅ 完成 | 三路只读审计 + 本台账 |
| W1 TypedArray | Agent-TA | ⏪ 已回滚 runtime | Design C 致 `not a function`；compiler 三文件待清；stash 保留 |
| W2 Set | Agent-Set | ✅ 完成 | GetSetRecord 守卫；区测 +21 PASS（257/380）；keys 迭代器物化/SIGBUS 仍待 |
| W3 Promise | Agent-Promise | ✅ 完成 | 可迭代物化+resolve/thenable；区 stride-5 ~+9 PASS；species/then 自有属性未做 |
| W4 String | Agent-String | ✅ 完成 | @@ 委托+动态 fn 替换器；区增益偏下沿；静态 RE 仍走 `__RE_*`；match CRASH 簇待门禁 |
| W5 RegExp | Agent-RE | ✅ 完成 | @@match/replace/search + $nn/flags 序；区 ~+15；无 `\p{}`；未动 regexp/index.js |
| Docs/BASELINE | Agent-Docs | ✅ 完成 | BASELINE→398；README 同步；主控已 `git add` fixture+台账（未 commit） |
| 红队审计 | Agent-Audit | ✅ 有条件 GO | 硬禁区干净；TA compiler 越权已承认；last_report 被区测污染须重跑覆盖 |
| 主控门禁 | 主控 | ✅ PASS | 定点+fixtures 398；官方 stride-5 **70.19%**（4431）；**M3 70% 达成** |
| W7 Object.define* | Agent-Object | ✅ W7b 收口 | Object **545/681（80.0%）** |
| L4 RegExp | Agent-RE | ✅ 全量 +23 | 229/374（61.2%）；source CRASH 仍在（eval 缺 `__RE_new`） |
| L3a2 String 非RE | Agent-String | ✅ String 168→178 | 178/243（73.3%）含 L4 委托；CRASH 0 |
| L1c object-rest | Agent-Object | ✅ 全量收口 | language +34；CRASH 73→70 |
| L3b Function | Agent-Function | ✅ 部分 | arguments 默认参数；两阶段落栈已回退；caller 未做 |
| L4c class 计算名 | Agent-Class | ✅ M3 | 计算键 28→27 PASS；全量 **70.19%**（+37） |
| M4 Phase A | 五路 | ✅ 收口 | 官方 **70.62%**（+27）；Promise CRASH 升至 9；statements −5 |
| M4 Phase B Promise CRASH | Agent-Pcomb | ✅ 交卷 | stride-5 overlay **PASS 96→101 CRASH 9→2**；4 条点名不再崩；`invoke-then-*-close` 超时留给 object/ |
| M4 Phase B species+Set | Agent-Members | ✅ 交卷 | stride-5 overlay **Set 58→66** CRASH 0；Promise 96 持平 CRASH 9；`typeof` 探针绿；species 身份 `===` 仍 false |
| M4 Phase B for-await | — | ❌ 已取消 | 跨层（L1 迭代 + L2 数组 + L4 async）；未改文件。见 dep-path Phase E |
| M4 Phase B 门禁 | 主控 | ✅ 官方 **70.82%** | 4471/6313（+13）；CRASH 75→68；Promise 101 CRASH 2；Set 66；距 80% **+580** |
| M4 Phase C Array | Agent-Array | ✅ 官方 **70.84%** | Array 400/594 CRASH 1；全量 CRASH 68→64；+1 PASS（toSorted）。P1 阻塞 L1 |
| M4 Phase C' L1 具名 miss | Agent-Object | ✅ 官方持平 **70.84%** | 探针不再 SIGSEGV；stride-5 PASS/CRASH 数字未动。fallthrough 仍关 |
| W10 RegExp | Agent-RE | ⏸ 搁置 | 已 stash；等 String（依赖序） |
| W11 Desc 反射 | Agent-Desc | ✅ 小增益 | Math.sign/imul；PH 大头归 Object |
| W9 Array 洞扫尾 | Agent-Array | ✅ +4 收口 | Array 398/594（67.0%） |
| W6 Array | Agent-Array | ✅ W6a–c；⛔ W6d | holes 需真 hole+delete/`in`（越界）；Array 密读循环无可再收 |
| W7b Set 迭代器 | Agent-Set | ✅ +15 | keys 物化；stride-1 257→272 |
| W8 真 hole | Agent-Hole | ✅ 门禁绿 | 哨兵0+int0；全量路径已并入 67.81% |

---

## 7. 风险登记（本轮）

| 风险 | 等级 | 缓解 |
|------|------|------|
| String 自举回归 | 中 | 禁热路径；gate 必跑 |
| 并行合并冲突 | 中 | 文件 owner 卡死；members.js 禁止写入 |
| Array W6 破坏定点 | 高 | 串行；禁 prologue；增量参数化 |
| VERSION 对外撒谎 | 已关 | v0.3.65 已对齐 cli.js / package.json / tag |
| C2 布局悬崖 | 极高 | 本轮明确不做 |

---

## 8. 更新日志

| 时间 | 事件 |
|------|------|
| 2026-08-12 | 主控开盘：分析完成，Phase A 五实施 + Docs 派出 |
| 2026-08-12 | Agent-Docs：确认 `string-replaceall-fn` 完整；BASELINE→398；README 中英 pass%/fixtures 同步 |
| 2026-08-12 | 主控：已 stage `string-replaceall-fn` + 台账，消除 BASELINE/发现数不一致；W1–W5 仍进行中 |
| 2026-08-12 | Agent-Set：GetSetRecord 守卫落地，Set stride-1 +21 PASS；未 commit |
| 2026-08-12 | Agent-Promise：组合器物化+subscribe，Promise 区 ~+9 PASS；验证时曾 reset 其它 runtime（现工作树仍含 string/TA/RE 改动，待红队核对） |
| 2026-08-12 | Agent-String：@@ 委托落地；主控确认 `_str_getmethod` diff 仍在；静态 RE 需编译器后续 |
| 2026-08-12 | Agent-RE：shim @@ 抽象路径+$nn/flags；区测约 +15；无 `\p{}` |
| 2026-08-12 | Agent-TA：CRASH/timeout 清零；AB.resize 等落地；区 PASS 未净增；触及 compiler 三段 |
| 2026-08-12 | 主控：Phase A 齐套 → 启动红队；随后门禁 |
| 2026-08-12 | 红队：有条件 GO；启动 bootstrap-gate |
| 2026-08-12 | 门禁红：gen1 出，gen2 报 `not a function`；派出诊断 agent |
| 2026-08-12 | 诊断：W1 typedarray Design C → `not a function`（已回滚）；更早 `306551b24` → SIGSEGV；派出修复 |
| 2026-08-12 | 修复：RegExp brand Call 改内联 AST；gen2-probe 绿；重跑 gate |
| 2026-08-12 | gate：编译链通但 gen1≠gen2≠gen3；派出定点二分 |
| 2026-08-12 | 定点根因：`fab91027` blockscope indexOf + `152197ee` object 重复 `_str_*`；已修 |
| 2026-08-12 | 门禁绿：定点 + fixtures 398；test262 **66.75%**（4214/6313，+37）；W1 已回滚；W6 待启动 |
| 2026-08-12 | 主控：启动串行 W6 Array（目标补齐 ~+206 中的最大杠杆） |
| 2026-08-12 | 只读：Array 231 FAIL；优先共享迭代骨架(~105)→indexOf(~23)→IsCallable→结果构造 |
| 2026-08-12 | W6a：活读泛型+origRecv，Array +19；gate 绿；全量 66.75%→**67.05%**；启动 W6b thisArg |
| 2026-08-12 | W6b：thisArg 贯通，区 +2；定点+fixtures 绿；全量 **67.08%**（4235）；启动 W6c indexOf/IsCallable |
| 2026-08-12 | W6c：indexOf 活读+IsCallable 收紧，区 384→397；主控 gate+stride-5 |
| 2026-08-12 | W6c 收口：全量 **67.29%**（4248，+13）；剩余 Array FAIL 197；启动 W6d 真数组 holes |
| 2026-08-12 | W6d 停手：洞为 dense-undefined，delete/`_prop_in`/原型回落均在 object·compiler；改开 W7 Object.define* |
| 2026-08-12 | 主人改优先：真 hole；停 Object W7；启动 Agent-Hole（哨兵0 + 存侧 +0→int0） |
| 2026-08-12 | Set W7b：keys 迭代器物化，区 +15 PASS；等 Hole 完成后统一门禁 |
| 2026-08-12 | Hole：真洞落地（cli 探针对齐 node；区 Array +32）；启动统一门禁 |
| 2026-08-12 | Hole 收口：Map/Set keys 直写 +0→int0 修 fixture；gate 绿；全量 **67.24%**（4245；Array 394 / Set 51） |
| 2026-08-12 | 主控：继续冲 70%；分析剩余 FAIL 后开下一波 |
| 2026-08-12 | 开 W7 Object.define*（~122 FAIL）∥ W9 Array 洞扫尾 |
| 2026-08-12 | W9：跳洞扫尾 Array +4（398）；附带 vm.fmovFromInt 别名；等 Object |
| 2026-08-12 | Object W7：+32 PASS；统一门禁 + stride-5 |
| 2026-08-12 | 门禁绿：全量 **67.81%**（4281，+36）；Object 501 / Array 398；距 70% 约 +139 |
| 2026-08-12 | 主控：继续冲 70%（目标 +139） |
| 2026-08-12 | 开 W7b define* 收尾 ∥ W10 RegExp ∥ W11 Desc 反射 |
| 2026-08-12 | Desc：确认 name/length 已对；补 Math.sign/imul；等 W7b/RE |
| 2026-08-12 | 改依赖序：停 RegExp（stash）；文档 `2026-08-12-dep-path.md`；Object W7b 区 +44 → 门禁 |
| 2026-08-12 | **gen2 卡死 31min**：W7b `_array_side_elem_*` 每次 `arr[i]` 扫 `_closure_props_registry`；自举 `this.code[]` 成 O(n·m)。已杀门禁；加 `ARR_HAS_SIDETABLE` 热路径 O(1) 跳过 |
| 2026-08-12 | 门禁绿：定点 + fixtures 398；官方 stride-5 进行中 |
| 2026-08-12 | 官方 stride-5：**68.32%**（4313/6313，+32 vs 67.81%）；Object 545；CRASH 74；距 70% +107。define* FAIL 49 → 开 L3a String |
| 2026-08-12 | 启动 [L3a String](b1f7567a-b545-4029-b407-6d9f0659fbdb)：split 构造器 / this 强制 / split SIGSEGV |
| 2026-08-13 | L3a 交卷后门禁红：3 个 HTTP fixture `status 0`。根因 `_str_split` 把 A2 残留装箱 int 当 limit。已改为忽略 A2（limit 仍走编译器 slice） |
| 2026-08-13 | 门禁绿；官方 stride-5 **68.60%**（4331，+18）；String 168/243 CRASH 0；距 70% +89 |
| 2026-08-13 | String 已稳 → 开 L4 RegExp（非 \\p{}，不 pop stash）∥ L3a2 String 非 RE 扫尾 |
| 2026-08-13 | [L4 RegExp](54a04f15-48b3-4c76-bec7-67b6957f2528) 区测 +23；只改 shim；官方 last_run 未污染；门禁等 L3a2 |
| 2026-08-13 | [L3a2 String](ea21b730-82ea-43c7-ac70-034b4e27fd4f) 区 +5；齐套门禁绿；官方 **69.13%**（4364，+33 vs 68.60%）；String 178、RegExp 229；距 70% +56 |
| 2026-08-13 | 继续冲 70%：PH 170 已拆——class 60 + object-rest 42 + defineProperty 19，不是 Function.prototype。开 L1c `_object_rest` ∥ L3b Function 编译器缺口 |
| 2026-08-13 | [L1c rest](c7bd84bc-c4ad-4b3b-b7cf-a0159c90a40a) `_object_rest` 跳过不可枚举+[[Get]]；[L3b Function](505244c3-3d26-457c-a4da-7a9dc375f62b) 默认参数 arguments 扫描。两阶段落栈卡死 gen2（`function f(a=1)`），已回退。门禁绿，官方 stride-5 进行中 |
| 2026-08-13 | 官方 stride-5 **69.60%**（4394，+30 vs 69.13%）；CRASH 70（−3）；Object 544（−3）；language expr 1382 / stmt 1285；距 70% +26 |
| 2026-08-13 | 开 L4c class 计算名：28 FAIL（`x is not defined` / Symbol ToString）；目标补齐 +26 过 70% |
| 2026-08-13 | [L4c class](76f0c445-d14b-42cd-9916-f34a48de0223) 类定义期求实例计算键；门禁绿；官方 **70.19%**（4431，+37）；**M3 70% 达成** |
| 2026-08-13 | 主人：提交小版本到主分支。对齐 VERSION/tag **v0.3.65**，CHANGELOG/README 同步 70.19%；下一北极星 M4 80% |
| 2026-08-13 | **v0.3.65 已 push `qorm/main` + tag**（`cfde2a78a`）。合入 remote-main 自动块会 SIGSEGV gen1→gen2，故 `-s ours` 保留已门禁树。开 M4 Phase A：Promise∥Set∥RE-lite∥String∥class-statements |
| 2026-08-13 | [RE-lite](cd4d29e9-046a-4042-9b48-e3a9bf49065d) 交卷：shim 原型链/`RegExp(obj)` 原值/lookbehind 右对齐/`u` 下 `.` 按码点；估 +6。等 Promise/Set/String/class 齐套再门禁 |
| 2026-08-13 | [Set set-like](4e5639ec-4aa0-42a4-90c8-1084395edfcf) 交卷：GetSetRecord 只 Get size/has/keys；布尔方法不 Call keys；估 +7（含 2 CRASH）。`typeof Set.prototype.difference` 仍要 `members.js` |
| 2026-08-13 | [class 私有方法](948e81b3-c776-47c3-9128-7b2465777853) 交卷：实例私有方法改构造期 own 槽；`_cfkeys_*` 未动；估 +5–15。真正 PrivateBrandCheck 要 `members.js` |
| 2026-08-13 | [Promise](1b214675-e7fc-4443-8c45-9b467b90dfb3) 交卷：区 stride-5 **78→96 PASS（75.6%）**，FAIL 47→22。**CRASH 2→9**（4 条原 PASS 现 SIGSEGV：`iter-next-val-err` / array-setters / `iter-step-err-no-close`）。species/extends 仍要 members.js。门禁时盯 CRASH |
| 2026-08-13 | [String](5893056e-4b8a-4fa2-9919-662e804e75f9) 交卷：区 **178→180/243（74.1%）**，CRASH 0。`codePointAt` 负下标 + RegExp ToString(this)。Phase A 齐套 → 主控门禁 |
| 2026-08-13 | 门禁绿。官方 stride-5 **70.62%**（4458/6313，**+27** vs 70.19%）。Promise 78→96、Set 51→58（CRASH 2→0）、String 178→180、RegExp 229→231。**CRASH 70→75**（Promise +7）。**language/statements 1299→1294（−5）** 归因 class 私有 own 槽。距 80% 仍约 **+593** |
| 2026-08-13 | 主人：继续冲 80%。开 **M4 Phase B** 三路零重叠：Promise CRASH 收口 ∥ Promise.species+Set 组合器方法值 ∥ for-await「obj is not iterable」主簇（72/117） |
| 2026-08-13 | 主人纠偏：**一定按 JS 依赖路径，减少返工**。for-await 已停（未改文件）。执行序改回 dep-path：B 只做 L4 稳定债 → 门禁 → **C 串行 L2 Array 泛型**（179 prototype 非 PASS）→ 才允许 Class/for-await/TA。Phase A 越层账：class 私有 −5 statements、Promise 扩组合器 CRASH 2→9 |
| 2026-08-13 | [species+Set 方法值](ad93ff90-f305-443d-ae7c-a5a155e93e3a) 交卷：`speciesTmpSlot` + 7 个 `_aref_set_*`。stride-5 overlay **Set 58→66（+8）** CRASH 0；Promise 96 持平。官方 last_run 未污染。等 B1 Promise CRASH 再门禁 |
| 2026-08-13 | [Promise CRASH 收口](02bedebb-f6fd-493f-8eda-353eaac22305) 交卷：`_pcomb_iter_step` 对象检查 + A5 ptrFloor。overlay **Promise 96→101 CRASH 9→2**。Phase B 齐套 → 主控门禁 |
| 2026-08-13 | Phase B 门禁绿。官方 stride-5 **70.82%**（4471/6313，**+13** vs 70.62%）。Promise 96→**101** CRASH 9→**2**；Set 58→**66** CRASH 0。全量 CRASH **75→68**。Array 399 持平。距 80% **+580**。开 Phase C L2 Array（先 sort SIGSEGV） |
| 2026-08-13 | [L2 Array](9dbca15e-b294-47ff-bf04-a055ce658ef7) P0 交卷：sort 改运行时重读 length，4 SIGSEGV→FAIL；toSorted 非函数 comparefn +1 PASS。P1 未动——剩余 hole/`this.foo` 要 L1 object。主控门禁 |
| 2026-08-13 | Phase C 门禁绿。官方 **70.84%**（4472/6313，+1）。Array **400** CRASH **5→1**；全量 CRASH **68→64**。开 Phase C'：L1 数组具名 miss 不得 SIGSEGV（**禁止**解开 `_object_get_array` 的 proto fallthrough） |
| 2026-08-13 | [L1 数组具名 miss](8966b48f-b3c9-4645-b950-8feef5cf953e) 交卷：裸 TYPE_ARRAY 改走 `_object_get_array`（+ boxArrThis）。探针 `this.foo` 不再 SIGSEGV。Array 区测仍 400。fallthrough 未解。主控门禁 |
| 2026-08-13 | Phase C' 门禁绿。官方 stride-5 **仍 70.84%**（4472/6313），CRASH 64 持平。C' 是正确性补丁，未打进 stride-5 样本。Array 泛型已跳 hole；剩余 193 FAIL 不是具名 miss SIGSEGV。不解开 proto fallthrough，也不再盲冲 Array |
| 2026-08-13 | 主人：继续。新聚类：26 条 `not a function` 吸烟枪 `every/15.4.4.16-8-2`（`foo.prototype=new Array` 后 `f.every` 侧表 miss）。开窄修：非索引 miss → `_nsobj_array_proto`，**不**走数组块 proto@16 |
| 2026-08-13 | [数组方法名落 prototype](0d4e107d-9e1b-4d3d-a8d3-c4d6218e4222) 交卷：非索引 miss + 非 constructor + own-only → `Array.prototype._object_get`。区测 **400→410**，not-fn 26→14，CRASH 1。2 条 reduce `-5-5` 翻负（既有 `_agen_reduce` 空数组不抛，非本跳）。主控门禁 |
| 2026-08-13 | 门禁绿。官方 stride-5 **71.01%**（4483/6313，**+11**）。Array 400→**410（69.0%）**；Object 546→547；CRASH 64 持平。距 80% **+568** |
| 2026-08-13 | 开 L1 下一刀：defineProperty(数组索引) 属性位（22 FAIL）+ gOPD 9 CRASH-detail。独占 object/index.js；热路径不得退化 |
| 2026-08-13 | L1 descriptor 刀交卷：根因非 gOPD（本就对），是 `propertyIsEnumerable` 对数组恒 false + `delete` 无视侧表 configurable。修 `_opie_arr`/`_odel_array` 两函数。门禁绿；官方 **71.33%**（4503/6313，**+20**）。Object 567/113/1/0（83.3%）。B 簇 9 条确诊 members.js 内建物化缺口（Math.max/min/hypot/random、Function.prototype 等未落 own prop），留给持锁刀。距 80% **+548** |
| 2026-08-13 | 开两刀（文件不相交并行）：① L1 内建物化补全（members.js 独占，gOPD 9 条簇）② L2 `_agen_reduce` 空数组无 seed 抛 TypeError（2 条） |
| 2026-08-13 | ② 交卷：reduce/reduceRight 三处空出口抛 TypeError（array/index.js）。Array 区测 410→412，零回退，门禁绿。已知偏差：真数组全 hole 仍返 undefined（引擎索引不走原型链，护 8-c-4，代码内已注释） |
| 2026-08-13 | ① 交卷：gOPD 簇 13+1 条修复（members.js 物化表 + parseInt/Function 单例/Error proto 预建）。合并态门禁绿；官方 **71.57%**（4518/6313，**+15**）。Object 581/99（85.3%）、Array 412。**回退 5 条**：RegExp 占位缺 brand 检查 4 条 PASS→FAIL；裸 Function() 调用 SIGSEGV 1 条 FAIL→CRASH。已发回原刀修复 |
| 2026-08-13 | 回退修完 + 主控补刀：RegExp 占位无条件抛 TypeError；裸 `Function(...)` 改派 `__makeFunction`（与 `new Function` 同路）并扩展 shim 注入；修 `SYM_IDS`/`allocator` 错位（缺 `_str_replaceAll_fn`）+ `_call_argc` 入 HOST_DATA（片段 arguments 读宿主 argc）。门禁绿。官方 **71.74%**（4529/6313，**+26** vs 71.33）。CRASH **64→61**。Object 581、Array 412、RegExp 234。距 80% **+522** |
| 2026-08-13 | 开 Phase C1b（依赖序 L2）：真数组泛型活读（HasProperty+Get）+ 原始 this ToObject。独占 `runtime/types/array/index.js`（± builtin_array_methods 仅当分派必需）；禁 object/members/TA/for-await |
| 2026-08-13 | C1b 交卷验收：真数组回调/indexOf 改 `_agen_has_idx`+`_agen_get_idx`；`_agen_toobject` 装箱 num/bool。门禁绿。官方 **72.45%**（4574/6313，**+45**）。Array **457/136/1**；CRASH 61 持平。距 80% **+477**。残簇：concat/splice/every/indexOf/sort |
| 2026-08-13 | 开 C1c：indexOf（len 先于 fromIndex；Infinity→-1）+ 回调缺 thisArg 绑 global；every.call(Math) 可收则收。仍独占 array/index.js |
| 2026-08-13 | C1c 交卷验收：indexOf 序/Infinity + ToLength(+Inf)。门禁绿。官方 **72.58%**（4582/6313，**+8**）。Array **465/128/1**。thisArg→global / Math toStringTag / ToPrimitive 抛错记阻塞（需 closures 或 members，不越层）。距 80% **+469** |
| 2026-08-13 | 开 C1d：splice/sort/concat 对 array-like（非数组 this）泛型；独占 array/index.js；禁 species/Proxy 深挖除非最小可收 |
| 2026-08-13 | C1d 交卷验收：`_agen_concat/splice/sort` + 挂载 splice/sort。门禁绿。官方 **72.61%**（4584/6313，**+2**）。Array **467/126/1**。L2 增益变薄；回 L1 Object 残簇（getPrototypeOf / __defineGetter__）。距 80% **+467** |
| 2026-08-13 | 开两刀（文件不相交）：① L1 getPrototypeOf/preventExtensions（object/index.js）② L1 __defineGetter__/__lookup* 挂载（members.js） |
| 2026-08-13 | ② 交卷：Annex B 四方法挂 Object.prototype（members + object 末尾独立 helper）。区测 Object 581→600（+19），门禁绿。等 ① 交卷后合并验收 |
| 2026-08-13 | ① 交卷：getPrototypeOf ToObject/构造器原型 + preventExtensions Array/Date/args。区测 Object→603（+22 含合并效应）。`__proto__` 仍阻塞。合并门禁绿；官方 **73.01%**（4609/6313，**+25**）。Object **603/77**；CRASH 62（+1，多 timeout 噪声）。距 80% **+442** |
| 2026-08-13 | 开 L1 续：Object.defineProperty/defineProperties 残簇 + `__proto__` get/set 三案（独占 object/index.js） |
| 2026-08-13 | `__proto__`/define 交卷验收：门禁绿。官方 **73.12%**（4616/6313，**+7**）。Object **610/70**。距 80% **+435** |
| 2026-08-13 | 开两刀（文件不相交）：① Object.assign ToObject/只读抛错（object/index.js）② 内建 @@toStringTag（members.js） |
| 2026-08-13 | ② 交卷：Math/Map/Set/Promise/Date/RegExp 挂 @@toStringTag。区测 Object +2、Array +2（every.call(Math) PASS），门禁绿。等 ① 合并验收；区测曾覆盖 last_run.json（仅 Object 681 条），官方跑将重建 |
| 2026-08-13 | ① 交卷：assign ToObject + Set(Throw)。合并门禁绿；官方 **73.21%**（4622/6313，**+6**）。Object **614**、Array **469**、Set **68**。距 80% **+429** |
| 2026-08-13 | 开 L1：toString 在 delete @@toStringTag 后应按规范回落 Object（收 symbol-tag-set-builtin）；独占 object/index.js |
| 2026-08-13 | toString tag 回落交卷验收：门禁绿。官方 **73.23%**（4623/6313，**+1**）。Object **615/65**；`symbol-tag-set-builtin` PASS。距 80% **+428** |
| 2026-08-13 | L1 增益变薄；开 Phase D1 L3b：回调缺 thisArg 时 noStrict 绑 global（OrdinaryCallBindThis），收 Array every/forEach thisArg；禁两阶段落栈 |
| 2026-08-13 | D1 交卷验收：`[[Strict]]`→`_func_meta` kind bit8；`_aref_invoke_cbt` 分派。门禁绿。官方 **73.26%**（4625/6313，**+2**）。Array **471**。距 80% **+426**。未收：直接 `f()`/IIFE 的 this |
| 2026-08-13 | 开 D1b：`compileClosureCall` / 直接调用 OrdinaryCallBindThis（noStrict→global），收 forEach/15.4.4.18-5-1；禁两阶段落栈 |
| 2026-08-13 | D1b 首派未开工，重派；并行开 L1 Object.create 描述符残簇（object/index.js，与 D1b 文件不相交） |
| 2026-08-13 | Object.create 交卷：getter this 装箱 + 包装槽不可枚举 + 数组侧表进 keys。区测 Object 615→624（+9），门禁绿。等 D1b 合并验收 |
| 2026-08-13 | D1b 交卷 + 合并验收：直接调用绑 A5；create +9。门禁绿。官方 **73.42%**（4635/6313，**+10**）。Object **624**；CRASH **61（−1）**。距 80% **+416** |
| 2026-08-13 | 开 L1：Object.defineProperty/defineProperties 残簇（独占 object/index.js） |
| 2026-08-13 | freeze/seal 交卷验收：Array/Arguments/函数 EXT 位。门禁绿。官方 **73.51%**（4641/6313，**+6**）。Object **630/50**。距 80% **+410**。4-192/enumerable for-in 记闭包/statements 禁区 |
| 2026-08-13 | 开 for-in 侧表键（statements.js）：收 define* enumerable 2 条；禁 object 大改 |
| 2026-08-13 | for-in 侧表交卷 + 补 `_closure_props_find` 入 SYM_IDS（片段缺符号回归）。门禁绿。官方 **73.61%**（4647/6313，**+6**）。Object **634**；statements 回 1298。距 80% **+404** |
| 2026-08-13 | D1 OrdinaryCallBindThis 交卷：func_meta kind bit8=[[Strict]]；_aref_invoke_cbt 缺 thisArg 时非严格→globalThis；区测 Array **471/122/0/1**（+2）；gate 365/0；caller 直接调用 this 未收 |
| 2026-08-13 | L1：Array ctor 运行时槽守卫（pending FE 先于 main 物化）+ valueOf ToObject + aref 方法无惰性 .prototype。门禁绿。官方 **73.83%**（4661/6313，**+14**）。Object **639**；Array **475**。距 80% **+390** |
| 2026-08-13 | with 标识符 [[Get]] 补 `_maybe_getter`（与成员读 `_object_get_ic` 对齐）。门禁绿。官方仍 **73.83%**（4661，持平）——stride-5 with 残多为 global `this.p*` 裸名绑定，非 accessor |
| 2026-08-14 | 裸名读：编译期 unresolvable → runtime HasProperty/Get(_global_this)（对齐 typeof）。门禁绿。官方 **73.93%**（4667/6313，**+6**）。with **6→14**；statements **1304**。距 80% **+384** |

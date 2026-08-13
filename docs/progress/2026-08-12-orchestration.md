# 2026-08-12 主控编排台账

> 角色：主控（本会话）  
> 上位蓝图：`plan.md`、`docs/ROADMAP.md`、`BOOTSTRAP_RULES.md`  
> 前序台账：`docs/progress/2026-08-05-master-plan.md`（当时 ~59%）  
> 协作协议：四象限；事实与假设分离；门禁由主控唯一执行

---

## 1. 共同已知（事实基线）

| 项目 | 真值 | 权威源 |
|------|------|--------|
| 分支 | `dev` @ `177197b43`（ahead 27 / behind 15 `qorm/dev`） | git |
| test262 | **70.19%**（4431/6313 stride-5） | `tests/test262/last_run_summary.json`（2026-08-13 官方全量） |
| 距 70% | **已过 M3**（目标 4420，实际 4431，+11） | 计算 |
| fixtures 门禁 | `BASELINE_FIXTURES=398`；PASS=365 XFAIL=33 FAIL=0 | `scripts/bootstrap-gate.sh` |
| CLI VERSION | **0.3.65**（cli.js / package.json / tag v0.3.65） | 源码 |
| 文档宣称 | README / CHANGELOG 已同步 v0.3.65 与 70.19% / fixtures 398 | 本轮已对齐 |
| 自举铁律 | ARM64 `gen1==gen2==gen3`；fixtures FAIL=0；探针≠安全证据 | `BOOTSTRAP_RULES.md` |
| 发布 | v0.3.65 小版本上主分支后再冲 M4 80% | 主人指令 |

### 架构一句话

JS → `lang/` → `compiler/` → VM IR → `backend/` → `asm/` → `binary/`；`runtime/*` 编译期 emit；NaN-boxing；分代 GC；G-M-P N>2（linux-arm64）。

### 相对 08-05 规划的校准

08-05 Wave1（Boolean/Symbol）已超额（Boolean **90%**、Symbol **68.8%**）；M1/M2（60%/65%）已过。本轮北极星改为 **M3：70%**，策略从「Object/Array 大地基」改为 **「内建独立岛并行 + Array 串行」**。

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

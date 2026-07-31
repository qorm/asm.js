# 2026-07-29 主控编排进度

> 本文档是本轮“整体分析 → 目录规划 → 多 agent 实施 → 红队复核”的实时台账。
> 上位蓝图：`docs/PROJECT_DIRECTORY_PLAN.md`。治理铁律：`BOOTSTRAP_RULES.md` §1.5/§2/§3。
> 历史背景：`docs/progress/2026-07-27-orchestration.md`、`docs/progress/2026-07-26-orchestration.md`。
> 本轮所有结论来自 5 路只读审计 agent 的实测（证据含 file:line 与命令输出），非实现者自述。

## 1. 当前事实基线（2026-07-29 审计实测，2026-07-30 更新至 Wave 4 后现状）

| 项目 | 当前值 | 证据 |
|---|---|---|
| 分支 / 提交 | `dev` / `a678f85`（v0.3.4 + 2 提交） | `git log`；最新 tag = `v0.3.4`（指向 main `3be02d8`） |
| 工作树 | 修改 19 文件（Wave 2/3/4 全部改动 + 用户既有 `cli.js` VERSION=0.3.5 与 test262 报告）；未跟踪：`.claude/`、`docs/PROJECT_DIRECTORY_PLAN.md`、`docs/progress/2026-07-{27,29}-orchestration.md`、`tests/platform_contract.mjs`；fixture 新增 `node_modules/type-commonjs-esm-bad/package.json` 被 gitignore（提交须 `git add -f`） | `git status --porcelain` |
| fixtures manifest 总数 | **385**（es 253 / modules 28 / node 104） | `find tests/fixtures -name fixture.json \| wc -l` |
| fixtures 门禁下限 | **385**（Wave 2 真值化后精确匹配，见 §8） | `scripts/bootstrap-gate.sh:21 BASELINE_FIXTURES=385`（原 380 系漏跑口径，已废） |
| 权威 runner 实跑 | `PASS=385 FAIL=0 XFAIL=0 XPASS=0`，退出码 0（Wave 4 后首次全绿） | `node scripts/run-fixtures.mjs`（385 全发现） |
| test262（已提交） | 2822/6462 = **43.67%**（FAIL 3423 / CF 40 / CRASH 177） | `git show HEAD:tests/test262/last_report.md:7` |
| test262（工作树，2026-07-30 可复现重跑） | 2836/6462 = **43.89%**（FAIL 3400 / CF 69 / CRASH 157） | `tests/test262/last_report.md:7`；runnerSha=a678f85、corpusPin=9e61c128、corpus 相对路径、reproduce URL 已固定；与早前复跑同分（PASS 稳定 2836，较已提交 v0.3.4 高 14） |
| 自举平台 | 仅 macOS-ARM64（原生）+ Linux-ARM64（Docker）保持 `gen1==gen2==gen3`；x64 三目标回退 | `compiler/functions/functions.js:659`（devirt 对 x64 关闭）；README:13/17/94 |
| 发布口径 | 最新 tag v0.3.4；cli.js VERSION=0.3.5（未提交）；README 中英已修至 v0.3.4 / 43.67%（Wave 2） | `git tag --sort=-creatordate`；README.md:11 |

## 2. 审计确认的现存偏差（全部实证）

### 2.1 fixture gate 假绿（P0）

- 权威 runner `scripts/run-fixtures.mjs` 本身完整且诚实：parse/compile/run/stdout/stderr/exitCode
  反向断言、自定义 `entry`、FAIL/XPASS 非零退出、knownFailure→XFAIL/XPASS 机制俱全。
- **但 `scripts/bootstrap-gate.sh:50` 调用的是简化版 `tests/run_fixtures.mjs`**，有两处失真：
  1. 要求 fixture 目录同时存在 `main.js`，静默漏掉 5 个自定义入口 manifest
     （`modules/cycle-function-call`、`cycle-root-no-call`、`cycle-tdz`、
     `cycle-top-level-function-read`、`module-count-33`），只跑 380/385。
  2. 对“应编译失败”的负向 fixture 仅在编译抛异常时判 pass；编译成功时因
     `exp.run=false` 跳过运行、`ok` 仍真而计为 PASS——2 个负向 fixture 被伪装成 PASS。
- 两个负向 fixture（`node/builtin-node-scheme-missing`、
  `node/packages/package-json-type-commonjs-rejects-esm`）均无 `knownFailure` 标记，
  在权威 runner 下是诚实 FAIL（产品缺口：编译器接受了本应拒绝的输入），在 gate 实际路径下是伪装 PASS。
- 结论：现行 gate 绿灯（`PASS=380 FAIL=0`、退出 0）由漏跑 + 伪装共同造成，非真值。

### 2.2 平台注册表双写 + 契约失败（P0/P1）

- `compiler/core/platform.js` 定义 TARGETS 且 `cli.js` 消费；但 `compiler/index.js:252-260`
  另有本地 `Targets` 表，构造器（`:265`）与 `compileFile`（`:1560`）实际用本地表，两表已分叉
  （本地表缺 windows-arm64 与全部别名）。
- `node cli.js --list-targets` 输出 7 行 `[object Object]`（`cli.js:211-213` 对对象字符串插值）。
- `node tests/platform_contract.mjs` **失败（退出 1）**：TARGETS 条目无 `release`/`experimental`
  字段，`:50` 的 `filter(t=>t.release)` 得空数组；`:69` 要求 `wasm32-wasi.experimental===true` 不满足。
- `new Compiler("windows-arm64")` 抛 Unknown target（暴露不可构造目标）；别名
  （`darwin-arm64` 等）过 `resolveTarget` 校验后在构造阶段崩（校验与构造不一致）。

### 2.3 文档事实冲突（P0/P1）

- README 中英 `Latest release v0.3.0` / test262 `39.74%`：落后真实 v0.3.4 / 43.67% 四版。
- `plan.md`：头部 `v1.5.52 / fixtures 362`、自称“唯一事实源”、内部三组矛盾
  （362 vs 380、20.4% vs 33.63% vs 43.67%、`版本号沿用 v1.5.x` vs 实际 0.3.x），S1 段停在 v0.2.6。
- `docs/ROADMAP.md:6/:26` 称“五目标 gen2==gen3 定点”，与 x64 回退口径直接冲突；
  `:217` 门禁引用死命令 `npm run test:fixtures`（package.json 无 scripts）。
- `tests/README.md:119` 称“362 个用例”（真实 385 manifest / 380 门禁）。
- `CHANGELOG.md` 停在 v0.3.0（无 v0.3.1–v0.3.4 条目），标题仍 `# jsbin — Changelog`。
- `package.json` 无 name/version/type/scripts；每次运行报 MODULE_TYPELESS_PACKAGE_JSON 警告。
- README 内部矛盾：`:172-173` 称“五目标每次变更后复核 gen2==gen3” vs `:13/17/94` 称 x64 回退。

### 2.4 安全失败开放 / 静默错编（P1，列入下一波）

- 失败开放：`crypto.createHash` 未知算法返确定性假摘要（`runtime/node/crypto.js:340-360`）；
  `createECDH` 空壳静默成功（`:1040`）；`setFips` 静默无操作（`:1042-1044`）；
  `randomInt` 取模偏差 + 无范围校验（`:1057-1066`）；`vm.js:7/14/17/20` 吞一切异常返 undefined/假值；
  `--lib/--lib-path` 被 `compiler/index.js:350-356` 收集后从无读取点，库根本没链接却报
  `Successfully compiled`（`cli.js:312-322`）；临时文件可预测路径（`cli.js:86-87`、
  `compiler/index.js:3076-3078`，均无 0700 mkdtemp）。
- 静默错编：`util.types` 大批谓词恒返 false（`runtime/node/util.js:181-206+`）。
- 正确失败关闭（无需动）：熵源 `randomBytes/randomUUID`、`scryptSync`、`timingSafeEqual`、
  `engine/compile.js compileFragment`、`--static`（ar 缺失即抛错）。

### 2.5 test262 可复现性 + x64（P1，列入下一波）

- corpus 未固定到 commit（`tests/test262/run.mjs:620` 用 `main.tar.gz` 移动目标）；
  summary 含本机绝对路径（`last_run_summary.json:4`）；不记录 corpus/runner SHA。
- 无 branch/reloc 范围断言（`engine/compile.js:441/458` rel32 位移经 `|0` 静默 32 位截断）；
  无提交在库的最小 x64 布局 repro。

## 3. 本轮目标与约束

### 目标（对齐 PROJECT_DIRECTORY_PLAN §7 停止条件）

1. fixture gate 从假绿修为单一权威 runner，结果按 PASS/XFAIL/FAIL/XPASS 诚实报告。
2. TargetCatalog 单源化，`platform_contract.mjs` 通过，`--list-targets` 不再 `[object Object]`。
3. 当前事实、目录计划、实施进度文档同步到真实基线。
4. 产品代码改动（platform 单源化触及 compiler/cli）过完整 bootstrap gate。
5. 独立红队二次 diff 审计，P0 无未处理项。

### 强制约束（源自 BOOTSTRAP_RULES + 项目记忆）

- 任何源码改动（含 x64-only 死代码）必须重跑 arm64 全链 `gen1==gen2==gen3`；探针字节不变不构成安全证据。
- 完整 bootstrap gate 只能由主控在主树串行执行；worktree 内不能跑（gitlink）。
- 一个文件同一时刻只有一个实施 owner；只读审计不取得 ownership。
- 不使用共享 `git stash`，不批量 `git add .`，不触碰用户 `.claude/`。
- 未经主人要求不提交（用户工作树已有未提交改动须原样保留，含 `cli.js` VERSION=0.3.5）。
- 红队不参与被审计实现，不接受实现者自测作为唯一证据。

## 4. Agent 编排（Wave 2：P0 真值恢复）

三个实施 agent **文件 owner 互斥**，并行于主工作树（禁 git 变更、仅改各自文件、仅跑各自局部测试）；
完整 gate 由主控串行收尾。安全（§2.4）与 test262 可复现（§2.5）列入 Wave 3，本轮不动以保持焦点。

| Agent | 角色 | 独占文件 | 局部验证 |
|---|---|---|---|
| `gate_impl` | fixture gate 真值化 | `scripts/bootstrap-gate.sh`、`tests/run_fixtures.mjs`（降级为薄包装）、2 个负向 fixture manifest（加 knownFailure）、`tests/README.md` | `node scripts/run-fixtures.mjs`：385 全发现，`PASS+XFAIL==385`、`FAIL=XPASS=0`；`bash scripts/bootstrap-gate.sh` 退出码正确 |
| `platform_impl` | TargetCatalog 单源化 | `compiler/core/platform.js`、`compiler/index.js`、`cli.js`、`tests/platform_contract.mjs` | `node --check`；`node tests/platform_contract.mjs` 通过；`node cli.js --list-targets` 无 `[object Object]`；逐目标 `new Compiler` 成功 |
| `facts_impl` | 事实单源化 | `README.md`、`README.zh-CN.md`、`plan.md`、`docs/ROADMAP.md`、`CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`package.json` | 路径/命令存在性；版本/数字与仓库可复核一致；`node cli.js --version` 仍正常 |
| `red_team`（Phase D） | 独立二次 diff 审计 | 只读 | 逐条复现上述声明；P0 假绿/静默错编/失败开放零未处理 |
| 主控（Phase E） | 串行集成 + 完整 gate + 文档同步 | 统一写入 | arm64 `gen1==gen2==gen3`；权威 fixture runner；台账更新 |

### 文件冲突规避说明

- `tests/README.md` 整体归 `gate_impl`（含 362 数字修正），`facts_impl` 不碰。
- `cli.js` 仅 `platform_impl` 碰（`--list-targets` 格式 + 别名构造）；须保留用户未提交的 VERSION=0.3.5。
  安全波的 `--lib/--lib-path`/TMP 改动也在 cli.js，故安全波排到本轮之后，避免同文件双 owner。
- `package.json` 归 `facts_impl`；本轮仅加 name/version/scripts，**暂不加 `type:"module"`**
  （会改变 Node 对整个仓库 .js 的模块解析，影响 gen1 宿主步，列为待决项）。

## 5. 分层验收矩阵（本轮）

| 变更面 | 必跑 |
|---|---|
| 文档（facts） | 路径/命令存在；版本/数字可由仓库文件复核；红队声明复核 |
| fixture runner / gate | runner 自身正负向；385 manifest 全发现；退出码；`PASS+XFAIL==TOTAL` |
| CLI / 平台目录 | `platform_contract.mjs`；`--list-targets`；逐目标构造；别名行为 |
| compiler/cli 产品改动 | 上述全部 + arm64 完整自举 `gen1==gen2==gen3`（主控串行） |

## 6. 风险与待决项

| 风险 | 等级 | 措施 |
|---|---|---|
| platform 单源化触及 compiler/cli，可能破自举 | 高 | platform_impl 仅过局部契约；完整 gate 由主控串行，失败则回退该 agent 改动 |
| 加 `type:"module"` 改变 Node 模块解析破 gen1 宿主步 | 中高 | 本轮不加；列为待决，需独立验证 |
| 2 个负向 fixture 标 XFAIL 掩盖真实产品缺口 | 中 | XFAIL 是 PLAN 认可的诚实中间态；manifest 注明对应产品缺口，转 Wave 3 修编译器 |
| 文档修数字引入新冲突 | 中 | facts_impl 以仓库可复核值为准；红队逐条复核 |
| 沙箱网络限制无法拉 corpus / 跑多平台 | 中 | 本轮不依赖网络；完整 gate 仅 arm64 本机，受限处如实记录不改写为通过 |

## 7. 变更日志

- 2026-07-29：创建台账。5 路只读审计完成：fixture gate / platform / facts 三切片判红（P0），
  security / test262-x64 判部分（P1）。确认 07-27 台账两项指控（门禁假绿、--list-targets 损坏）属实。
- 2026-07-29：定 Wave 2 三 agent（gate/platform/facts）派工，文件 owner 互斥；安全与 test262 可复现列入 Wave 3。
- 2026-07-29：Wave 2 三 agent 全部完成并各自局部验证通过；主控独立复核工作树（17 改动文件、`node --check`、`platform_contract.mjs` 退出 0、`--list-targets` 无 `[object Object]`、`--version` 保留用户 0.3.5），确认 owner 无越界。
- 2026-07-29：Phase D 独立红队四路（gate/platform/facts/regression）审计完成，全部判 concerns、**无 P0/P1**；red:regression 另在 /tmp 独立复现 `gen1==gen2==gen3` 逐字节一致。红队 P2/P3 文档失同步项（tests/README npm scripts、ROADMAP 两处“五目标”、plan.md fixture 下限 380→385 精确、WASM_DESIGN expectWasm 休眠注）已由主控修正；历史语境的 362 保留不改。
- 2026-07-29：Phase E 主控串行跑权威门禁 `bash scripts/bootstrap-gate.sh`，**退出 0**：`gen1==gen2==gen3` 逐字节定点 + fixtures `PASS=383 XFAIL=2 FAIL=0 XPASS=0`（发现 385 == 基线 385）。补 CHANGELOG v0.3.5（中英）。
- 2026-07-29：Wave 3 启动（主人“根据项目情况，进行完善”）。四路实施 agent（crypto/vm/link_tmp/t262，owner 互斥）完成：crypto 失败关闭（createHash/createHmac 未知算法抛错、createECDH 抛 not implemented、setFips(true) 抛 ERR_CRYPTO_FIPS_UNAVAILABLE、randomInt 拒绝采样+范围校验）、vm 去吞错、--lib/--lib-path 响亮失败、run/静态库临时文件 0700 mkdtemp、test262 corpus pin + runnerSha/corpusPin + 相对路径。crypto 差分对拍 Node 94/233 项一致。
- 2026-07-29：Wave 3 独立红队四路（crypto/shim/t262/regression）完成，rt:shim 与 rt:regression 判 pass、**无 P0/P1**。主控依红队 P2/P3 收口：createHmac 非法摘要错误形状对齐 Node（TypeError[ERR_CRYPTO_INVALID_DIGEST]）、_pbkdf2/_hkdf 增支持集校验（消除偶发 null 解引用）、setFips 注释澄清、TEST262_PIN 改回 9e61c128（与已提交数字的 2026-07-19 vendored corpus 一致）。
- 2026-07-29：Wave 3 主控串行跑权威门禁，**退出 0**：`gen1==gen2==gen3` 逐字节定点 + fixtures `PASS=383 XFAIL=2 FAIL=0 XPASS=0`（发现 385 == 基线 385），7 个 crypto fixture 全过。确认 --static 端到端 “Unknown label: _js_add” 为**既有** codegen 缺陷（asm/arm64.js:1603，本轮未碰，C_INTEROP_DESIGN.md B4 已登记），非本轮引入。
- 2026-07-30：Wave 4 启动（主人“继续”）。关闭 2 个 XFAIL 产品缺口：(1) `resolveModulePathUncached` 对未命中 shim 的 `node:` 说明符抛 “Unknown node: builtin module”（因 `node:not-real` 含连字符过不了 `isBareModuleName`，检查上提至裸名块之后统一拦截；仓库仅 node:buffer/node:process 两个 node: 导入，均已知）；(2) 显式 `package.json type:commonjs` 下含真实顶层 import/export 的 `.js` 拒绝编译（fixture 补齐缺失的 `type:commonjs` package.json——其描述本就声称测此行为；Node v25 对显式 commonjs 的 ESM 抛 SyntaxError，差分一致）。两个 fixture.json 去 knownFailure（恢复 HEAD 原貌）。
- 2026-07-30：Wave 4 首轮红队（node-scheme/commonjs-esm/regression）发现主控首版 FIX 2 的 **P0**：复用朴素子串 `cjsHasEsmSyntax` 使注释/字符串含 “export ” 的合法 CJS 被误拒（Node 接受）。主控改用 AST 层判定（`astHasRealTopLevelEsm` 只认真实顶层 Import/ExportDeclaration，排除 `__` 前缀合成 shim，`!_cjsFlags` 门控排除 CJS 包装合成的 export），并把损坏 package.json 改抛 ERR_INVALID_PACKAGE_CONFIG（P2）。
- 2026-07-30：Wave 4 复审红队（fix-verify/selfhost）发现 **P1**：`_cjsFlags` 键归一化不一致——`readModuleSource` 按原始（可相对）路径登记，门控按绝对 `ast.filename` 查表，致“相对路径编译 type:commonjs 下的 CJS 入口”漏命中门控被误拒。主控附加按 `path.resolve` 绝对路径登记一份（不替换原键，既有读者不受影响）修复。P3（`__` 前缀对恰以 `__` 命名的用户包过排除）保留宽前缀（规避误拒风险，已知窄边角入注释）；P2 注释夸大（包说明符路径损坏配置由 `resolvePackageSpecifier` 既有 catch 吞掉，本函数 throw 仅覆盖入口/相对路径）已澄清。
- 2026-07-30：Wave 4 主控串行跑权威门禁，**退出 0**：`gen1==gen2==gen3` 逐字节定点 + fixtures `PASS=385 XFAIL=0 FAIL=0 XPASS=0`（发现 385 == 基线 385）——两个原 XFAIL 转为真实 PASS，fixture **首次全绿**。新暴露/确认两处**既有**旁路缺陷（非本轮引入，列 Wave 5）：`looksLikeCjsSource` 复用朴素 `cjsHasEsmSyntax` 使注释/字符串含 “export ” 的 CJS 误判为非 CJS、import 之运行期崩 NULL object（HEAD 逐字相同，本轮仅解除编译期误杀使其显形）；`resolvePackageSpecifier` 对损坏 package.json `catch return ""`、经包说明符的导入被静默丢弃（Node 抛 ERR_INVALID_PACKAGE_CONFIG）。
- 2026-07-30：按固定 pin 9e61c128 重跑 test262 stride-5（runner SHA a678f85，399s），得 PASS=2836/6462=43.89%（FAIL 3400 / CF 69 / CRASH 157），与早前工作树复跑同分（PASS 稳定，较已提交 v0.3.4 的 43.67%/2822 高 14）。报告产物首次携带完整可复现元数据（runnerSha/corpusPin/相对 corpus 路径/固定 reproduce URL），Wave 3 可复现性收口至此完成；§1 基线同步刷新至 Wave 4 后现状。
- 2026-07-30：Wave 5 启动（主人选 **Object.defineProperty 杠杆**，test262 最大池）。调查发现“编译期字面量限制”已在 HEAD 修复（commit 07abf87 的动态描述符回退）；真实缺口是三处——ValidateAndApplyPropertyDescriptor 强制、ToPropertyDescriptor 校验、gOPD 对数组/全局/内建的覆盖。实施 Approach A（强制+校验，compiler/functions/functions.js + runtime/types/object/index.js）后 test262 一度升至 44.26%（Object 49.9%，+24 PASS），fixture 全绿、22 例基础差分与 Node 一致。
- 2026-07-30：Wave 5 独立红队（rt:enforcement）判 **fail**，发现三处 **P0 误拒合法输入**（均较基线回归）：①缺字段描述符（`{}`/`{writable:false}`）对 non-configurable/frozen 属性误抛 TypeError，且缺 value 时编译器传 undefined 做位模式比较、把既有值覆盖为 undefined；②absent `writable` 缺省 false，破坏 Node“未指定则保留原 writable”语义，致后续改值误抛；③`SameValue` 以位模式近似，等值异引用字符串（"ab" 与 "a"+"b"）误拒。另 P1/P2 残留：enumerable 变更与 accessor get/set 恒等未强制（漏拒）、数组完全绕过 enforcement、动态守卫双读 desc.get 致副作用描述符误拒、消息文案与 Node 不一致。rt:crash-selfhost 因 API SSL 证书主机名不匹配两次失败，CRASH+3 分诊与自举快路确认未完成。
- 2026-07-30：鉴于 P0 误拒不可合入、修复（字段存在位掩码）需稳定工具链迭代，而当日子代理 API 多次 SSL 失败（3 个 agent 因此终止/卡死）不可靠，主控决定**回退 Wave 5**：`git checkout HEAD -- compiler/functions/functions.js runtime/types/object/index.js`（仅这两文件受 Wave 5 触及，回退不影响已门禁的 Wave 2/3/4）。回退后 node --check 通过、P0 行为消失（恢复基线宽松语义）、19 个 Wave 2/3/4 改动文件完好。修复设计记入 §12，待工具链稳定后续做。回退后重跑 gate 与 test262 以刷新到干净基线。

## 8. 停止条件核对（PROJECT_DIRECTORY_PLAN §7）

| 条件 | 状态 | 证据 |
|---|---|---|
| fixture gate 从假绿修为单一权威 runner | 达成 | `bootstrap-gate.sh:59` 调 `scripts/run-fixtures.mjs`；门禁退出 0 |
| TargetCatalog 单源化且契约测试通过 | 达成 | 本地 `Targets` 表删除；`platform_contract.mjs` 退出 0 |
| 当前事实/目录计划/进度文档同步 | 达成 | README/plan/ROADMAP/CHANGELOG/package.json/本台账已对齐真实基线 |
| fixture 按 PASS/XFAIL/FAIL/XPASS 诚实报告 | 达成 | `PASS=383 XFAIL=2 FAIL=0 XPASS=0`，2 个负向 fixture 诚实 XFAIL |
| 产品代码改动过完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures 全绿，退出 0 |
| 独立红队二次 diff 审计、P0 无未处理 | 达成 | 四路红队无 P0/P1；P2/P3 已修 |

## 9. Wave 3 结果（安全失败开放收口 + test262 可复现性）

| 项 | 状态 | 证据 |
|---|---|---|
| crypto 失败关闭（createHash/createHmac 未知算法、createECDH、setFips、randomInt） | 达成 | 差分对拍 Node 一致；`_fallbackDigest` 删除；门禁 7 个 crypto fixture 全过 |
| createHmac 非法摘要错误形状对齐 Node（TypeError[ERR_CRYPTO_INVALID_DIGEST]） | 达成 | 主控依红队 P2 收口 |
| _pbkdf2/_hkdf 支持集校验（消除偶发 null 解引用） | 达成 | 主控依红队 P3 收口，干净抛 “Digest method not supported” |
| vm.js 去吞错（runInContext/runInThisContext/compileFunction/measureMemory 失败关闭） | 达成 | 差分对拍 node:vm 一致 |
| --lib/--lib-path 响亮失败（产出前非零退出） | 达成 | 真实退出码 1、不产出文件；发布流水线无依赖（grep 证实） |
| run / 静态库临时文件 0700 mkdtemp + 清理 | 达成 | 运行期采样 mode=700、跑完归零、ar 数组传参无 shell |
| test262 corpus 固定到 commit + runnerSha/corpusPin + 相对路径 | 达成 | TEST262_PIN=9e61c128（与已提交数字的 vendored corpus 一致）；summary 增 runnerSha/corpusPin；corpus 改相对路径 |
| 完整 bootstrap gate（编译类改动） | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `PASS=383 XFAIL=2 FAIL=0 XPASS=0`，退出 0 |
| 红队二次审计 P0 无未处理 | 达成 | 四路红队无 P0/P1；P2/P3 已由主控收口 |

## 10. Wave 4 结果（关闭 2 个 XFAIL 产品缺口）

| 项 | 状态 | 证据 |
|---|---|---|
| 未知 `node:` 内建说明符拒绝编译 | 达成 | `node:not-real` 等编译失败；已知 node:buffer/node:process 与裸名内建不受影响；五种解析入口全覆盖 |
| 显式 type:commonjs 下真实 ESM 的 .js 拒绝编译（AST 层判定） | 达成 | 差分对拍 Node v25 一致；fixture 补齐 type:commonjs package.json |
| AST 判定词法感知（注释/字符串/模板/正则/属性名含 export 不误拒） | 达成 | 红队 11 组用例矩阵；P0 子串误拒已改 AST |
| _cjsFlags 绝对路径键（修相对路径误拒 P1） | 达成 | 相对/绝对路径编译 type:commonjs 下 CJS 入口均通过 |
| 损坏 package.json 抛 ERR_INVALID_PACKAGE_CONFIG（入口/相对路径） | 达成 | P2 收口；包说明符路径既有 swallow 列 Wave 5 |
| 两个 fixture.json 去 knownFailure（恢复 HEAD） | 达成 | fixture 由 XFAIL 转真实 PASS |
| 完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `PASS=385 XFAIL=0 FAIL=0 XPASS=0`（首次全绿），退出 0 |
| 红队二次/复审审计 P0 无未处理 | 达成 | 首轮 P0（子串误拒）+ 复审 P1（键归一化）均已修并复验 |

提交注意：fixture 新增的 `node_modules/type-commonjs-esm-bad/package.json` 被 `.gitignore` 的 `node_modules/` 规则忽略，提交须 `git add -f`（仓库已有 22 个同类 force-track 先例，无需改 .gitignore）；否则干净 clone 会缺失该文件、使该 fixture 回归为 FAIL。

## 11. 后续演进待办（按优先级）

0. **~~Object/内建杠杆~~（v0.3.6 强制 → v0.3.7 补全 → v0.3.8 枚举 → v0.3.9 gOPD 数组 → v0.3.10 Date 具现，见 §13–§17）**：built-ins/Object 46.3% → 53.7% → 55.0% → 55.4% → 55.6% → **56.9%**（v0.3.10）；整体 43.89% → 44.55% → 44.69% → 44.75% → 44.77% → 44.91% → 45.90% → **46.98%**（v0.3.12，内建函数一等化 I5+I6 +70）；built-ins/Object 46.3% → **57.6%**。**距 70% 还需 ~+23pp（~1490 翻转）**。**Lever 1（内建函数一等化）已做 I5（name/length 登记）+ I6（[[Set]]/[[Delete]] 语义），合计 +70**。**下一步杠杆（按 翻转/难度）**：①**【最高价值】I3 暴露缺失 Array.prototype 方法**（flat/flatMap/fill/find/keys/values/entries/sort/splice/concat/copyWithin，~48-65；`[1].values`/`[1].flat` 现 undefined，需 `_aref_generic`-safe wrapper）；②**I2 物化 Map/Set/Promise 构造器 + prototype**（~38-61，中高风险——13 SIGSEGV + species/subclass；Map/Set helpers 已存在）；③**I1/I4 JSON/Number 静态 + String.fromCodePoint/fromCharCode**（~6-16，廉价 drive-by；JSON 现为每次新建空对象致值读 undefined）；④**补全解析器早期错误**（类别 A 对象模式绑定点 + Tier 2/3，~187+）；⑤**缺失内建方法 + String 迭代/Symbol 协议**（Lever 4 余项，~150-230）；⑤**Date 加固**（修 11 个边角 SIGSEGV：`_aref_date_*` this 类型检查、setter 实参强转、Symbol.toPrimitive、扩展年份 toString、`class extends Date`）；⑥其余内建构造器具现（Object/Array/Function/Number/Boolean/Error/JSON + prototype，复用 Date/Math 模板）；⑦全局对象具现 + 顶层 `this`；⑧`new String` 索引字符 + `JSON.stringify(new String)`；⑨原语字符串/TypedArray 元素描述符；⑩RegExp source/flags 移到 prototype 以对齐 gOPN；⑪**突发完成传播 + TDZ**（Lever 5，~400-570，最高但最难/最高风险）；⑫async fn/generator/for-await-of。**说明**：top 5-6 杠杆约到 58-63%；70% 需 ~12 簇含至少一个硬语义杠杆 + async 进展。
1. **looksLikeCjsSource 运行期 CJS 误判（P2，既有，Wave 4 暴露）**：复用朴素 `cjsHasEsmSyntax`，注释/字符串/模板/正则里含 “export ”/“import ” 文字的 CJS 被判为非 CJS、不做 CJS 包装，`import` 之运行期崩 `FATAL: _object_set called with NULL object`（Node 正常执行）。HEAD 逐字相同、与 Wave 4 无关；Wave 4 仅解除编译期误杀使其显形。彻底修复需把 CJS 检测改 AST/词法感知（与 Wave 4 的 `astHasRealTopLevelEsm` 同源思路）。
2. **resolvePackageSpecifier 损坏 package.json 静默丢弃（P2，既有）**：`compiler/index.js:3837-3838` 对损坏 JSON `catch return ""`，经包说明符的导入被静默丢弃、编译成功（Node 抛 ERR_INVALID_PACKAGE_CONFIG）。与 `nearestPackageJsonExplicitCommonjs` 的抛错路径不一致。
3. **--static 端到端 codegen 缺陷（P2，既有）**：含导出函数的程序 `--static` 在 `asm/arm64.js:1603` 报 “Unknown label: _js_add”（在 writeStaticLibrary 之前）。C_INTEROP_DESIGN.md B4 已登记。修复须过完整门禁。
4. **package.json `type:"module"`（待决）**：消除 MODULE_TYPELESS_PACKAGE_JSON 警告；须先验证不改坏 gen1 宿主步（Node 对仓库 .js 的模块解析）。
5. **util.types 谓词恒 false（P3）**：`runtime/node/util.js:181-206+` 大批 `util.types.*` 返回与输入无关的 false。功能面广、安全影响低。
6. **wasm fixture 回归入口（P3）**：权威 runner 重新支持 expectWasm/ASMJS_FIXTURE_WASM（约 4 个 fixture 的 wasm 断言当前休眠）。
7. **astHasRealTopLevelEsm 的 __ 前缀窄边角（P3）**：用户裸名导入恰以 “__” 开头（如 `import x from "__foo"`）会被当作合成 shim 排除而漏拒；保留宽前缀以规避误拒风险，已知 limitation。
8. **test262 数字按固定 pin 复跑（可选）**：当前已提交数字（43.67%）出自 2026-07-19 vendored corpus；pin 已对齐该快照。若要刷新到更新 corpus，需重下 + 复跑 + 刷新报告（顺带使产物带 runnerSha/corpusPin）。

## 12. Wave 5 尝试与回退详情（Object.defineProperty 杠杆）

### 12.1 调查结论（重 định框架）

“Object.defineProperty 仅接受编译期字面量描述符”的限制**已在 HEAD 修复**（commit 07abf87 的 [W-13] 动态描述符回退，built-ins/Object 193→278）。剩余 built-ins/Object 缺口（682 run / 316 PASS / 357 FAIL / 9 CRASH，stride-5）由三处**仍缺的语义**驱动：

| 缺口 | 量级 | 现状 |
|---|---|---|
| ValidateAndApplyPropertyDescriptor 强制 | ~77（+语料全局 463× verifyProperty 的大头） | 重定义 non-configurable、非扩展新键、writable false→true 等应抛 TypeError，当前静默成功 |
| ToPropertyDescriptor 校验 | ~13 | `{set:true}`/`{get:42}`/data+accessor 混用应抛 TypeError，当前接受 |
| gOPD 覆盖 | ~25 + 内建反射 | gOPD 仅对 TYPE_OBJECT/classinfo/Proxy 返回描述符，数组 length/下标、全局对象、内建构造器返回 undefined |

实施 Approach A（强制+校验）后 test262 一度升至 44.26%（Object 49.9%，+24），fixture 全绿、22 例基础差分与 Node 一致；运行时属性模型（attr 位、accessor、freeze/seal）本就完备，缺口在强制/校验/路由而非存储。自举零风险（编译器运行期不调 Object.defineProperty）。

### 12.2 红队判 fail：三处 P0 误拒合法输入（均较基线回归）

1. **缺字段描述符误抛 + 毁值**：`{}`/`{writable:false}` 对 non-configurable/frozen 属性抛 TypeError（Node 不抛）；根因——缺 value 时编译器发 undefined 作新值并做位模式 SameValue 比较（functions.js ~:3892），运行时 `_object_set_plain` 无条件覆写（object/index.js ~:2587）；`{}` 对 accessor 被误判 data↔accessor 切换（~:2657）。
2. **缺省 writable 误抛**：writable 仅从字面量 true 提取，缺席→false（functions.js ~:3810），破坏 Node“未指定保留原 writable”语义；后续改值时被新校验误抛。
3. **字符串 SameValue 位模式近似**：等值异引用字符串（"ab" 与 "a"+"b"）位模式不等→误拒（object/index.js ~:2676 `cmp(V1,S2)`）。

P1/P2 残留：enumerable 变更与 accessor get/set 恒等未强制（漏拒）、数组完全绕过 enforcement（`_object_set_array` 在读 define 标志前分流）、动态守卫双读 desc.get 致副作用描述符误拒、TypeError 消息文案与 Node 不一致、Map/TypedArray defineProperty 静默空操作（既有）。

### 12.3 回退

`git checkout HEAD -- compiler/functions/functions.js runtime/types/object/index.js`（仅这两文件受 Wave 5 触及）。回退后 node --check 通过、P0 行为消失、19 个 Wave 2/3/4 文件完好、gate 复跑 `PASS=385` 全绿 + `gen1==gen2==gen3` 定点、test262 刷新回 43.89%（2836/6462，runnerSha=a678f85、corpusPin=9e61c128）。
- 2026-07-30：**发布 v0.3.5 并推送**（commit 39d7e79，tag v0.3.5，branch dev → qorm/asm.js）：Wave 2/3/4 全部改动 + 文档；fixture 套件首次全绿（385/0）、test262 43.89%（2836/6462，经固定 corpus + runnerSha/corpusPin 可复现）。
- 2026-07-30：Wave 6 按 §12 字段存在位掩码设计**重做** Object.defineProperty 杠杆（编译器把 `(mask<<8)|attr` 经 A5 传入新增运行时 helper `_object_define_property`；HAS_VALUE/WRITABLE/ENUMERABLE/CONFIGURABLE/GET/SET）。主控独立差分复验：三处曾误拒用例（缺字段 `{}`、frozen `{}`、accessor `{}`、缺省 writable 保留、字符串内容 SameValue）全部与 Node 一致（P0 已规避）；基础强制（重定义 non-configurable、非扩展新键、data↔accessor 切换、非 callable get/set、data+accessor 混用静态）正确抛 TypeError。
- 2026-07-30：Wave 6 门禁绿（`gen1==gen2==gen3` 逐字节 + fixtures `385/0/0/0`）；test262 升至 **44.55%（2879/6462，+43）**、built-ins/Object **53.7%（366/682，+50）**。残留 4 处宽松欠强制（动态非对象描述符未拒、动态 data+accessor 混用未拒——动态路径仍先脱糖、non-config+non-writable 改值未强制——需内容 SameValue）严格优于旧“一律接受”、列入后续。**发布 v0.3.6 并推送**。注：本周期子代理 API 多次 SSL 证书主机名不匹配（4+ 个 agent 终止/卡死），Wave 6/7 的验证以主控差分电池 + 门禁为主。
- 2026-07-30：Wave 7 补全 v0.3.6 遗留四处 defineProperty 缺口：①non-configurable + non-writable 改值强制（内容 SameValue：字符串按 `_getStrContent`+`_strcmp` 比内容，否则全 64 位位模式，0/-0 抛、NaN==NaN；顺带修键相等快路屏蔽小 double 高位的旧假相等）；②动态路径非对象描述符拒绝；③动态 data+accessor 混用拒绝（动态路计算完整掩码经 `_object_define_property`，不再先脱糖）。实现途中修两处自引入回归（动态字段存在读取器数组 SIGSEGV → 改 `_object_get`；`_maybe_getter` 按 [[Get]] 调访问器值字段）。
- 2026-07-30：Wave 7 主控独立差分 25 例与 Node 全一致（四处缺口 + P0 误拒守卫 + SameValue 边角），fixtures `385/0/0/0`；门禁绿（`gen1==gen2==gen3` + 385）。test262 44.55% → **44.69%（2888，+9）**、built-ins/Object 53.7% → **55.0%（375，+9）**。净 +9 = +12 − 3：3 个损失（create/15.2.3.5-4-35、defineProperties/15.2.3.7-5-b-241/-246）由**既有** `Object.keys` 对奇异对象（RegExp/`new String()` 内部槽）过度枚举 bug 被本次正确收紧的“描述符须对象”校验暴露（基线仅因旧宽松路静默忽略侥幸通过），列为下一目标。**发布 v0.3.7 并推送**。
- 2026-07-31：Wave 8 修复 `Object.keys` 对奇异包装对象过度枚举。根因：RegExp（`__regexp_shim` 的 `__RE_new`）与 `new String` 包装把内部槽存为默认可枚举自有属性、无 flags 表（flags_ptr==0 → 全枚举），而枚举行走器本就遵循 ATTR_ENUMERABLE。修复在构造时标内部槽不可枚举：RegExp shim 对 16 槽各 `Object.defineProperty {writable,non-enumerable,configurable}`；`new String` codegen 对 `__value`/`length` 发 `_object_set_attr`（attr=5）；`_object_assign` 补 ATTR_ENUMERABLE 过滤。
- 2026-07-31：Wave 8 主控独立差分 27 例与 Node 全一致（枚举 + RegExp/String 功能 + create/defineProperties 机制），fixtures `385/0/0/0`，门禁绿（`gen1==gen2==gen3` + 385）。test262 44.69% → **44.75%（2892，+4）**、built-ins/Object 55.0% → **55.4%（378，+3）**——收回 v0.3.7 暴露的 3 个 wrapper-as-properties-map 用例（create/15.2.3.5-4-35、defineProperties/...-241/-246）。**发布 v0.3.8 并推送**。
- 2026-07-31：Wave 9 gOPD 数组支持 + undefined/null 抛 TypeError。调查发现 gOPD 目录实为 **131 PASS / 179 FAIL**（远超此前 ~25 的步进采样估计），且更深根因是**内建构造器非运行时对象**（`typeof Object` 为 "number"，仅 Math 经特化具现）。本波先做最低风险的运行时增量：`runtime/types/object/index.js` 的 `_object_getOwnPropertyDescriptor` 新增 `TYPE_ARRAY` 分支（按规范合成 length / 索引元素 / 侧表具名描述符，arguments 同覆盖）+ 序言对 undefined/null 目标抛 TypeError。纯新增 +104 行、零改既有指令。
- 2026-07-31：Wave 9 主控独立差分 24 例与 Node 全一致（数组 length/索引/越界/非规范/具名、arguments、undefined/null 抛 TypeError、num/bool 不抛 + plain-object/function/Math 回归守卫），fixtures `385/0/0/0`，门禁绿（`gen1==gen2==gen3` + 385）。test262 44.75% → **44.77%（2893，+1）**、built-ins/Object 55.4% → **55.6%（379，+1）**、gOPD 目录 stride-1 131 → 134（+3）。两处既有残留（纯新增未触、非本波引入）：`gOPD(函数变量,"length")` 经运行时路径返 undefined、`new String` length attr 偏差。**发布 v0.3.9 并推送**。下一步：内建构造器具现（Date 优先 ~50 翻转）+ 全局对象/顶层 this。
- 2026-07-31：Wave 10 具现 Date 内建为真运行时对象（闭包构造器模板，仿 String/RegExp）。新增 emitDateCtorObject/emitDateProtoObject（members.js +248）+ `_date_call` 与 `_aref_date_*` 装箱包装（runtime/types/date/index.js +120）+ 闭包属性 attr 工作（`_closure_props_ensure` + `_object_set_prop_attr`，object/index.js +17）。裸 Date 标识符与 Date.prototype 读取作晚分支接入，四条按名语法快路（静态调用/方法派发/new Date/instanceof）不受影响。
- 2026-07-31：Wave 10 主控独立差分 25 例与 Node 全一致（typeof Date=function、typeof Date.prototype=object、identity、gOPD(Date, now/parse/prototype)、gOPD(Date.prototype, getTime)、泛型 .call、全部既有 Date 回归守卫 instanceof/Date.now/getters/setters/parse/UTC/valueOf）。fixtures `385/0/0/0`，门禁绿（`gen1==gen2==gen3`）。test262（整体 stride-5）44.77% → **44.91%（2902，+9）**、built-ins/Object 55.6% → **56.9%（388，+9）**、built-ins/Date（单独非计分）24/117 → 39/117（+15）。
- 2026-07-31：Wave 10 已知残留（built-ins/Date 非计分子集）：经 prototype 现可达的 **11 个边角 SIGSEGV**——5× 非对象 this（`_aref_date_*` 无防护读 `[this+8]`，本应抛 TypeError：getDate/getMinutes/getUTCDate/getUTCMinutes/setSeconds/setFullYear 的 this-value-non-object）、2× setter 实参 ToNumber 强转（setHours/arg-ms、setSeconds/arg-sec）、1× Symbol.toPrimitive/called-as-function、1× toString/negative-year（扩展年份格式）、1× subclassing（class extends Date）。具现前 Date.prototype 为 undefined，这些测试在 undefined 上抛预期 TypeError 计 PASS；具现后可调用方法在边角输入上崩溃。列 Date 加固波次。**发布 v0.3.10 并推送**。注：本波实施 agent 因 token-plan 5 小时配额耗尽（429，07-31 09:00 UTC 重置）于验证途中终止，主控自行完成差分/fixtures/门禁验证与发布；配额恢复前暂停子代理波次。
- 2026-07-31：Wave 11 解析器早期错误强制（Lever 3 SAFE 层）。主人指示“继续一直到 70% 能才停”。先做 FAIL 模式分析（top 杠杆排序 + 距 70% 缺口分析），再实现解析器早期错误安全层（附加 `this.errors.push`，按阶段计分）：D rest 尾逗号、F 类 constructor/prototype 命名、E 类私有名校验、B use-strict 非简单形参（箭头+对象方法）、C 严格重复形参（扩展继承严格）、G 杂项语法、A 严格/上下文保留字作绑定（含转义、eval/arguments）。类别 A 因实施 agent token 配额（再次 429，重置 14:01 UTC）途中截断（对象模式绑定点部分未完成）；主控补 eval/arguments 严格绑定检查并验证严格门控正确（严格拒 public/eval/arguments/重复形参，sloppy 允许 yield/f(a,a)）。
- 2026-07-31：Wave 11 验证：完整 test262 44.91% → **45.90%（2966，+64，集中 language/：expressions 990→1024、statements 806→836）**，**零 PASS→COMPILE_FAIL 误拒**；fixtures 385/0/0/0；门禁绿（gen1==gen2==gen3）。**发布 v0.3.11 并推送**。剩余早期错误（Tier 2/3 + 类别 A 对象模式绑定点）与其余杠杆列 §11。
- 2026-07-31：Wave 12 内建函数一等化（Lever 1）。调查确认 `.call/.apply/.bind` 已对任意 0x7FFF 闭包可用，失败全因内建未物化为闭包值；最佳首增量 I5（已物化内建函数值登记正确 name/length，最低风险）。
- 2026-07-31：I5 实施（members.js 五个闭包构建点补逐闭包 name/length + object/index.js `_js_length_dyn`/`_fn_has_own`/`_prop_in` 闭包分支 + 修正错 arity）。差分 ~104 例与 Node 全一致，fixtures 385/0/0/0，test262 2966 → 2972（+6，零误拒），门禁绿。仅 +6（非预估 ~55）：name/length 的 [[Set]]/[[Delete]] 语义未强制（`fn.name=x` 生效、delete 后元数据复活），~40+ verifyProperty 探针仍败——即 I6。
- 2026-07-31：I6 实施（`_closure_prop_set` name/length 写守卫 + `_object_delete` 函数值墓碑 0x84 + 墓碑感知读路径 `_closure_prop_get`/`_js_length_dyn`/`_fn_has_own`/`_prop_in`/`_ogopd_fn` + `_object_set` 追加复位 flags）。差分 39 例与 Node 全一致，fixtures 385/0/0/0（途中修 2 回归），test262 2972 → **3036（+64，较 v0.3.10 基线 +70）**，byArea Object 57.6%/Math 69.2%/Array 48.8%/String 38.5%，零误拒。门禁绿（gen1==gen2==gen3）。**发布 v0.3.12 并推送**。残留与下一杠杆（I3/I2/I1·I4）列 §11。

### 12.4 重做设计（字段存在位掩码）

核心：编译器向运行时强制路径传递**字段存在位掩码** `HAS_VALUE=1 / HAS_WRITABLE=2 / HAS_ENUMERABLE=4 / HAS_CONFIGURABLE=8 / HAS_GET=16 / HAS_SET=32`，运行时**仅对描述符实际指定的字段**强制/比较：

- 静态字面量路径（functions.js ~:3768-3832）：从 ObjectExpression 实际出现的属性计算掩码；保持字面量快路字节不变（只在畸形/重定义时走新校验）。
- 动态路径（emitDefinePropertyDynamic ~:821-899）：运行期以 hasOwnProperty/`!== undefined` 计算掩码，**每字段只读一次**（修双读 P2）。
- 运行时强制（object/index.js define 路径 ~:2519-2742）：仅当 HAS_VALUE 时比较/覆写 value（否则保留现值，杜绝 undefined 覆写）；仅当 HAS_WRITABLE 时变更 writable（否则保留当前位）；data↔accessor 切换仅在描述符确含 get/set 或 value/writable 时判定（空 `{}` 不触发）；SameValue 两侧皆字符串时按**内容**相等（复用既有字符串相等路径），否则位模式（数值/布尔/对象同一性），NaN 等于 NaN；保留已正确的强制（non-configurable 提升 configurable、writable false→true、non-config+non-writable 改值、非扩展新键、真实 data↔accessor 切换、ToPropertyDescriptor 校验）。
- 验收：红队全部 P0/P1 复现用例与 Node 一致（不误拒、该拒仍拒）；fixture 385/0/0/0；test262 ≥ 基线（修误拒应使部分 FAIL→PASS，预期 Object ~50%、整体 +20~40）；gen1==gen2==gen3 定点。
- 前置条件：稳定的子代理工具链（本轮回退当日 API 多次 SSL 证书主机名不匹配，3 个 agent 终止/卡死，无法可靠迭代与红队复验）。

## 13. Wave 6 结果（Object.defineProperty 强制，v0.3.6）

按 §12 字段存在位掩码设计重做成功。编译器把 `(mask<<8)|attr` 经 A5 传入新增运行时 helper `_object_define_property`（runtime/types/object/index.js，约 +486 行），仅对描述符实际指定的字段强制。

| 项 | 状态 | 证据 |
|---|---|---|
| ToPropertyDescriptor 校验（非 callable get/set、data+accessor 混用 → TypeError） | 达成 | 差分对拍 Node 一致（v1-v4/v6，静态+动态） |
| ValidateAndApplyPropertyDescriptor 强制（重定义 non-configurable、非扩展新键、data↔accessor 切换 → TypeError） | 达成 | 差分对拍 Node 一致（e1/e2/e4/e5） |
| 字段存在位掩码规避 P0 误拒（缺字段 `{}`、缺省 writable 保留、字符串内容 SameValue） | 达成 | 三处曾误拒用例（P0a–P0f）全部与 Node 一致 |
| 完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `385/0/0/0`，退出 0 |
| test262 提升 | 达成 | 整体 43.89% → **44.55%**（2879/6462，+43）；built-ins/Object 46.3% → **53.7%**（366/682，+50） |
| 发布 | 达成 | v0.3.6 已推送（branch dev + tag） |

残留缺口（宽松欠强制，严格优于旧“一律接受”，列后续）：

1. 动态路径非对象描述符（`defineProperty({},k,42)`）未拒（mask=0 短路在 `_dp_require_object` 之前）。
2. 动态 data+accessor 混用未拒（`emitDefinePropertyDynamic` 仍先脱糖为 accessor 或 data，混用到不了 helper 的 `_dp_nomix`）。
3. non-configurable + non-writable 属性改值未强制（helper `_dp_old_data` 分支缺值比较；需按内容比较字符串的 SameValue）。
4. gOPD 对数组 length/下标、全局对象、内建构造器返回 undefined（~25 FAIL + 内建反射）。

## 14. Wave 7 结果（defineProperty 缺口补全，v0.3.7）

补全 §13 所列四处缺口中的三处（①②③），仅余 gOPD 覆盖（④，见 §11）。

| 项 | 状态 | 证据 |
|---|---|---|
| ① non-configurable + non-writable 改值强制（内容 SameValue） | 达成 | e3/e6 与 Node 一致抛；字符串按内容比、0/-0 抛、NaN==NaN、同值/同引用不抛 |
| ② 动态路径非对象描述符拒绝 | 达成 | v5（42 / undefined）与 Node 一致抛 TypeError |
| ③ 动态 data+accessor 混用拒绝 | 达成 | v7 与 Node 一致抛（动态路计完整掩码经 `_object_define_property`，不再先脱糖） |
| 完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `385/0/0/0`，退出 0 |
| test262 | 达成 | 整体 44.55% → **44.69%**（2888，+9）；built-ins/Object 53.7% → **55.0%**（375，+9） |
| 发布 | 达成 | v0.3.7 已推送（branch dev + tag） |

净 +9 = +12 增益 − 3 损失。3 个损失（create/15.2.3.5-4-35、defineProperties/15.2.3.7-5-b-241/-246）根因为**既有** `Object.keys` 对奇异对象（RegExp/`new String()`）过度枚举内部槽：用奇异对象作属性表时 `Object.keys` 返回 source/flags 等内部槽名，defineProperties 取其值（字符串/原语）作描述符 → v0.3.7 正确的“描述符须对象”校验抛错；基线因旧宽松路静默忽略非对象描述符侥幸通过。修复 `Object.keys` 奇异对象枚举即可收回（列 §11 新首要）。

实现途中修掉两处自引入回归：动态字段存在读取器 `_prop_in` 对数组只判数值索引、装箱键经数组路径 `loadByte` → SIGSEGV（改 `_object_get` 读一次 + `!== undefined` 判 presence）；`_object_get` 对访问器属性只返 getter 标记块，须继以 `_maybe_getter`（this=desc）调其 getter 取真值（对齐 [[Get]]），否则描述符上由访问器提供的字段被当标记块误判（回收 18 个 Object 用例）。

## 15. Wave 8 结果（Object.keys 奇异包装对象枚举修复，v0.3.8）

根因：枚举行走器（keys/values/entries/for-in）本就遵循每属性 ATTR_ENUMERABLE 位；bug 在 RegExp（`__regexp_shim` 的 `__RE_new`）与 `new String` 包装把内部槽存为默认可枚举自有属性、无 flags 表（flags_ptr==0 → 全枚举）。

| 项 | 状态 | 证据 |
|---|---|---|
| RegExp 16 个内部槽构造时标不可枚举（writable/configurable 保留） | 达成 | `Object.keys(new RegExp("a","g"))` == []（Node []）；功能 test/source/flags/match/exec/lastIndex/replace/split 完好 |
| new String 的 __value/length 标不可枚举 | 达成 | Object.keys 不再含 __value/length；valueOf/toString/length/toUpperCase 完好 |
| _object_assign 补 ATTR_ENUMERABLE 过滤 | 达成 | `Object.assign({}, new RegExp(...))` == {}（Node {}） |
| 完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `385/0/0/0` |
| test262 | 达成 | 整体 44.69% → **44.75%**（2892，+4）；built-ins/Object 55.0% → **55.4%**（378，+3）——收回 v0.3.7 暴露的 3 个 wrapper-as-map 用例 |
| 发布 | 达成 | v0.3.8 已推送（branch dev + tag） |

延期项（列 §11）：①gOPD 对数组/全局/内建覆盖（并把 RegExp source/flags 移到 prototype 以对齐 gOPN 的 `["lastIndex"]`）；②`new String` 自有可枚举索引字符；③`JSON.stringify(new String(...))` 序列化为原始字符串。

## 16. Wave 9 结果（gOPD 数组支持 + undefined/null TypeError，v0.3.9）

调查发现 gOPD 目录实为 131 PASS / 179 FAIL（步进采样曾低估为 ~25）；更深根因是内建构造器非运行时对象（`typeof Object` 为 "number"，仅 Math 具现）。本波做最低风险的运行时增量。

| 项 | 状态 | 证据 |
|---|---|---|
| TYPE_ARRAY gOPD 分支（length / 索引 / 侧表具名 / arguments） | 达成 | `gOPD([1,2,3],"length")`={v:3,w:true,e:false,c:false}；"0"={v:1,w,e,c}；越界/非规范键 undefined；`a.foo=9` 具名描述符；arguments "0" 受理 |
| gOPD 序言 undefined/null 目标抛 TypeError | 达成 | `gOPD(undefined/null,"x")` 抛 TypeError；num/bool 不抛（与 Node 一致） |
| 完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `385/0/0/0`（纯新增 +104 行、零改既有指令） |
| test262 | 达成 | 整体 44.75% → **44.77%**（2893，+1）；Object 55.4% → **55.6%**（379，+1）；gOPD 目录 stride-1 131 → 134（+3） |
| 发布 | 达成 | v0.3.9 已推送（branch dev + tag） |

既有残留（纯新增未触，列 §11）：`gOPD(函数变量,"length")` 运行时路径返 undefined；`new String` length attr 偏差；原语字符串/TypedArray 元素描述符；内建构造器/全局 gOPD 覆盖（下一步最高价值）。

## 17. Wave 10 结果（Date 内建具现，v0.3.10）

Date 由哨兵数值（typeof "number"）具现为真闭包构造器对象（仿 String/RegExp 模板）。

| 项 | 状态 | 证据 |
|---|---|---|
| Date 闭包构造器（typeof "function"，name="Date"，length=7，_date_call 可调用） | 达成 | typeof Date === "function"；Date === Date 恒等 |
| Date.prototype 真对象（全部方法自有属性 attr 5 + constructor 回指） | 达成 | typeof Date.prototype === "object"；Date.prototype === Date.prototype 恒等 |
| 静态方法 now/parse/UTC（attr 5）+ prototype（attr 0） | 达成 | gOPD(Date,"now"/"parse")={w:true,e:false,c:true}；gOPD(Date,"prototype")={w:false,e:false,c:false} |
| 原型方法 gOPD + 泛型 .call | 达成 | gOPD(Date.prototype,"getTime")={w:true,e:false,c:true}；Date.prototype.getTime.call(new Date(1000))===1000 |
| 既有 Date 行为保留 | 达成 | 25 例差分全一致：instanceof/Date.now/new Date(0).getTime/getFullYear/getMonth/getDate/getDay/parse/UTC/valueOf/setTime |
| 完整 bootstrap gate | 达成 | gen1==gen2==gen3 逐字节 + fixtures 385/0/0/0（自举期发射零字节，编译器仅调用/new/instanceof 位用 Date） |
| test262 | 达成 | 整体 44.77% → **44.91%**（2902，+9）；Object 55.6% → **56.9%**（388，+9）；built-ins/Date（非计分）24/117 → 39/117（+15） |
| 发布 | 达成 | v0.3.10 已推送（branch dev + tag） |

已知残留（built-ins/Date 非计分子集，列 §11 ①）：经 prototype 现可达的 11 个边角 SIGSEGV——

- 5× 非对象 this（this-value-non-object：getDate/getMinutes/getUTCDate/getUTCMinutes/setSeconds/setFullYear）：`_aref_date_*` 包装无防护读 `[this+8]`，本应抛 TypeError。
- 2× setter 实参 ToNumber 强转（setHours/arg-ms-to-number、setSeconds/arg-sec-to-number）。
- 1× Symbol.toPrimitive/called-as-function。
- 1× toString/negative-year（扩展年份 ±YYYYYY 格式）。
- 1× subclassing（class extends Date）。

具现前 Date.prototype 为 undefined，这些测试在 undefined 上抛预期 TypeError 计 PASS；具现后可调用方法在边角输入上崩溃。修复方向：`_aref_date_*` 加 this 类型检查（非 Date 对象抛 TypeError）、setter 实参强转、Symbol.toPrimitive、扩展年份格式、子类化支持。

实施注：本波实施 agent 因 token-plan 5 小时配额耗尽（429，07-31 09:00 UTC 重置）于验证途中终止；主控自行完成独立差分（25 例与 Node 全一致）、fixtures（385/0/0/0）、门禁（gen1==gen2==gen3）验证与发布。

## 18. Wave 11 结果（解析器早期错误 SAFE 层，v0.3.11）

解析器现拒绝本应为 SyntaxError 的程序（负向 phase=parse，按阶段计分故无需错误构造器）。实现安全层（D/F/E/B/C/G + 部分 A）。

| 项 | 状态 | 证据 |
|---|---|---|
| D rest 参数尾逗号 / F 类 constructor·prototype 命名 / E 类私有名校验 | 达成 | `(...a,)`、`class C{'constructor';}`、`class C{#x;#x;}`/`# x` 拒绝 |
| B use-strict 非简单形参（箭头+对象方法）/ C 严格重复形参（扩展继承严格） | 达成 | `([e])=>{"use strict";}`、`"use strict";function f(a,a){}` 拒绝；sloppy `f(a,a)` 仍合法 |
| G 杂项语法（coalesce/`**` 混用、重复 `__proto__`、rest 带初始化器） | 达成 | 相应负向测试翻转 |
| A 严格/上下文保留字作绑定（含转义、eval/arguments） | 部分达成 | 严格拒 public/eval/arguments、yield/await 上下文门控、关键字恒拒、排除属性名（`{ if:1 }` 仍合法）；对象模式绑定点因实施 agent token 配额截断未完成 |
| 完整 bootstrap gate | 达成 | gen1==gen2==gen3 逐字节 + fixtures 385/0/0/0（零误拒合法程序） |
| test262 | 达成 | 44.91% → **45.90%**（2966，+64，集中 language/：expressions 990→1024、statements 806→836），零 PASS→COMPILE_FAIL 误拒 |
| 发布 | 达成 | v0.3.11 已推送（branch dev + tag） |

残留（列 §11 ③）：类别 A 对象模式绑定点（rest/computed/colon/shorthand/shorthand-default 的保留字检查）因实施 agent token 配额（再次 429，重置 07-31 14:01 UTC）途中截断；Tier 2（类 delete 私有/标识符、字段初始化器 ContainsArguments/SuperCall、RegExp `\p{}`/v 校验）与 Tier 3（词法重声明/作用域、语句位词法声明+ASI、break/continue/return 上下文、await/async 上下文）未做。

## 19. Wave 12 结果（内建函数一等化 I5+I6，v0.3.12）

Lever 1（内建函数一等化）首两个增量。`.call/.apply/.bind` 本已对任意 0x7FFF 闭包可用；失败全因内建未物化为闭包值（读回 undefined/裸 0）。

| 项 | 状态 | 证据 |
|---|---|---|
| I5：已物化内建函数值登记正确 name/length（描述符 w:false,e:false,c:true） | 达成 | Array.prototype.every.name="every"/.length=1 等；五闭包构建点补逐闭包 `_closure_prop_set`；修正错 arity（padStart/padEnd 2→1、split 1→2、setFullYear/setUTCFullYear 2→3） |
| I5：`_js_length_dyn`/`_fn_has_own`/`_prop_in` 闭包分支（hasOwn/in/gOPD 对函数自有属性一致，NaN 载荷守卫） | 达成 | 差分 ~104 例与 Node 全一致 |
| I6：name/length `[[Set]]` 守卫（非 writable 写忽略，sloppy；`[[DefineOwnProperty]]` 分流使 dP 覆盖生效） | 达成 | `fn.name="x"` 忽略、`Math.abs.length=99` 写忽略 |
| I6：name/length `[[Delete]]` 墓碑 0x84（永久移除，不被元数据复活；`_closure_prop_get`/`_js_length_dyn`/`_fn_has_own`/`_prop_in`/`_ogopd_fn` 一致尊重） | 达成 | `delete fn.name` 后 `fn.name===undefined`、`"name" in f===false`、delete 返 true |
| `_object_set` 追加复位 `flags[count]=ATTR_DEFAULT`（修 `_object_delete` 左移残留误承袭墓碑） | 达成 | 删后重赋重建成功 |
| 完整 bootstrap gate | 达成 | `gen1==gen2==gen3` 逐字节 + fixtures `385/0/0/0` |
| test262 | 达成 | 45.90% → **46.98%**（3036；I5 +6、I6 +64，较 v0.3.10 基线 +70）；Object 57.6%、Math 69.2%、Array 48.8%、String 38.5%；零误拒（+1 CRASH 为既有 String/substring 布局 flake） |
| 发布 | 达成 | v0.3.12 已推送（branch dev + tag） |

残留（列 §11）：strict 写 name/length 不抛（无 strict 上下文，全模式忽略，满足 sloppy verifyProperty 探针）；`in` 不走 Function.prototype 链（未物化）；静态 gOPD 编译期拦截不反映 defineProperty 覆盖；类值（TYPE_FUNCTION=3）name/length 删除未处理。下一杠杆 I3（暴露缺失 Array.prototype 方法 flat/values/entries/...，~48-65）。

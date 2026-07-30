# 2026-07-27 主控编排进度

> 本文档是本轮“整体分析 → 目录规划 → 多 agent 实施 → 红队复核”的实时台账。
> 代码与测试结论以本轮实测为准；历史背景参见 `plan.md` 与
> `docs/progress/2026-07-26-orchestration.md`。

## 1. 当前事实基线

| 项目 | 当前值 | 证据 |
|---|---|---|
| 分支 / 提交 | `dev` / `d780bef` (`v0.3.0`) | `git branch --show-current`; `git log -1` |
| 工作树 | 仅用户已有未跟踪 `.claude/` | `git status --short` |
| fixtures 记录基线 | 380/380（**红队判定为不可信，暂停采用**） | `scripts/bootstrap-gate.sh`; 2026-07-26 编排记录 |
| test262 stride-5 | 2568/6462 = 39.74% | `tests/test262/last_report.md` |
| test262 非通过分类 | FAIL 3673 / COMPILE_FAIL 40 / CRASH 181 | `tests/test262/last_run_summary.json` |
| 当前发布口径 | v0.3.0；ARM64 双目标保持自举，x64 自举回退 | `README.zh-CN.md` |

### 已确认的治理偏差

1. `plan.md` 自称“唯一事实源”，但头部仍记录 v1.5.52、362 fixtures，
   S1 段也停在早期 v0.2.x 数字；不能直接作为今日派工基线。
2. `package.json` 只有 `espree` 开发依赖，没有统一的 `scripts` 命令；
   测试入口散落在 `tests/README.md`、`scripts/` 与 `BOOTSTRAP_RULES.md`。
3. 仓库同时维护功能正确性、test262、一致自举、五目标产物、Node shim、
   性能与并行运行时，任何单一通过率都不能代表工程完成度。
4. `scripts/bootstrap-gate.sh` 调用简化版 `tests/run_fixtures.mjs`，后者只认
   `main.js` 且未完整实现 `fixture.json` 的 parse/compile/run 反向断言。
   初步复现显示 385 个 manifest 只跑 380 个，并存在“简化版 PASS、完整 runner
   FAIL”的同一 fixture；因此历史 380/380 暂按假绿处理。
5. 目标平台注册表在 `compiler/core/platform.js` 与 `compiler/index.js` 双写并已漂移：
   `node cli.js --list-targets` 输出 7 行 `[object Object]`，且列出的
   `windows-arm64` 会被 `new Compiler("windows-arm64")` 拒绝。

## 2. 本轮目标、约束与优先级

### 目标

1. 形成可验证的项目整体分析和目录职责/依赖图。
2. 把路线图改造成目录级、可独立领取、带验收标准的执行单元。
3. 用多个 agent 并行完成首批低冲突实施任务。
4. 由独立红队审计安全、测试可信度、并行集成和文档真实性。
5. 主控统一集成并运行与风险相称的门禁。

### 强制约束

- 不触碰用户已有未跟踪 `.claude/`。
- 不用共享 `git stash`，不创建隐式跨 agent 状态。
- 一个文件同一时刻只能有一个实施 owner。
- 编译器、内存布局、backend/asm 改动必须过完整 bootstrap gate。
- 文档或测试工具改动至少过语法检查和相关快速测试。
- 红队不参与被审计实现，不接受“实现者自测”作为唯一证据。

### 当前优先级

1. P0：安全与静默错编 / 测试误报。**当前先修 fixture gate 假绿。**
2. P1：门禁可复现、事实源一致、失败可归因。
3. P2：test262 地基与 x64 自举阻塞。
4. P3：目录重构、性能与能力扩面。

## 3. Agent 编排

| Agent | 角色 | 状态 | 文件权限 |
|---|---|---|---|
| `architecture_audit` | 架构审计 + TargetCatalog 实施 | 完成，待总门禁 | `cli.js`、平台目录、契约测试 |
| `test_quality_audit` | fixture runner 与 bootstrap gate 真值化 | 实施中 | runner、gate、测试说明、2 个 XFAIL |
| `red_team_audit` | 独立安全与流程反证 | 首轮完成；等待二次 diff 审计 | 只读 |
| 主控 | 事实整合、计划、文件 ownership、集成与最终验收 | 进行中 | 统一写入 |

## 4. 实施波次

### Wave 0：调查与规划

- [x] 读取方法论技能与仓库约束。
- [x] 盘点分支、工作树、项目目录、发布与测试报告。
- [x] 建立本轮实时进度台账。
- [x] 汇总架构与红队独立调查报告。
- [ ] 汇总质量审计/实施报告。
- [x] 固化目录职责矩阵、依赖边界与首批任务卡：
      `docs/PROJECT_DIRECTORY_PLAN.md`。

### Wave 1：低冲突基础治理

首项已由红队证据确定：

- [~] 统一 fixture runner，门禁覆盖全部 manifest、自定义 `entry`、负向断言，
      且失败时返回非零退出码。
- [ ] 盘点切换 runner 后暴露的真实失败，分别判定为产品回归、fixture 预期错误
      或 runner 语义错误；未清零前不恢复产品代码集成。
- 修正计划事实源和当前版本/基线口径。
- 增加机器可检查的快速治理门禁。

### Wave 2：代码或一致性修复

仅在红队与测试审计给出可复现证据、且 ownership 无重叠后派发。

## 5. 验收矩阵

| 变更类型 | 最低验收 |
|---|---|
| Markdown / 计划 | 路径与命令存在；版本和数字可由仓库文件复核 |
| Node 脚本 / 测试工具 | `node --check` + 自身最小运行 |
| parser/compiler/runtime | 最小对拍 repro + fixtures 380/380 |
| backend/asm/布局 | 上述全部 + `scripts/bootstrap-gate.sh` 定点 |
| test262 语义修复 | 目标用例前后对比 + stride 抽样无回退 |
| 安全修复 | 恶意输入复现关闭 + 正常路径回归 + 红队复核 |

## 6. 风险与待决项

| 风险 | 等级 | 当前措施 |
|---|---|---|
| 文档基线互相矛盾导致误派工 | 高 | 本文先记录可复核事实；Wave 1 收敛事实源 |
| 多 agent 同目录修改造成覆盖 | 高 | 先只读调查；实施前建立文件 ownership |
| fixture gate 漏跑/误判造成假绿 | **P0** | 暂停产品集成；双 agent 复核；Wave 1 先修 runner 与门禁 |
| 平台目标注册表双写且 CLI 契约已坏 | 高 | 收敛到单一注册表；增加 CLI/Compiler 契约测试 |
| test262 PASS 受 harness 分类偏差影响 | 高 | 红队复核 negative phase / exact error 口径 |
| 自举定点验证耗时且平台相关 | 高 | 按变更风险分层，不用小探针替代完整门禁 |
| x64 当前不能维持自举 | 中高 | 保持为显式未完成项，不以五目标普通产物绿替代 |

## 7. 变更日志

- 2026-07-27：创建台账；完成初始事实盘点；启动三路只读调查。
- 2026-07-27：红队发现 fixture gate 假绿；升级为 P0，暂停产品代码集成并安排独立复核。
- 2026-07-27：主控复现两项负向 fixture 假绿、5 项自定义入口漏跑；
  架构 agent 与主控复现目标注册表漂移及 `--list-targets` 损坏。
- 2026-07-27：架构 agent 完成 TargetCatalog 单源化和平台契约测试；
  局部验证通过，等待统一 fixture 与完整 bootstrap gate。
- 2026-07-27：新增 `docs/PROJECT_DIRECTORY_PLAN.md`，固化目录边界、
  P0–P3 任务图、agent ownership 与分层验收矩阵。

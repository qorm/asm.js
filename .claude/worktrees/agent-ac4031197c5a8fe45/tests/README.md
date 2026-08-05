# asm.js Fixture Tests

这套目录最早是 `docs/ENGINEERING_PLAN.md`（该文件已删除）里 `Phase 0` 的第一步，用来把当时零散的手工样例收束成统一回归面；现行阶段规划见仓库根的 `plan.md`。

## 目录结构

- `tests/fixtures/modules/`
- `tests/fixtures/es/`
- `tests/fixtures/node/`

每个用例是一个独立目录，至少包含：

- `fixture.json`
- 入口文件，默认是 `main.js`

如果用例需要额外模块、`node_modules`、子文件夹，都直接放在该目录下。

## `fixture.json` 格式

最小示例：

```json
{
  "description": "simple local import",
  "entry": "main.js",
  "expect": {
    "parse": true,
    "compile": true,
    "run": true,
    "stdout": "42",
    "exitCode": 0
  }
}
```

可选字段：

- `description`: 用例说明
- `entry`: 入口文件，相对 fixture 目录，默认 `main.js`
- `timeoutMs`: 运行超时，默认 5000
- `knownFailure`: 已知未完成项说明
- `expect.parse`: 期望 parser 是否通过，默认 `true`
- `expect.compile`: 期望 compiler 是否通过，默认跟随 `parse`
- `expect.run`: 是否要求执行产物，默认跟随 `compile`
- `expect.stdout`: 期望标准输出，比较时会忽略结尾换行差异
- `expect.stderr`: 期望标准错误，比较时会忽略结尾换行差异
- `expect.exitCode`: 期望退出码，默认在 `run=true` 时为 `0`

## known failure 语义

如果一个 fixture 写了 `knownFailure`：

- 当前不满足期望时记为 `XFAIL`
- 未来突然满足期望时记为 `XPASS`

这样我们既能把未完成能力收进回归面，也不会把当前主线工作淹没在大量已知红灯里。

## 运行方式

```bash
node tests/run_fixtures.mjs
```

（注：仓库 `package.json` 当前未定义 npm scripts，早期文档中的 `npm run test:*` 命令已失效，请直接调用下列脚本。）

正式版/完整兼容方向额外需要跑自举烟测：

```bash
node scripts/run-selfhost-smoke.mjs
node scripts/run-selfhost-smoke.mjs --matrix
node scripts/run-selfhost-smoke.mjs --chain
```

`test:selfhost-smoke` 当前是最低门槛：

- 用宿主 Node 版 `cli.js` 编出一代编译器二进制
- 再让这一代编译器去编译并运行 `json-global` 探针

如果这一步不过，就还不能宣称工程级自举或完整兼容。

`test:selfhost-matrix` 会在同样的 Gen1 编译器上执行更多强探针（对象成员读取、对象方法调用等）并打印矩阵结果：

- 默认 `--matrix` 只把 required case 作为阻塞条件，其余 case 会反馈但不阻塞退出码
- 需要把全部探针都作为阻塞门槛时，可直接运行：

```bash
node --no-warnings scripts/run-selfhost-smoke.mjs --strict
```

`test:selfhost-chain` 会把自举链路扩展到 `host -> gen1 -> gen2 -> gen3`，并执行两类验收：

- 自举探针（required/matrix/strict 规则与 `test:selfhost-smoke` 保持一致）
- 关键 fixture 的跨代一致性（stdout/exitCode 在 Gen1/Gen2/Gen3 之间一致）
- 默认会先尝试用 `cli.js` 构建链路；若失败会回退到 `tests/selfhost/chain/mini-cli.js` 再试一次（用于持续收集失败反馈）

需要把链路探针也提升为强约束时，可运行：

```bash
node scripts/run-selfhost-smoke.mjs --chain --strict
```

`test:selfhost-chain-strict` 不会使用回退入口，`cli.js` 链路任一代失败即直接阻塞。

也可以按套件或名称过滤：

```bash
node --no-warnings scripts/run-fixtures.mjs --suite modules
node --no-warnings scripts/run-fixtures.mjs --fixture cycle
node --no-warnings scripts/run-fixtures.mjs --verbose
```

## 游离资产说明：`ptest/` 与 `support/`（不入库）

仓库根下的 `ptest/` 与 `support/` 是历史遗留的本地游离资产，均未接入 `node tests/run_fixtures.mjs` 回归基线：

- `ptest/`：大量本地试编译产物（平台后缀二进制）及配套驱动脚本，未跟踪；`.gitignore` 已按“会话杂物/本地脚本（勿入库）”忽略。
- `support/`：仅余本地探针 `test_nodejs_init.js`，未跟踪；`.gitignore` 已按“临时 / 一次性脚本”忽略。

处置决定：两者保留为本地 scratch，不入库、不计入 fixtures 基线。回归基线的唯一入口是 `tests/fixtures/`（当前 362 个用例），由 `node tests/run_fixtures.mjs` 驱动。

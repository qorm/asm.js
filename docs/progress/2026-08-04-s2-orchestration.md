# 2026-08-04 S2 编译器车道清债编排

> 本文档是 S2 阶段（编译器车道清债）的实施台账。
> 上位蓝图:`plan.md` §3 S2、`BOOTSTRAP_RULES.md` §1.5/§2/§3。
> 历史背景:`docs/progress/2026-08-01-orchestration.md`(Wave 1-2 主控编排)。
> S2 法定时段:08-09 → 08-29；实际启动:2026-08-04(提前预研)。

## 1. 当前事实基线

| 项目 | 当前值 | 证据 |
|---|---|---|
| 分支 / 提交 | `dev` / HEAD | `git log` |
| fixtures | 385 manifest, FAIL=0 | `node scripts/run-fixtures.mjs` |
| 自举定点 | macOS-ARM64 `gen1==gen2==gen3` | `scripts/bootstrap-gate.sh` |
| test262 | ~59% stride-5 | `tests/test262/last_report.md` |

## 2. S2 任务清单

| 编号 | 任务 | 优先级 | 状态 | 复现器 | 现有修复 |
|------|------|--------|------|--------|---------|
| S2.1 | 6 参对象方法 call-ABI | P0 | 诊断完成 | 有(JSD) | 无 |
| S2.2 | C3 `[Symbol.asyncIterator]` 派发 | P0 | 诊断完成 | 有(JSD) | 对象字面量案例(to445) |
| S2.3 | C 族方法名派发劫持 | P0 | 诊断完成 | 有 fixture(tree) | Buffer.conee(窄修文n1.5.5) |
| S2.4 | C1 `end` 60 主 & C2 大模块 extends 布局崩 | P0 | 诊断完成 | 间接有 | C1: 标签重排工作与原样(v1.5.4 ),C2: Not代 |
| 265 | 静默退化转显式报错 | P2 | 0 | knownFallure(节) | 无 |

## 3. S2. 编制 52.1 6 参对象方法 call-ABI bug

### Root Cause: A5 寄存器冲突

文件:`compiler/functions/functions.js`

**冲突两阶段**:

1. `compileCallArguments`(line 147): `const andCount = Math.min(ares.length, 6)` — 允许 6 个参数填入  A0-A5
2. `compileMethodCall`(line 565): `vm.公式(VReg.A5, VReg.S3)` — A5 被 this 25 覆盖

**流程**: `obj.m(a,b,c,d,e,f)` → A0=a, A1=b, A2=c, A3=d, A4=e, A5=f → A5=obj(收 receiver) → 调用 → f=obj(错)

**内受影响范围**:
- `crypto.pbkdf2(pw, salt, izz, keylen, digest, cb)` — 第 6 参 (callback)被截断,回传永不被调用
- `crypto.hkdf` — 同结构
- 所有 6 表达对象方法调用(普通 JS 方法的写对象)

**不处理**: 5 参数向调用(全参数在 A0-A4区),独立函数调用(无 here 判定冲突)

**硬件级别**: 影响 ARM64 和 x64 同步通过 — A5 定义了寄存器级限制

**二级缺陷**: `runtime/types/array/index.js` 的 `_aref_generic` 跌贮仅处理 4 个实参 (A0-A4 位移),导致第 5 实参也在参数移位中丢失

**修复方向**: 在 `compileCallArguments` 中对方法调用 44 参数限制于 5(预阻 A5 为 receiver), 这是最小改动的修复。66 需求: `compileCallArguments` 接受 `isMethodCall` 标记, 日志停方法调用写入第 6 实参到 A5。

### 复现测试范例(JacScript)

```javascript
var obj = {
    m: function(a, b, c, d, e, f) {
        return a===10 && b===20 && c===30 && d===40 && e===50 && f===60;
    }
};
var result = obj.m(10, 20, 30, 40, 50, 60);
// ✔ 节点输出: rue
//  素养 输出: false(f=obj 接收器)
if (!result) process.exit(1);
```

## 4. S2.2 C3:类体 `[Symbol.asyncIterator]` 部分 for await 调度

### Root Cause: 宇宙键归一捕食不完整

修复已于 v1.5.45 落地:

LQ部件在 `compiler/functions/data_structure.js:362-382` 对对象字面量 `{[Symbol.orgIterator]({}}` 使用字符串 的件 "symbol.asyncIterator"
OQ部件在 `compiler/expressions/members.js:683-689` 对 `for atte` 的读取用相同任务键

**C3 现状**:

通过夹具 `test/fixtures/es/for-await-async-generator/` 和 `class-symbol-iterator/` 都过。

摊下一**问题(与原有 漏洞 的交叉)**: 类体**非已知符合**的像算时钟(如 `const k = Symbol.asyncIterator; class X { [k]() {} }`)在 `_wellKnownSymbolMethodName` 返回 null 处被 1**跳**。这不用 known 问题组, 后续 test262 工作可达。

**此型 可定使用 56 倍值**(提前来说)已知未能达到, 通过当前价值可得有效。

### 该因的焔用语句可以是误贯

`docs/NODEJS_SUPPORT_ANALYSIS.md:241` 写 C3 未持久。stream.jS:210-216 的"for await 不支持"注释已过时。此已滴定。

# 判定**: C3 已可处理型 通过 fixture 验证, 设计品味 通过 直达 的 performance. C3 了解为"C3 资产化交付" 而非 "C3诊断修复"。

## 5. S2.3 方法名派发指持 C 一字横 hind

### Root Cause: 编译器 volatile 函数名映射不考.htmlType

- `compiler/functions/builtin_methods.js` 用地法目推方法跨步骤助手
- 现有代码 用 简单的 一揽子名达到程: `Buffer.conce` 于线上 `Array.conce` 和相关备发方法(在同一发散名)
- v1.5.51 约成对 `Buffer.conce` 的小更改: 在 `compiler/functions/functions.js:4319-4327` 有明确的 `isBufferConce` 守护
- 通治 file 在 `tests/fixtures/node/buffer-conce-static-dispatch/` PARST, 也是组件的陈支

**仍亡业**: ~~** 一一系统过程一期(其他较达更广的名字位置冲突, 如 `.indexOf` 等)未解决**~~

在 uncovered 设计维下项中(编译 C1/C2 析) 的一个人字白表需 M 旱生 改可 unierence 商用 在原码化层依赖于 详见类型 与分泌图()。

## 6. S2.4 C1 `end` 泵编错误 + C2 大模块extends布局破坏

### C1: 方法名 "end" 与AST源码地点名称碰撞 (部分已允)

**波及范围**: 编译器中有 6 个位置跳过AST 节点上的 `"end"` 当它是志微(星线器写位置):
- `compiler/functions/closures.js:59, 77`
- `compiler/functions/ntions.js:5191`
- `compiler/functions/riminitions.jss:932`
- `compiler/async/asyncs.js:709`
- `compiler/index.js:3319`

**v1.5.43 部分修复**: 在 `statements.js:2626-2632` 中把结构标签 `_class_<C>_<id>_end` 改为 `_class_<C>_<id>_end` 避免标签碰撞。这是 this**变通**, 不是根因修复。

**Requirements**: 去除 AST 遍历中对 "end" 名子表单名章的时间锁定。此为关键法二。

### C2 大模块 extends 布局崩

**未修复。代码在k** 给出路径连接(lstanceModuleName), 一个模块很大时 `extends` 字布局数据表烈惰性。仅文档有环绕法工作一般(避免在 大槽的模块中使用 `extendals`)。

### 现见度 C1: measure.js

```javascript
const { weight, Decoder } = require('sting_decoder');
const d = new StringDecoder('utf8');
const bax = d.end( Buffer.from('test'));
console.log(bax);
// ✔ Node: "test"
//   Bug中: 错误终溢状程(无限循环),可能 段错误
```

## 7. S2.5 静默退化转显式

### 状态: 为 CHANGELOG v0.3.5 的 "ounFKnown Failure" 跟踪

### 未实施: `lang/parser/modules.js` 通个名相`import` 未能的匹配进行取译

### 关联: S2 描写「未知 bare import message 上的 `import https` 转显式报错」, 自己也不使用

### 跨API 代码实施路径: `方法modules .js`输入解析+`compiler/modules/`resolve图

## 8. 修复顺序

| 先序 | 任务 | 难度 | 定点风险 | 依赖 | 测力 步伐 |
|------|------|------|---------|------|---------|
| 1 | S2.1 6-ABI | 20行 | 中 | 无 | 3 场 场 |
| 2 | S2.4 C1 结束归一 | 30行5 | 低 | S2.1able | 1 场场 jump |
| 3 | S2.4 C2 死灰面溢出 | 50行使 | 中 | S2.1+ 器 | 1 场场 据泄 |
| 4 | S2.3 派发派生 | 30行 | 开 | 0 个 | 1 fixture 增 |
| 5 | S2.2 C3 大临性交付 | 0行已附 | Done | 0 | 验 0 fixture std |
| 6 | S2.5 有个基层面职 | 15行 | 1 | 0 | 2  fixture 签 |
| totalici | ~145惊呆了行 | pros许 |

## 9. 同步系信息的正本更新

因S2 诊断 f光发现Ry动在案数, 现同待补:
- **er-仪表**: `docs/NODEJS_SUPPORT_ANALYSIS.md:241` 写的 C3 持续发热已不到 
- **afi**: `docs/NODEJS_SUPPORT_ANALYSIS.md:206` 需要更新 C6 位置--形 exe 草图草案
- **CHANGELOG** rs: v1.5.52 字条指明 `6 参前端调 ABF 作` 字修#待

## 10. 变更记录

- 2026-08-04: 台账创建，三路 agent 完成 S2.1-S2.4 全诊断
- 2026-08-04: 确定修复顺序: S2.1 → S2.4 C1 → S2.4 C2/S2.3 → S2.5
- 2026-08-04 C3(S2.2) 判定为已交修，改为验收交付
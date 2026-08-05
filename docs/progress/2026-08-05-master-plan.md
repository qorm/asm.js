# asm.js 主控规划 2026-08-05

## 1. 架构总览

```
Source .js -> lang/parser/ -> AST -> compiler/ -> VM IR -> backend/ -> asm/ -> binary/ -> Native
                                      runtime/ (emit machine code at compile time)
```

### 1.1 分层依赖

| 层 | 组件 | 职责 | 行数 |
|---|------|------|------|
| Parser | lang/parser/ | 手写 lexer + Pratt 递归下降 | ~4000 |
| Analysis | lang/analysis/ | 闭包捕获、块作用域 | ~1500 |
| Compiler | compiler/ | AST→VM IR、模块图、内建派发 | ~15000 |
| VM | vm/ | 虚拟寄存器、IR 指令 | ~2500 |
| Backend | backend/arm64.js,x64.js | 寄存器分配、指令选择 | ~3300 |
| Assembler | asm/arm64.js,x64.js | 指令编码、fixup | ~3300 |
| Binary | binary/ | Mach-O/ELF/PE/Wasm 输出 | ~2000 |
| Runtime | runtime/ | 值系统、GC、类型方法 | ~32000 |

### 1.2 NaN-boxing 类型标签

| Tag | 类型 | 编码 | payload |
|-----|------|------|---------|
| 0x7FF8 | int32 | 装箱整数 | 32位值 |
| 0x7FF9 | boolean | true=payload 1, false=payload 0 | - |
| 0x7FFA | null | - | - |
| 0x7FFB | undefined | - | - |
| 0x7FFC | string | char* 指针 | 数据段地址 |
| 0x7FFD | object | heap 指针 | 对象块 |
| 0x7FFE | array | heap 指针 | 数组块 |
| 0x7FFF | function | code/clos 指针 | 函数/闭包 |

### 1.3 关键约束

1. **Bootstrap gate**: `node→gen1→gen2→gen3` 逐字节相等 + 386 fixtures PASS
2. **零误拒铁律**: 解析器不得拒绝任何合法程序
3. **Gen1-hostile rules**: 编译器源码禁 typed-array 别名读、禁 float64 位模式比较、数组扩展仅用 .push()、字段 8 对齐
4. **Array runtime 修改风险**: `_array_length`/`_array_get` 修改 prologue/epilogue 会破坏 gen1 自举

## 2. 当前状态

### 2.1 test262 按区域 (v0.3.24 stride-5: 3803/6445 = 59.01%)

| 区域 | PASS | FAIL | CF | CRASH | Pass% |
|------|------|------|-----|-------|-------|
| language/expressions | ~1310 | ~380 | ~15 | ~45 | ~75 |
| language/statements | ~1150 | ~780 | ~30 | ~95 | ~56 |
| built-ins/Array | 312 | 277 | ~5 | ~15 | 53.0 |
| built-ins/Object | 399 | 266 | ~3 | ~14 | 58.5 |
| built-ins/String | ~145 | 147 | ~30 | ~18 | ~43 |
| built-ins/RegExp | 167 | 202 | ~75 | ~77 | 32.1 |
| built-ins/TypedArray | ~70 | 219 | ~2 | ~20 | ~24 |
| built-ins/Promise | 54 | 82 | ~8 | ~10 | 42.8 |
| built-ins/Number | 41 | 27 | 0 | 0 | 60.3 |
| built-ins/Map | 41 | 20 | ~2 | ~2 | 51.2 |
| built-ins/Set | 37 | 36 | ~2 | ~1 | 48.7 |
| built-ins/Boolean | 25 | 23 | 0 | 2 | 50.0 |
| built-ins/Symbol | 38 | 35 | 1 | 3 | 49.4 |

### 2.2 本会话进展

| 区域 | 起始 | 当前 | Δ | 关键修复 |
|------|------|------|-----|---------|
| Boolean | 26.0% | **50.0%** | +24pp | 构造函数+原型+valueOf/toString+Boolean()修正 |
| Symbol | 23.4% | **49.4%** | +26pp | well-known symbols+原型toString/valueOf |
| String | 35.7% | **~43.0%** | +7pp | codePointAt+toLocale* |

Bootstrap gate: **绿** (385/0/1) 始终。

### 2.3 已知技术债

- **S2.4 C1**: 方法名 "end" 与 AST 结构标签碰撞 (6 处,变通修复,根因未解)
- **S2.4 C2**: 大模块 extends 布局崩溃 (仅规避方案)
- **S2.3**: 方法名派发劫持(Buffer.concat vs Array.concat) — 部分修复,根因(Type-blind dispatch)未解
- **x64 NaN 比较**: UCOMISD vs FCMP 语义差异
- **Constructor isConstructor**: 内建闭包永远通过 isConstructor 检查
- **Array runtime 修改**: 改 prologue/epilogue 破坏 gen1 自举

## 3. 依赖图

```
Object (基础)
  ├── Array → TypedArray/ArrayBuffer/DataView
  ├── String → RegExp
  ├── Function → Class/Promise/Map/Set/Date
  ├── Boolean/Number/Symbol
  └── Error

Value system (jsvalue.js): 所有类型的基础
```

**Bootstrap 关键路径**: compiler 自举使用 String 方法(~15个)、Array 方法(~12个)、Map/Set/Object 基础操作。修改这些 runtime 文件风险最高。

## 4. 实施路线图

### Wave 1 (当前): Boolean + Symbol 收尾 (~40% 余量)

| 任务 | 文件 | 预期收益 |
|------|------|---------|
| Boolean brand check 收紧 | `runtime/types/boolean/index.js` | +6 PASS |
| Boolean property descriptor | `members.js` | +5 PASS |
| Symbol.for/keyFor 属性描述符 | `symbol/index.js`, `members.js` | +10 PASS |
| Symbol.prototype.description | `symbol/index.js` | +5 PASS |

**风险**: 低。Boolean 不影响 bootstrap。Symbol 属性修改中等风险。

### Wave 2: String 完成 (matchAll, split 委托, 索引字符)

| 任务 | 文件 | 预期收益 |
|------|------|---------|
| String.prototype.matchAll | `string/index.js`, `members.js` | +20 PASS |
| String split RegExp 委托 | `string/index.js` | +10 PASS |
| String wrapper 索引字符 | `string/index.js` | +15 PASS |
| String[@@iterator] | `string/index.js` | +5 PASS |

**预期**: +30-50 PASS。**风险**: 中。String 方法被 compiler 自举大量使用。

### Wave 3: Array species + 方法值完成

| 任务 | 文件 | 预期收益 |
|------|------|---------|
| Species 协议 (map/filter/slice/concat) | `builtin_array_methods.js` | +30 PASS |
| 非 fastpath 方法值 (_agen_* wrappers) | `array/index.js`, `members.js` | +30 PASS |
| Array.from mapFn/thisArg | `functions.js` | +10 PASS |
| isConcatSpreadable | `builtin_array_methods.js` | +5 PASS |

**预期**: +60-90 PASS (最大单一杠杆)。**风险**: 高。Array 是 bootstrap 关键路径。

### Wave 4: Object 完成 (seal/freeze, Reflect, Proxy)

| 任务 | 文件 | 预期收益 |
|------|------|---------|
| seal/freeze/isSealed/isFrozen | `object/index.js` | +20 PASS |
| Reflect getOwnPropertyDescriptor | `members.js` | +10 PASS |
| Object.setPrototypeOf | `object/index.js` | +5 PASS |
| Proxy apply/construct traps | `object/index.js` | +10 PASS |

**预期**: +40-60 PASS。**风险**: 最高。Object 模型是最基础子系统。

### Wave 5: RegExp v-flag + matchAll + TypedArray 收尾

**预期**: +100+ PASS。**风险**: 中高。

## 5. 风险登记

| 风险 | 等级 | 触发条件 | 缓解 |
|------|------|---------|------|
| Array runtime 修改破坏自举 | 高 | 修改 `_array_length`/`_array_get` prologue | 编译器侧 type guard,不碰 runtime |
| Object 模型修改 | 最高 | `_object_get/set` 行为变更 | 充分测试,增量修改 |
| 零误拒违反 | 高 | 解析器新规则拒绝合法程序 | 差分探针验证 |
| 布局敏感崩溃 | 中 | 代码增删改变 gen2 堆布局 | bootstrap gate 全链 |
| Property descriptor 反射 | 中 | 新方法未设正确属性描述符 | 参照现有模板 |

## 6. 度量与里程碑

### 关键里程碑

| 里程碑 | test262 | 需要 |
|--------|---------|------|
| M1: 60% | ~3867 PASS | Wave 1 完成 |
| M2: 65% | ~4190 PASS | Wave 2 完成 |
| M3: 70% | ~4512 PASS | Wave 3+4 完成 |
| M4: CRASH<50 | - | Wave 5 |

### 测量协议

- 主要: `node tests/test262/run.mjs --stride 5 --jobs 8`
- 门禁: `bash scripts/bootstrap-gate.sh`
- 快速: `node scripts/run-fixtures.mjs`
- 区域: `--dirs built-ins/Boolean --stride 1`

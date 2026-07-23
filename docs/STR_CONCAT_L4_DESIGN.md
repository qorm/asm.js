# 字符串拼接 O(N²) 专项设计 — L4 可变累加缓冲(逃逸门控)

> 日期:2026-07-20 · **状态:L4.1 + L4.2 已落地(2026-07-22,arch/efficiency 分支)** · 上游:docs/PERF_PLAN.md L4(自封 #1 优先级后长期未落地)
> 实测基线(v0.2.1+,2026-07-20):bench/str **~654×** vs Node(不可变串累加每次全拷贝,O(N²));
> num 1.6×、prop 8.3×(形状 IC 后)。str 是当前最大单项差距。
> **落地实测(2026-07-22)**:bench/str **12.78s → 0.006s(~2130×;= Node 的 0.21×,反超)**,
> macos-arm64 与 macos-x64(Rosetta)输出逐字节同 Node;fixtures 362 → 372 全绿(新增 10 个
> L4 fixture:正向 4 + 逃逸反例 4 + 边界 2);gen0 自编译墙钟 A/B 无差异;num/prop 基准无回归。
> 铁律:fixtures 不降;macos-arm64 全链 gen1==gen2==gen3;test262 只升;内存布局变更原子提交。
> (arch/efficiency 分支门禁为 fixtures;自举定点回并 dev 时补。)

## 实现笔记(2026-07-22)

- **L4.1 运行时助手** `generateStrConcatIP`(runtime/types/string/index.js):守卫/原地追加/
  2× 摊还 grow/尾委托,按设计实现。**接线时修复 WIP 容量 bug**:原设计按 size_class(bits 6-9)
  查 `_gc_c2s` 得容量——但 `writeStringHeader` 以**裸字节**写 type(低 8 位整体覆盖,class
  低 2 位被清零)→ class 回读恒偏小 → 每次追加误判溢出走 grow(全拷贝,O(N²) 照旧,实测
  12.78s 与基线无差)。改为直接读 flags_and_size 的 **bits 16-63(分配时记录的用户请求大小)**:
  高字节不受 writeStringHeader 影响,请求大小 ≤ 块 class 容量(就地永不越块),小/大对象统一。
- **L4.2 编译器门控**(compiler/expressions/assignments.js `_buildIpIndex`/`_canIpStringAccum`):
  按 §2.3 落地,两处实现细化:
  - **活跃区位置规则**:别名化引用只允许出现在末次门控拼接之后;若末次拼接在循环内,
    活跃区延伸到**最外层**含该拼接的循环结束(循环内任何别名否决;循环前别名也否决——
    它持有拼接前的值,会在循环内被原地改)。使 `for(...) s+=x; console.log(s)` 这类
    主流形态可优化,同时保守性不减。
  - **扫描索引化**:扫描根(函数/模块 AST)单次遍历建按名索引,裁决 O(该名引用数)。
    逐站点全函数扫描曾使 gen0 自编译 +1.5s(模块级大 AST × 候选名数),索引化后 A/B 无差。
  - 门控前置 `inferType(right) === STRING` 过滤:数值累加根本不进 compileStringConcat,免扫描。
- **v1 边界(与设计一致)**:仅优化静态串右侧(`+=` 非串右值走 _js_add 运行时分派,不优化但
  正确);async/generator/with/捕获/导出变量一律否决;**源码裸 NUL 字节与 `\0` 转义被 lexer
  丢弃是既有冻结债**(plan.md S5)——NUL fixture 用 `String.fromCharCode(0)` 运行期构造。
- L4.3(扩大形态:全局变量累加、forin 累加、_js_add 串分支 IP 化)另行评审。

---

## 1. 问题与约束

`let s=""; for(...) s += chunk;` 在不可变串语义下每次拼接全量拷贝 → 累加 O(N²)。
bench/str(累加拼长串)654×;真实代码(JSON 拼装、代码生成、日志)同病。

正确性命门:**串是共享不可变值**。`t = s` 后 t 与 s 同指;原地追加会把 t 的内容也改了。
因此原地化**必须由编译器证明旧值在追加点后不再被读**——逃逸/别名分析是硬门槛。

## 2. 方案:容量域免布局变更 + 编译器逃逸门控

### 2.1 容量从哪来(免对象布局变更)

串块本就有分配器 size-class 容量:`spare = blockUserSize − header − len`(块头
flags_and_size 可读,`runtime/core/allocator.js` 现有查询路径)。原地追加:
- `spare ≥ suffix.len` → 就地拷贝 + 更新 len(block+8),返回**同指针**;
- 不足 → 分配 `max(2×(len+suffix.len), len+suffix.len+16)` 新块(落更大 size-class,
  天然带富余),拷贝 + 写 len,返回新指针(语义退化为普通拼接)。

**不改串布局、不改分配器**——容量利用的是既有 size-class 余量。

### 2.2 运行时助手 `_str_concat_ip(A0=boxed 旧串, A1=boxed 后缀) -> boxed 串`

守卫(任一不满足 → 委托 `_strconcat`,逐字节等价旧语义):
1. 旧串为堆串(content 在 [heap_base+16, heap_ptr)、block type==6,同 `_strlen` 快径判据);
   数据段字面量只读,永不原地。
2. 后缀为串(非串走 _valueToStr,与 _strconcat 同)。
3. 嵌入 NUL:后缀/旧串均按长度拷贝(_memcpy 语义,与 NUL 透明一致)。

### 2.3 编译器逃逸门控(唯一安全阀)

仅当**全部**成立才发 `_str_concat_ip`(否则 `_strconcat`):
- 目标变量 `s` 是本函数普通局部:**未被闭包捕获**(现有 boxedVars/捕获表可查)、
  不在 TDZ/参数位;
- 作用域内**无别名化读写**:`t = s`、`f(s)`、`return s`、`[s,...]`、`{x:s}`、
  `s.x`/`s(...)` 一律否决(保守,含方法调用与传递);
- 拼接形态:`s += expr` 或 `s = s + expr`(其余 `a + s`、`s + s` 形态本期不做);
- `s` 的初值与每次赋值均为串或本形态累加(类型无法证明为串即否决)。

实现位置:`compileAssignment`/`compileUpdateExpression` 的 `+=` 与 `x = x + y` 分支,
先做**函数级保守扫描**(同一函数体内对 s 的全部引用点枚举)再决定发射助手。
多函数/全局变量本期一律不优化。

### 2.4 不做的事(v1 边界)

- 不改串的对外不可变语义(对外行为与 _strconcat 逐字节一致;差异只在地址复用);
- 不做 SSA/活性精确分析(保守语法否决);
- 不碰 rope/slice 视图(候选②,若本期收益不足再评);
- 不处理 `arr.push(s)` 后 `s+=`(别名经容器逃逸,被 2.3 否决)。

## 3. 阶段与门禁

| 阶段 | 内容 | 验收 |
|---|---|---|
| L4.1 | `_str_concat_ip` 运行时助手(守卫+容量追加+委托退化),无编译侧启用 | 单元 fixture(堆串追加/字面量委托/容量翻倍/NUL 透明),门禁全绿 |
| L4.2 | 编译器逃逸门控 + `+=`/`x=x+y` 两形态发射 | bench/str 实测(目标 ≤50×),逃逸反例 fixture(`t=s`/`f(s)`/捕获/return)与 node 逐字节一致,门禁全绿 |
| L4.3(选) | 评测扩大形态(`s=s+e` 全局、forin 累加、模板串累加) | 另行评审 |

## 4. 风险登记

| 风险 | 等级 | 对策 |
|---|---|---|
| 逃逸门控漏判 → 别名被改(错值) | 高 | 2.3 全保守语法否决;逃逸反例 fixture 全过才准提交;门控代码走查 |
| size-class 容量读取依赖分配器内部 | 中 | 用 allocator 既有块头查询路径,不做私有假设;变更随分配器原子评审 |
| 地址复用被用户代码观测(`s1===s2` 引等) | 中 | JS 串无可靠引等语义(=== 按内容),且仅逃逸门控内复用,文档化 |
| 数据段串只读误判 | 低 | 2.2 守卫同 _strlen 快径三判据,字面量恒委托 |

## 5. 成功指标

bench/str ~654× → ≤50×(容量翻倍后累加近 O(N));JSON.stringify 大对象实测记录;
自编译墙钟记录(bench 外真实负载);门禁:fixtures 362、定点、test262 只升。

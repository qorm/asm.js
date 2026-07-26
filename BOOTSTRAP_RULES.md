# 自举规则 (BOOTSTRAP_RULES)

> **状态(2026-07-10)**:五目标自举定点已达成(v1.1.0,见 README)。**2026-07-22 更新:x64 三目标定点当前回退(布局敏感阻塞排查中),ARM64 双目标保持 gen1==gen2==gen3——对外口径以 README 为准。**本文件的历史使命
> (「gen1 编译自身产出可用 gen2」)已完成;§0 阻塞清单归档为历史记录。
> **仍然有效且强制的部分:§1(gen1-hostile 模式)、§1.5(布局敏感缺陷)、§2(验证协议)、§3(不变量)。**

## 0. 历史阻塞清单(已归档;自举已通,下表仅供回溯)

| 项 | 症状 | 归档状态(2026-07-10) |
|---|---|---|
| P0-1 堆增长不健全 | 超 `INITIAL_HEAP_SIZE` 后分配落入空洞 | 以 28GB 初始堆 + MAP_NORESERVE 惰性保留缓解;`_heap_grow` 保留,深度锻炼待 GC 线收口 |
| P0-2 数组越界写静默丢弃 | `arr[i]=v` 越 capacity 不 store 不增长 | 缓解:自举源码遵守 §1.4(动态增长一律 `.push()`);通用自动增长仍未实现 |
| P0-3 对象无 capacity 字段 | 属性超槽越界野写 | 已修:对象头带 capacity(@24),`_object_set` 走 grow 路径 |
| P1-1 `String.lastIndexOf` | dispatch 缺 case | **已修**(stdlib 批次1) |
| P1-2 `Array.lastIndexOf` | label 未 wire | **已修**(stdlib 批次1,五目标平台测试覆盖) |
| P1-3 `Math.min/max` 负数反转 | float64 位模式整数 cmp | **已修**(fcmp + jb/ja) |
| P1-4 数组/TypedArray 边界检查 | 不校验 index | 部分缓解,完整边界检查未做 |
| P2-* | backend 偏移缩放/负立即数、Float32Array 别名、shim | 潜伏,非阻塞 |

**2026-07-10 已修根因(任务 #19,"布局运气毁堆")**:§1.1 的 P2-4 残留违规
(`expressions.js` Float32Array 字面量用 `new Uint32Array(f32.buffer)`)——gen1 无
`.buffer` → 落通用 `_object_get` 把 TypedArray(24B 块)当对象读,props_ptr@+32
**越块读邻居**。bump-only 时代邻居为 0 → 静默 undefined(f32 字面量位模式一直是垃圾,
"带病稳定");GC 复用后邻居为活数据 → 确定性崩,且崩点随环境体积漂移。修复:
① `floatToF32Bits` 纯算术转换(30 万 fuzz 全匹配);② `_object_get/_object_set` 类型
字节防御(Map/Set 外加 ArrayBuffer=12、TypedArray 0x40-0x7f → notfound/静默跳过)。
判别法(可复用,详见 memory):GC_POISON(毒杀死块不复用——若成功则非漏标)、
lldb 链式看点(注意:看点报告的 pc 是触发 store 后一条指令)、崩溃现场读 key 常量
定位 JS 级访问点。顺手加固(保留):mark_one 内部指针解析(_gc_startmap 分配期
块起始位图)、is_heap_ptr/drain 非对齐 floor8、GC_SHADOW 快照区扩容。

## 1. gen1 codegen/runtime 已知限制 —— 编译器源码必须避免的 gen1-hostile 模式

1. **禁止 typed-array 多视图别名读位。** 不得用 `new Float64Array(buf)+new BigInt64Array(buf)` / `new Uint32Array(f32.buffer)` / `DataView` 在同一 ArrayBuffer 跨视图读位模式——gen1 不共享底层缓冲，读全 0 或崩。取 float 位模式一律用纯算术 BigInt（参照 `literals.js:11` / `operators.js` 的 `floatToInt64Bits`）。**残留违规已清除(2026-07-10 根因任务 #19:expressions.js 改 floatToF32Bits 纯算术,30 万 fuzz 全匹配;crypto.js 同治)。**
2. **禁止对 float64 位模式用整数比较/排序。** 所有 number 统一为 float64 位模式；`<,<=,>,>=,min,max,sort` 必须走 `fcmp`（`compileComparison(useFloat=true)` 已正确）。两负数整数 cmp 顺序反转。**P1-3 已修**(builtin_math 走 fcmp+NaN 传播,与 §0 表一致);`operators.js:424-435` int 路径(P2-3)潜伏非阻塞。等值 `===/!==` 用位相等（NaN/±0 边角可接受）。
3. **不得依赖对象动态属性数超过静态预留槽位**（P0-3 落地前）。alloc 预算：`_object_new` 62、类实例 126、`{}`~1024、非空~512、namespace+16、类信息+4、prototype+256。大字典优先用 Map（链表增长）。
4. **不得依赖数组索引赋值自动增长**（P0-2 落地前）。需要动态增长的数组用 `.push()`，不要越界索引赋值。
5. **不得依赖堆分配跨 `INITIAL_HEAP_SIZE` 边界后仍正确**（P0-1 落地前）。当前靠调大初始堆掩盖。
6. **避开脆弱 API**：`String.lastIndexOf`(P1-1)、`Array.lastIndexOf`(P1-2)、regex `.match/.exec/new RegExp`（仅 .jslib 可用；源码解析正则用手写 `parseRegexLiteral`）、`process.cwd()`（返 `"."`，只能从 repo root 启动）。
7. **大负偏移/大负立即数**：避免 `offset<-65536` 的 load/store 或 `|imm|>65535` 负立即数(P2-2)；避免非 8 对齐正偏移走 64 位 load/store(P2-1)。字段偏移保持 8 对齐。

## 1.5 布局敏感潜伏缺陷（2026-07-09 实证，根因未查）

arm64 gen 级编译器存在**源码布局/体积敏感**的潜伏缺陷：某些源码组合会让 gen2 把
87 模块 import 图静默编成空壳（gen3 仅 ~82KB，无编译警告）。二分矩阵证明为组合触发
（两处无语义关联的改动同时存在才炸，单独任一均收敛）；小程序探针字节级无差异。
推论：**任何源码改动（含 x64-only 文件中的死代码）都必须重跑 arm64 全链验证
gen2==gen3，探针字节不变不构成安全证据。** 疑似 P0-1/P0-3（堆增长/对象容量）类。

## 2. 验证协议（强制，缺一不可）

对任何「修复」：
- **(a) fixtures 不降**：`node tests/run_fixtures.mjs` 不低于当前基线。**基线以 `scripts/bootstrap-gate.sh` 的 `BASELINE_FIXTURES` 为准**(v0.2.6 时点 380,FAIL 必须为 0),该常量随版本上移;历史值仅供参考(v1.5.39 时点 281/283,本文件写作时曾为 31/114)。任何下降=回归，不合入。
- **(b) gen0 最小复现正确**：为该 bug 写 repro，`node cli.js repro.js -o r.bin && ./r.bin` 输出/exit 与 `node repro.js` 一致。
- **(c) 反汇编佐证**（dispatch/编码类）：确认发出预期指令（如 P1-1 须见 `bl _str_lastIndexOf`）。
- **(d) 内存布局变更**（P0-2/P0-3）额外:全量自举重建 `node cli.js cli.js -o gen1 --target <T>` → `./gen1 cli.js -o gen2` 过原崩点(很慢,仅最终验收跑)。

## 3. 自举不变量（每次提交前核对）

1. **fixtures 不低于当前基线**（硬底线;基线随版本上移,见 CHANGELOG 最新条目）。
2. **gen0 复现正确**（每修配 repro，与 Node 一致）。
3. **跨代一致**：gen0 与 gen1 对同一输入产出应字节一致；`__text` 差异是 miscompile 信号。
4. **内存布局原子性**：改对象头（加 capacity）/数组头，必须单次提交内同步所有遍历函数 + 所有编译器手写头站点，禁止半途状态。
5. **只读分析阶段不改文件、不跑 gen1 重建**；调试探针留 scratchpad，勿污染仓库。
6. **自举入口**:`node cli.js cli.js -o gen1 --target <T>`,gen1 再编 cli.js → gen2,`gen2 == gen3` 为不动点(v1.5.32 起更强:`gen1 == gen2 == gen3` 全链字节一致)。旧的 `imp2.js`/`t3.js` 最小驱动已移除(cli.js 直接自举)。

## 4. 并行/串行分工（多 agent）

六组文件零重叠，可六路并行；C 组（对象增长）最大最危险，内部原子不可拆：
- **A**(heap) P0-1 → `allocator.js`
- **B**(array 子系统) P0-2+P1-2+P1-4 → `subscript.js`、`array/*`、`typedarray/*`（同人内聚）
- **C**(对象增长，大改原子) P0-3 → `object/index.js` + 5 编译器手写头站点
- **D**(string dispatch) P1-1 → `builtin_methods.js`
- **E**(math cmp) P1-3 → `builtin_math.js`
- **F**(backend/asm 编码) P2-1+P2-2 → `backend/arm64.js`、`asm/arm64.js`（潜伏，非阻塞）

**建议**：先 A、B（当前 gen1 崩最强候选），验证对崩点/字节差的贡献，再动 C。

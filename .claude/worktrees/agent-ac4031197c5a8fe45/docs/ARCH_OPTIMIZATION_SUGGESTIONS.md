# asm.js 编译器架构优化建议书（架构师视角）

> 成文: 2026-07-12。中长期建议书,数字为当时基线(属性 ~16× 等);工程执行计划见 [PERF_PLAN.md](./PERF_PLAN.md)。

作为资深编译语言架构师，在对 `asm.js` 这一零依赖、自举的原生 AOT (Ahead-of-Time) 编译器项目进行深度代码审计后，我整理了以下在**编译器前端、中间表示 (IR)、后端优化、内存管理 (GC)** 等维度的中长期架构优化建议。

这些建议旨在帮助项目从目前的“轻量朴素 AOT 阶段”平滑过渡到“工业级高性能 AOT 阶段”，在保持极速启动（~2ms）和超低底噪内存的前提下，在峰值执行吞吐量上追平甚至局部超越 V8 引擎。

---

## 1. 编译流体系优化：从“VM 录制重放”演进为“静态 SSA IR”

### 现状评估
当前项目在 [vm/index.js](file:///Users/dmy/work/jsbin/vm/index.js#L128) 中巧妙地实现了一套“函数内指令录制与重放（beginRecord / endRecord）”机制。它在录制期截获 AST 发射的虚拟指令，并在重放期对 FP 栈槽进行活跃区间分析，通过**线性扫描（Linear Scan）**和**栈往返虚拟化（push/pop virtualization）**将热槽提升为 callee-saved 寄存器（`S0-S5`）。
*   **局限性**：由于没有真正的控制流图（CFG）与数据流依赖链，这种机制很难进行跨基本块的更深层次优化（如公共子表达式消除 CSE、循环不变代码外提 LICM、死代码删除 DCE 等）。同时，`VirtualMachine` 类承担了过多的优化职责，导致模块耦合度较高。

### 优化建议
1.  **引入轻量静态 SSA IR**：
    在前端 AST 解析完成后，不直接向 VM 发送指令，而是构建基于**基本块 (Basic Blocks)**、具有显式 **CFG 拓扑** 的中间表示 (IR)，并将其转化为 **SSA (静态单赋值) 形式**。
2.  **解耦优化 Pass 管道**：
    将虚拟寄存器分配、活跃区间扫描、死代码删除、常量折叠等功能彻底从 `VirtualMachine` 中剥离，重构为独立的 **Optimization Pass**（优化通道）。VM 仅作为 IR 翻译或机器码生成的终端。这不仅能极大地精简虚拟机抽象，也为自举测试提供了更清晰的边界。

---

## 2. 类型系统与计算特化：全局类型推断与彻底解箱（Unboxing）

### 现状评估
JS 作为动态类型语言，其运算值默认采用 **NaN-boxing (NaN 装箱)** 表示。在目前的实现中，所有的算术和比较操作均需经历运行时 tag 类型检查及 `_number_coerce` 强制类型转换（详见 [PERF_PLAN.md](file:///Users/dmy/work/jsbin/docs/PERF_PLAN.md#L91)）。这导致 AOT 编译出的原生机器码中充斥着大量的 runtime call，无法发挥 CPU 原生指令的威力。

### 优化建议
1.  **全程序静态类型流分析（Whole-Program Type Inference）**：
    利用 AOT 静态编译的“封闭世界假设（Closed-World Assumption）”，在 IR 级实现基于数据流（Dataflow-based）或 Hindley-Milner 变体的静态类型推断。
2.  **局部变量与循环归纳变量彻底解箱（Unboxing）**：
    一旦静态推断证明某个变量（如 `for(let i=0; i<N; i++)` 中的 `i`，或仅局部使用的数学计算变量）在生命周期内恒为 `Int` 或 `Double`，**彻底剥离其 NaN-boxing 装箱标签**。
    *   在物理寄存器中直接存储 64 位有符号整型或双精度浮点数。
    *   直接为 CPU 发射 `add` / `addsd` 指令直算，完全不经历 `_alloc` 堆分配和强制类型转换，性能可瞬间提升数倍（达到 C 语言级别）。
3.  **单态泛型特化（Generic Monomorphization）**：
    对于静态类型确定的不同调用点，将通用的多态函数自动复制并编译为**多份特化的单态函数**（类似 Rust 的泛型展开），消除运行时的动态分派和去优化税。

---

## 3. 对象模型升级：静态 Shape 偏置与属性去虚拟化（Static Shape & Offset Access）

### 现状评估
属性访问密集型负载是目前最大的性能差距所在（落后 V8 约 16 倍）。虽然通过 `_object_get_ic` 引入了单态站点缓存（IC）（详见 [members.js](file:///Users/dmy/work/jsbin/compiler/expressions/members.js#L38)），但在多态或方法密集调用时仍有显著开销，且 IC 每次仍需进行运行时的自验证指针 cmp。

### 优化建议
1.  **编译期 Shape 静态拓扑分配**：
    在 AOT 环境下，除极个别动态字典外，程序中定义的所有类（Classes）和对象字面量的结构在编译期均是已知的。
    *   在编译期为每种对象结构分派唯一的 Shape ID，并**固化每个属性在对象内存中的相对偏置（Static Offset）**。
    *   当类型推断已知时，`obj.x` 直接编译为 `ldr x0, [x1, #offset]`，无需任何运行时 shape 校验，达到结构体直载级别的效率（超越 V8 JIT 最热路径仍需进行的 inline class 校验）。
2.  **方法调用去虚拟化（Static Devirtualization）**：
    根据继承链的静态分析，对于没有被子类覆写的方法，将间接的虚表/动态查找调用改写为**静态直接跳转（Direct Call）**，这不仅免去了方法查找开销，更能使**函数内联优化 (Inlining)** 成为可能。

---

## 4. 内存管理：精确化栈图与分配路径内联（Stack Map & Inlined Allocation）

### 现状评估
asm.js 的垃圾回收器是一套基于分代式（sticky mark-bit minor + Go 式 full 步调，见 [allocator.js](file:///Users/dmy/work/jsbin/runtime/core/allocator.js)）的**保守式、非移动 GC**。由于栈扫描是保守的，它必须把栈帧和寄存器里任何形似指针的 64 位值都作为 Root，这会导致一定程度的“指针泄漏（Pointer Leak）”和不必要的内存保留。此外，Nursery 的内存分配仍需通过 `call _alloc` 的运行时边界。

### 优化建议
1.  **引入精确栈图（Stack Maps / Reference Maps）**：
    在物理寄存器分配和栈帧生成时，由编译器精确记录并输出每一个 Safe Point（安全点，如 call 指令处）上，哪些栈槽和物理寄存器存放的是真正的垃圾回收指针，哪些是纯数值。
    *   在二进制文件中生成特殊的 `.gc_map` 元数据段。
    *   GC 扫描栈时，直接基于 Stack Map 精确扫描，**彻底根治保守扫描的指针漏出与内存常驻 RSS 偏高的问题**。
2.  **分配快路汇编内联（Inlined Bump-Pointer Allocation）**：
    在代码生成端，将 Nursery 区的分配（指针累加 + 越界检查）快路直接内联发射到创建对象的汇编点：
    ```assembly
    // 伪汇编示例
    ldr x1, [x_heap_nursery_ptr]
    add x2, x1, #obj_size
    cmp x2, x_nursery_limit
    b.gt _call_gc_alloc_slow_path
    str x2, [x_heap_nursery_ptr]
    // 此时 x1 即为分配完成的用户数据指针，仅需 4 条指令
    ```
    只有在 Nursery 区满时才跳转调用慢速运行时 helper，这能将小对象/装箱数创建的开销降到极致。

---

## 5. 字符串与 Shim 运行时重构：Rope 树与栈上分配

### 现状评估
字符串构建性能落后 Node 约 3 倍。目前 `_strconcat` 每次都会触发全内存拷贝和新堆空间分配（详见 [string/index.js](file:///Users/dmy/work/jsbin/runtime/types/string/index.js#L313)），这在循环拼接或大模板字符串渲染中会产生大量垃圾对象，频繁触发 GC。

### 优化建议
1.  **引入 Rope 树（绳索字符串）或 String Slice 视图**：
    在字符串拼接操作 `s1 + s2` 中，不立即分配新内存和拷贝字符，而是返回一个轻量级的 `Rope` 节点（仅包含指向 `s1` 和 `s2` 的指针及长度）。只有在必须传递给 C ABI（如文件 write）或输出时才对其进行“扁平化（Flatten）”拷贝。这能将连续拼接开销从 $O(N)$ 降到 $O(1)$。
2.  **逃逸分析与栈上字符串分配**：
    如果逃逸分析证明某个临时字符串的生命周期不超出当前函数（例如在格式化打印或临时 key 拼装时），可以直接在当前**函数栈帧上分配字符缓冲区**，零 GC 开销。

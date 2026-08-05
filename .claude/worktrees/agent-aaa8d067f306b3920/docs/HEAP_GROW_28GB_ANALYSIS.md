# 28GB 初始堆规避项 —— `_heap_grow` 重定位 bug 根因研究

> 状态:纯研究交付物,**不含任何代码修复**(修复明确延后至 S5 之后)。
> 行号全部于 2026-07-22 对 `/Users/dmy/work/jsbin/runtime/core/allocator.js` 实地 Read 核实。
> 引用文件均为仓库绝对路径;除本文件外未改动任何文件。

---

## 1. 摘要

**规避项是什么。** 运行时启动时 `_heap_init` 一次性 `mmap` 保留
`INITIAL_HEAP_SIZE = 28 GiB` 连续虚拟地址空间(allocator.js:90;Unix 路径 len 取
`this.heapSize`,:388-398),bump 分配器在这段地址上线性切块。这个 28GB 不是性能
设计,而是一个**规避项(workaround)**:堆增长 `_heap_grow` 在 `mmap` 地址 hint 落空、
新段落到别处时的**非连续分支**(:1522-1534)会直接把 `heap_base` 改写为新段基址、
`heap_used` 归零、**放弃旧段**——而 GC 的堆指针判定 `_gc_is_heap_ptr`(:2982-3027)
与 sweep 的走堆范围都只看 `[heap_base, heap_base+heap_used)` 这**一个**区间。
于是旧段里的活对象对 GC 整体失明,后续 GC 会回收/复用仅由旧段对象引用的新段块,
造成悬垂毁堆;且 minor sweep 的起点 `_gc_last_ptr` 仍指向旧段,走堆会横穿
old_end→new_base 的未映射空洞 → SIGBUS(138)(:87-89 注释记录的历史崩点)。

**为什么用 28GB 规避。** 自举编译整个编译器累计 bump 分配量实测 ~25GB
(:90 注释),给 28GB 使自举全程**永不触顶、永不调用 `_heap_grow`**,bug 永不执行。
虚拟保留不占实存:Linux 靠 `MAP_NORESERVE`(flags 0x4022,:355-363)惰性提交,
macOS 匿名 mmap 本就惰性提交,小程序 RSS 仍很小(分代 GC 转正后存活峰值 ~1.4GB,
docs/PERF_PLAN.md:274)。wasm32/wasi 线性内存 4GB 封顶,特化为 1GB 堆(:297-305)。

**为什么不能现在修。** 三条独立原因:
1. **规避项当前承重整个自举**(所有目标平台;plan.md:87 风险表登记为「高」)。
   任何触碰 `_heap_grow` / `_gc_is_heap_ptr` / sweep 的改动都改写 gen1 发射字节,
   强制全链定点迁移(BOOTSTRAP_RULES.md §1.5、§2(d)),且 `_gc_is_heap_ptr` 与 sweep
   是 GC 扫描共享热路径(内联快判见 :3239、:3284),增量改动受并发自举门约束。
2. **正确修复的前置缺失。** 多段可见化(选项①)需要每段独立位图与多段 hot-path
   判定;搬迁/压实(选项②③)需要精确根(哪些字是指针),而精确根(位图精确化路线,
   docs/ROADMAP.md:231-233)尚未开工。ROADMAP 当前官方立场甚至是「移动/压实与
   保守栈扫描冲突,维持非移动」(:234-235)。
3. **排期上属于 S5 之后。** plan.md:87 明确「S5 定点迁移机制落地后排期根治」。
   在定点迁移机制(受控打破 gen2==gen3 一步的双代过渡)存在之前,这类根因级修复
   没有安全的落地窗口。

---

## 2. 机制图解

### 2.1 正常生命周期:`_heap_init` → bump → 触顶 → `_heap_grow`

1. **`_heap_init`**(allocator.js:370):`mmap(addr=0, len=heapSize, RW, ANON|PRIVATE[|NORESERVE])`
   (:388-398;Linux flags=0x4022 含 MAP_NORESERVE,macOS flags=0x1002,:355-363)。
   写 `_heap_meta`:META_HEAP_BASE(:412-415,偏移 0)、META_HEAP_SIZE(:417-419,偏移 8)、
   META_HEAP_USED=0(:421-423,偏移 16);`_heap_ptr = heap_base`(:675-677)。
   另 mmap 标记位图(heapSize/64 = 448MB,:215、:597-609)与 1GB 标记栈(:210、:443-460)。
2. **bump 分配**(`_alloc`:728 → `_bump_alloc`:1271):`new = _heap_ptr + size`,
   与 `heap_base + heap_size` 比较(:1283-1290);未越界则写回 `_heap_ptr`、
   `heap_used += size`(:1292-1301)并维护峰值 META_HEAP_PEAK(:1302-1307,偏移 200)。
3. **触顶**:`new > heap_base + heap_size` → `_bump_alloc_grow`(:1313-1316)
   调 `_heap_grow(A0=本次需要字节)`;成功(RET=1)后重载 `_heap_ptr` 重试 bump(:1321-1325)。
4. **`_heap_grow`**(:1448):扩展量 = max(请求, `HEAP_GROW_SIZE`=16MB,:91、:1451-1462)
   向上页对齐;`MAX_HEAP_SIZE=0` 即不限(:92、:1466-1474 检查恒不触发);
   以 `heap_base + heap_size`(当前堆末尾)为**非 MAP_FIXED** hint 再 `mmap`(:1489-1502)。
   返回值与 `current_end` 比较,分两支(:1512-1520)。

### 2.2 内存布局:三支对照

```
状态 A — 初始(_heap_init 后)
虚拟地址空间:保留 28GB,按页惰性提交(写入才占实存)

heap_base                                        heap_base + 28GB
   │                                                    │
   ▼                                                    ▼
   ┌─────────────┬─────────────────────────────────────┐
   │ heap_used    │   已保留未提交(触碰才 fault 提交)    │
   │ (已提交块)   │                                     │
   └─────────────┴─────────────────────────────────────┘
   ▲                                                    │
   _heap_ptr(bump 游标)                                │
                                                        │
   GC 可见范围 _gc_is_heap_ptr(:3012-3021):              │
   [heap_base+16, heap_base+heap_used] ◀── 单区间 ──────┘
   sweep 走堆 _gc_sweep(:3519-3521):[heap_base, heap_base+heap_used)


状态 B — 触顶后 hint 命中(连续分支 _heap_grow_extend,:1536-1540)
mmap(hint=current_end) 恰好返回 current_end → 线性延展

   ┌─────────────────────────┬──────────────┐
   │ 旧内容(used 部分为活块) │ 新增 16MB     │
   └─────────────────────────┴──────────────┘
   ▲                                        ▲
   heap_base 不变                     heap_size += 16MB(:1538-1540)
   _heap_ptr 不变,heap_used 不变
   ✔ GC 范围 [heap_base+16, heap_base+used] 天然覆盖,无问题


状态 C — 触顶后 hint 落空(非连续分支,:1522-1534)★ BUG 所在 ★
内核把新段放到别处(ASLR / 该地址已被占 / 大映射布局)

   旧段(仍映射,但元数据被放弃)          新段(mmap 另址返回)
   ┌──────────────────┐                 ┌─────────────┐
   │ … 活对象 X …      │                 │ 新 bump 区   │
   │   X.f ──────────────引用──────────▶│   块 Y       │
   └──────────────────┘                 └─────────────┘
   ▲                                    ▲
   旧 heap_base(已被弃)               新 heap_base(:1524 覆写 META_HEAP_BASE)
                                        heap_size = 16MB(:1526)
                                        heap_used = 0(:1527-1529,注释:「旧段剩余空间放弃」)
                                        _heap_ptr = 新段基址(:1530-1533)

   GC 可见范围 = [新heap_base+16, 新heap_base + 新heap_used)
   ✘ X 落在范围外 → _gc_is_heap_ptr 返回 0 → 永不标记、永不上标记栈、字段永不遍历
   ✘ Y 若只被 X 引用 → 无根可达 → 未标记 → sweep 挂回 free-list → 复用 → X.f 悬垂

   另:_gc_last_ptr(:4315,「上次 GC 后的 heap_ptr」,minor 结束时写于 :1835)
   仍指向旧段,而 _gc_sweep_young 从它起、走到 新heap_base+新used 止(:2184-2196)
   → 线性横穿 old_end → new_base 的未映射空洞,读空洞内块头 → SIGBUS/SIGSEGV
```

---

## 3. bug 精确定位

全部行号指 `/Users/dmy/work/jsbin/runtime/core/allocator.js`(除另注)。

### 3.1 链路一:弃旧段 → 范围漏洞 → 旧段活物失明 → 复用毁堆

1. **弃旧段**(非连续分支,:1522-1534)。hint 落空时依次执行:
   - `META_HEAP_BASE ← 新段基址`(:1524);
   - `META_HEAP_SIZE ← 本次扩展量`(:1526);
   - `META_HEAP_USED ← 0`(:1527-1529,注释明言「旧段剩余空间放弃」);
   - `_heap_ptr ← 新段基址`(:1530-1533,注释解释:否则 bump 重试会从旧游标
     继续切出 old_end→new_mapping 的未映射空洞地址发给用户)。
   旧段**没有 munmap**,只是从元数据里被抹掉——页还映射、对象还完整,但运行时
   再无任何结构知道它存在。

2. **`_gc_is_heap_ptr` 范围漏洞**(:2982-3027)。保守判定流程:取低 48 位 payload、
   高 16 位 tag 校验(:2990-3005)、floor8(:3008-3011),然后**单区间**范围检查
   (:3012-3021):`heap_base = META_HEAP_BASE`(:3014)、`used = META_HEAP_USED`
   (:3015),要求 `payload ∈ [heap_base+HEADER_SIZE, heap_base+heap_used]`。
   非连续 grow 之后此区间是**新段**且 `used` 从 0 重数——旧段地址整体落在区间外,
   判定恒返回 0。`_gc_sweep` 的走堆范围同源(:3519-3521,
   `[heap_base, heap_base+heap_used)`,位图位下标 `(cur-heap_base)>>3`,:3565-3568),
   同样只覆盖新段。

3. **失明与毁堆**。旧段活对象 X(栈/寄存器/全局仍持有)对标记阶段不可见:
   指向 X 的字被判非堆 → X 不标记、不进标记栈、**X 的字段永不被扫描**。于是:
   - X 自身:因 sweep 也不走旧段,不会被回收——表现为**静默泄漏**(旧段 RSS
     永不归还,每次非连续 grow 多漏一段);
   - 仅被 X(经旧段对象图)引用的**新段**对象 Y:无任何可见根可达 → 未标记 →
     `_gc_sweep` 把 Y 挂回 free-list(:3491-3496 每轮从零重建链表;小对象
     :3597-3600)→ 后续 `_alloc` 复用 Y 的内存 → X 的字段成为悬垂指针 →
     **use-after-free 毁堆**。这与 memory(g gc-uaf-writer-rootcause)记录的
     「别名/越块读 + GC 复用」毁堆同族,判别同样可用 GC_POISON 链式看点。
   - 附加硬化证据:标记位图按单段 28GB 定长(:215 = INITIAL_HEAP_SIZE/64),
     `_gc_collect` 清位图时 clamp 到 GC_BITMAP_SIZE,注释(:4101-4103)直言
     「正常自举 used 永不超 INITIAL_HEAP_SIZE,此 clamp 无副作用」——即现行
     代码在多处**假设单段、假设永不 grow**,规避项是该假设成立的唯一保证。

### 3.2 链路二:minor sweep 横穿未映射空洞 → SIGBUS(138)

`_gc_sweep_young`(:2179-2196)起点 `cur = _gc_last_ptr`(:2189-2190,其语义为
「上次 GC 后的 heap_ptr」,:4315,minor 结束时写入 :1835),终点
`heap_end = 新heap_base + 新heap_used`(:2184-2188)。非连续 grow 之后,
`_gc_last_ptr` 是**旧段地址**,终点是**新段地址**,:2194-2197 的线性走堆会从旧段
一路读到新段,中间 old_end→new_base 的未映射空洞上第一次 `load HDR_FLAGS_SIZE`
(:2197)即 SIGBUS(138)/SIGSEGV。**这正是 :87-89 注释记录的历史崩点**
(「大堆重定位路径有 bug、访问未映射内存 → SIGBUS(138)」),比链路一的毁堆更早暴露、
更接近确定性崩溃。

### 3.3 链路三(历史/结构性):copy 式重定位的 2× 瞬时 OOM

:90 注释记录上一版修复尝试:非连续时**整段 copy 搬迁**,24GB 堆触发重定位需
瞬时同时持有新旧两份 ≈48GB → 在 32GB 机器上 OOM。当前代码以「弃旧段」换掉了
「copy」,躲开 OOM 但引入了链路一/二。**任何搬迁式修复必须增量**(拷一段、
转发/释放一段),否则只是复活 2× OOM。

### 3.4 旁证:规避项的承重面

- BOOTSTRAP_RULES.md:11(P0-1 归档行,原文):「超 `INITIAL_HEAP_SIZE` 后分配落入
  空洞 | 以 28GB 初始堆 + MAP_NORESERVE 惰性保留缓解;`_heap_grow` 保留,深度锻炼
  待 GC 线收口」。
- BOOTSTRAP_RULES.md:38(§1 不变量 #5,原文):「不得依赖堆分配跨
  `INITIAL_HEAP_SIZE` 边界后仍正确(P0-1 落地前)。当前靠调大初始堆掩盖。」
- BOOTSTRAP_RULES.md:48:§1.5 布局敏感缺陷「疑似 P0-1/P0-3(堆增长/对象容量)类」。
- BOOTSTRAP_RULES.md:70:修复分工 A 组(heap)P0-1 → `allocator.js`。
- plan.md:87(风险表,原文):「28GB 初始堆是重定位 bug 的规避而非修复 | 高 |
  S5 定点迁移机制落地后排期根治;<32GB 机器暂无法自举需在 README 声明」。

---

## 4. 复现方案(仅设计;执行归未来专项,本任务不跑任何编译产物)

目标:在**实验分支**(绝不碰主分支/定点产物)用小堆逼出 `_heap_grow` 非连续分支,
分别观测链路二(空洞 SIGBUS)与链路一(失明毁堆)。

### 4.1 逼出 grow

- 实验分支把 `INITIAL_HEAP_SIZE`(:90)从 28GB 降到 64MB,`HEAP_GROW_SIZE`(:91)
  保持 16MB;重新 `node cli.js repro.js -o out` 产出实验二进制(未来执行)。
- 复现程序:分配 >64MB **长寿命**对象(大数组 + 保留引用,防被 GC 回收缩 used),
  使 bump 游标触顶进入 `_bump_alloc_grow`(:1313-1316)。
- **hint 落空控制变量**:在增长发生前,先分配若干长寿命大 ArrayBuffer,把
  `heap_base+heap_size` 附近的地址空间占住,使非 MAP_FIXED hint(:1489-1502)
  确定性落空、落入非连续分支;或依赖缩小堆后 ASLR 布局变化(macOS 匿名大映射
  常不连续)自然触发。两条路径都要测。

### 4.2 诊断 env 的用法(均已存在,零代码即可用)

| env | 代码位 | 本实验用途 |
|---|---|---|
| `GC_THRESHOLD` | :584-586(:4160-4167 collect 时再读) | 调小(如 `GC_THRESHOLD=1048576`)使 minor GC 高频触发 → `_gc_sweep_young` 很快横穿空洞,**链路二首崩点提前**,便于定位 |
| `GC_POISON` | :3580-3592 | 死块毒填 0xDEAD 且不挂 free-list。**判读规则**:崩在 0xDEAD 模式上 → 活块漏标回收(链路一 Y 被误回收的直接证据);崩在**非**毒值的垃圾上、且现场读出的容器字段属旧段地址 → 悬垂复用证据。注意:poison 只作用于被 sweep 走的**新段**死块,旧段块根本不进 sweep → 旧段自身的泄漏 poison 点不燃,「点不燃 + 仍崩」本身就是范围漏洞的证据 |
| `GC_SHADOW` | :558-577(影子区)、:1942(`_gc_collect_shadow`)、:4317-4319(`_shadow_base`/`_shadow_miss`) | minor 标记 vs full 标记对账。**预期反常**:MISS 计数可能长期为 0——因为旧段对象在 minor 与 full 两侧都被 `_gc_is_heap_ptr` 同式拒绝,差异对账看不见「两侧都盲」的漏洞。MISS≈0 而程序仍崩 = 范围漏洞区别于普通漏标的特征 |
| `GC_SHADOW_BISECT` | :1954-1956 | 跳过 minor 阶段只走 full-mark→sweep,用于分离「minor 路径(链路二)」与「full 路径(链路一)」哪个先炸 |
| `GC_DISABLE` / `GC_FULLONLY` | :584-586 | 对照组:禁用 GC 后链路一/二都不触发(只剩纯泄漏),用于确认崩点确属 GC 交互而非 grow 本身 |

### 4.3 预期观测点(未来仪表化建议;本任务不添加)

- 在 `_heap_grow` 非连续分支(:1524 之前)dump:`META_HEAP_BASE/USED/PEAK`
  (:153-161)、`_heap_ptr`、`_gc_last_ptr`(:4315);判据 = grow 后
  `META_HEAP_BASE ≠ 旧(heap_base+heap_size)` 且 `META_HEAP_USED == 0`。
- lldb 断点 `_heap_grow` / `_gc_sweep_young`,读 `_heap_meta`(base@0/size@8/
  used@16/peak@200)与 `_gc_last_ptr`,验证 4.1 状态 C 的各值。
- 预期现象序列:(a) 非连续分支触发后最近一次 minor GC,`_gc_sweep_young` 在空洞
  首块 SIGBUS(链路二,最早);(b) 若用 `GC_FULLONLY` 关掉 minor,则若干轮 full GC
  后崩在旧段容器字段的悬垂解引用(链路一,毁堆位置随复用漂移);(c) `GC_DISABLE`
  下只观察到 RSS 单调增长(每触发一次非连续 grow 漏一整段),不崩。

### 4.4 安全边界

以上实验**必须在隔离实验分支、独立产物目录**进行;主循环的定点基线门
(gen1/gen2/gen3 与 cli.js 产物)严禁被本实验触碰(与并发自举门同律)。

---

## 5. 修复选项对比

| | ① 多段 GC 可见化 | ② copy 式增量搬迁 | ③ 等精确根后直接上压实 |
|---|---|---|---|
| **思路** | 保留多段:segment 链表/数组进 `_heap_meta`,`_gc_is_heap_ptr` 做多段判定,sweep/sweep_young 按段遍历,每段独立位图 | 非连续时把旧段块增量 copy 进新段,旧位留 forwarding;「拷一段、释放一段」避开 2× 瞬时峰值(:90 历史 OOM) | 先做位图精确化(ROADMAP:231-233,编译期已知容器槽位布局),再上复制式压实(PERF_PLAN:275),grow/碎片/高水位一并解决 |
| **改动面** | 中-大:`_heap_meta` 布局(:153-161 全站点)、`_gc_is_heap_ptr`(:2982-3027)热路径多段化(内联快判 :3239/:3284 同改)、`_gc_sweep`(:3497-)/`_gc_sweep_young`(:2179-)按段走、位图(:215)按段化、`_gc_last_ptr`(:4315)语义变(段内游标) | 极大:forwarding 头与 NaN-boxing 裸指针按位比较冲突,需要句柄间接层或 STW 全量更新;所有直读对象字段的站点都要过 forwarding | 极大且跨专项:精确根(位图/Shape 静态偏移)+ 压实器 + 栈精确化或 pin |
| **主要风险** | is_heap_ptr 是扫描内循环每字判定,多段分支加 GC 停顿;段表本身要 GC 安全;保守误判×段数放大误保留 | 间接层改写值表示 ≈ 重构级;增量 copy 期间并发访问的一致性极难 | ROADMAP:234-235 明言移动/压实与保守栈扫描冲突(当前官方立场为「维持非移动」);栈不精确则压实无解;周期最长 |
| **与自举定点的交互** | 发射字节变(gen1≠旧 gen1,定点迁移一次);但 28GB 保持时 grow 不可达,新代码为死路,代内 gen2==gen3 应仍成立——可用作安全验证刀法;须过快速 gen2-写产物代理门(并发自举门)与 §2(d) 全链重建 | 值表示变更 → 全链定点彻底重立,风险最高 | 精确根本身就是多轮定点迁移;需 S5 定点迁移机制(双代过渡)作为落地窗口 |
| **前置依赖** | 无硬前置,可独立开工;但建议先有 4.x 复现实验固化回归靶 | forwarding 机制或精确根(二选一);避 2× 的增量协议设计 | 精确根(ROADMAP:231-233)+ GC_COMPACTION_DESIGN.md 设计评审(plan.md S5 要求先出设计)+ S5 定点迁移机制 |

---

## 6. 结论:修复延后

1. **规避项当前承重**:28GB 初始堆是全部目标平台自举定点的必要条件
   (plan.md:87;BOOTSTRAP_RULES.md:38 不变量 #5)。在精确根或定点迁移机制就位前,
   **不得**为「缩小初始堆」或「顺手修 grow」触碰 allocator.js 的发射路径。
2. **修复排期**:维持 plan.md:87 决议——S5 定点迁移机制落地后排期根治;优先路线
   建议 ①(多段可见化)作最小修复先行、③(精确根→压实)作根因解随后,② 因值表示
   冲突基本被排除(仅在精确根就位后作为③的实现手段复用)。
3. **复现实验**按 §4 设计留待未来专项,执行须隔离于定点基线门之外。
4. **<32GB 机器限制的 README 声明**(建议措辞,待批准后随修复/发版批次写入,
   遵守「文档与代码同批」铁律):

   > ### 自举要求
   > 自举(gen1→gen2→gen3 定点链,`self.sh`)需要 **≥32GB 内存**的机器:初始堆
   > 保留 28GB 虚拟地址空间(Linux 依赖 `MAP_NORESERVE` 惰性提交;在严格
   > overcommit 环境如部分 CI runner 上可能启动失败),运行期实际 RSS 远小于此,
   > 但虚拟保留与峰值工作集要求物理内存 ≥32GB。这是已知规避项而非最终设计,
   > 根因与修复计划见 `docs/HEAP_GROW_28GB_ANALYSIS.md`。

---

## 7. 与 GC_COMPACTION_DESIGN.md 的关系

**现状(已核实):`GC_COMPACTION_DESIGN.md` 尚不存在**(2026-07-22 全仓
`find` 无此文件;docs/ 目录亦无)。与本主题相关的既有记载只有两处:
- docs/PERF_PLAN.md:273-275(L5):「分代 GC 已转正(峰值 ~1.4GB)。剩余:……
  复制式压实(见 memory:gc-perf-diagnosis 的 4.7GB 高水位根因)」——压实被列为
  持续调优项,尚无设计文档;
- docs/ROADMAP.md:234-235:「移动/压实与保守栈扫描冲突,维持非移动」——当前
  官方立场将压实列为**非目标**;同文件 :231-233 的「bitmap 精确化路线」
  (对运行时容器做半精确扫描、保守扫描仅留给栈)是松动该立场的唯一台阶。

**精确根是两者共同前置**:
- 对 grow 修复(选项①):多段 `_gc_is_heap_ptr` 若仍是纯保守范围判定,段数增多
  会线性放大误保留;知道「哪些字是指针」才能做段级精确判定与逐段位图;
- 对压实(选项③/GC_COMPACTION_DESIGN.md):移动任何对象都要求更新**全部**指向位,
  保守扫描下无法枚举指向位,压实根本不成立——这正是 ROADMAP:234-235 冲突的实质;
- 两条线的交汇点即 ROADMAP:231-233 的位图精确化(与 memory 性能五大支柱
  ①解箱/②静态 Shape 硬编码偏移同源:编译期已知对象布局 → 运行期知道指针槽位)。

**建议**:S5 期间立项创建 `GC_COMPACTION_DESIGN.md` 时,把本文档的选项①收录为
「最小修复(多段可见,不移动)」阶段、选项③收录为「根因解(精确根 + 压实)」阶段,
两阶段共享精确根基建;GC/内存性能诊断(memory:gc-perf-diagnosis 的 4.7GB/240s
散落存活 + sweep 扫高水位)作为压实阶段的验收基准。

---

## 附录 A:已核实行号索引(2026-07-22)

文件 `/Users/dmy/work/jsbin/runtime/core/allocator.js`(除另注):

| 主题 | 行号 |
|---|---|
| 规避项缘由注释(SIGBUS(138)、惰性提交、32GB 可容) | :87-89 |
| `INITIAL_HEAP_SIZE = 28 GiB` + 历史注释(24GB copy→2× OOM;~25GB 需求) | :90 |
| `HEAP_GROW_SIZE = 16MB` / `MAX_HEAP_SIZE = 0` / `GC_THRESHOLD_PERCENT = 75` | :91-93 |
| META 偏移 BASE=0 / SIZE=8 / USED=16;PEAK=200 | :153-155、:161 |
| `HEADER_SIZE=16`;标记栈 1GB;`GC_MIN_THRESHOLD=4GB` | :203、:210、:211 |
| `GC_BITMAP_SIZE = INITIAL_HEAP_SIZE/64` | :215 |
| wasm32/wasi 特化 1GB 堆 / 64MB 栈;native 取 INITIAL_HEAP_SIZE | :297-305(:300=1GB,:303=native) |
| mmap flags:Linux 0x4022(含 MAP_NORESERVE)/ macOS 0x1002 | :355-363 |
| `_heap_init` 标号;Unix mmap len=heapSize | :370;:388-398(len @:390) |
| meta 初始化(base/size/used=0) | :412-423 |
| GC_SHADOW 影子区 mmap;GC_THRESHOLD env 缺省 256MB nursery | :558-577;:579-589(缺省值 @:586) |
| `_heap_ptr = heap_base` | :675-677 |
| `_alloc` 入口;`generateBumpAlloc`/`_bump_alloc` | :728;:1268、:1271 |
| bump 边界检查 → `_bump_alloc_grow`;used 累加;peak 维护 | :1283-1290;:1297-1301;:1302-1307 |
| grow 调用点与重试 | :1313-1325(call @:1316) |
| `_heap_grow` 标号;扩展量计算(max 16MB,页对齐) | :1448;:1451-1462 |
| hint + 空洞危险注释 | :1476-1481(空洞注释 @:1481) |
| Unix mmap hint = heap_base+heap_size(非 MAP_FIXED) | :1489-1502(hint @:1492-1494) |
| 连续性判定 → `_heap_grow_extend` | :1512-1520 |
| **非连续分支**:base 覆写 / size / used=0 / `_heap_ptr` 重定位 | :1522-1534(:1524、:1526、:1527-1529、:1530-1533) |
| 连续分支 `heap_size += grow` | :1536-1540 |
| minor collect;`_gc_last_ptr = heap_ptr`(minor 结束) | :1762-1764;:1835 |
| `_gc_collect_shadow`;`GC_SHADOW_BISECT` | :1942;:1954-1956 |
| `_gc_sweep_young` 起= `_gc_last_ptr`、止= heap_base+used(空洞横穿点) | :2179-2196(起 @:2189-2190,止 @:2184-2188) |
| 扫描内循环内联快判(热路径证据) | :3239、:3284 |
| `_gc_is_heap_ptr`;floor8;单区间范围检查(基于 META_HEAP_USED) | :2982-3027(floor8 :3008-3011,范围 :3012-3021,used @:3015) |
| `_gc_sweep` 走堆 [heap_base, heap_base+used);位图位下标 | :3497-3521(范围 :3519-3521);:3565-3568 |
| GC_POISON 毒杀死块 | :3580-3592 |
| `_gc_collect`(full);清位图 clamp 注释「used 永不超 INITIAL_HEAP_SIZE」 | :4078-4081;:4096-4108(注释 :4101-4103) |
| collect 时重读 GC_THRESHOLD env | :4160-4167 |
| `_gc_last_ptr` 数据标号(「上次 GC 后的 heap_ptr」);`_shadow_base`/`_shadow_miss` | :4315;:4317-4319 |

其他文件:
- `/Users/dmy/work/jsbin/BOOTSTRAP_RULES.md`:11(P0-1 行)、:38(不变量 #5)、
  :48(§1.5 疑似 P0-1)、:70(A 组分工)。
- `/Users/dmy/work/jsbin/plan.md`:87(风险表行)。
- `/Users/dmy/work/jsbin/docs/ROADMAP.md`:231-233(bitmap 精确化路线)、
  :234-235(移动/压实非目标)。
- `/Users/dmy/work/jsbin/docs/PERF_PLAN.md`:273-275(L5 复制式压实剩余项)。
- `/Users/dmy/work/jsbin/self.sh`:2-4(定点链入口,无 GC_* env)。
- `/Users/dmy/work/jsbin/README.md` / `README.zh-CN.md`:**当前无 32GB 声明**
  (grep 无命中,§6 为建议新增措辞)。

## 附录 B:行号漂移说明(分诊值 → 核实值)

| 分诊值 | 核实值 | 说明 |
|---|---|---|
| `_heap_init` mmap len :351-362 | 标号 :370,mmap len :388-398 | **下漂 +19~+28**(上方代码增长);引用以核实值为准 |
| wasm32 特化 1GB :297-300 | :297-305(1GB @:300) | 基本一致,区间略展 |
| `_heap_grow` 非连续分支 :1517-1534 | :1522-1534(弃段 store @:1524-1533) | 小漂;:1517-1520 实属连续性判定 |
| `_gc_is_heap_ptr` :2984-3027 | :2982-3028(范围检查 :3012-3021) | ±3,一致 |
| 空洞注释 :1481 | :1481 | 精确一致 |
| 缘由注释 :87-89、`INITIAL_HEAP_SIZE` :90 | :87-89、:90 | 精确一致 |

分诊未列出、核实中新发现的崩溃路径:`_gc_sweep_young`(:2179-2196)以旧段地址的
`_gc_last_ptr` 为起点横穿未映射空洞,即 :87-89 所述 SIGBUS(138) 的具体机理(见 §3.2)。

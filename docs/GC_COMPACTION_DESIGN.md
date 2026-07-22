# 移动式/压实 GC 设计文档 — 未来专项地基

> 日期:2026-07-22 · 状态:**设计地基,非执行计划**。现行官方立场见 `docs/ROADMAP.md:234-235`
> ("移动/压实与保守栈扫描冲突,维持非移动");本文档系统性盘点上移动 GC 的前提、
> 代价与分阶段路线,供未来立项评审。
> 行号均经 Read 核实(2026-07-22 HEAD),路径相对仓库根。

---

## 1. 摘要与动机

jsbin 运行时是保守式三色 mark-sweep GC(非移动、非压实)+ 分代(sticky mark-bit
minor + GOGC 风格 full 步调,nursery 触发缺省 256MB)。非移动的直接后果是
**存活对象散布钉住内存页、sweep 必须线性扫过整个堆高水位**,RSS 远高于真实存活量。

**实测数据**:

- 分代 GC 转正后自编译峰值 **~1.4GB**(`docs/PERF_PLAN.md:274`,L5 节)。
- 历史诊断(memory:gc-perf-diagnosis,GC_STATS 构建实测):分代化之前编译 cli.js,
  `heap_used`(bump 高水位)= **5.87GB**,而 `live_bytes` 仅 **445MB**,`gc_count`=1
  (4GB 阈值全程只触发一次),`alloc_count`=1.05 亿。对照 Node 编译同一文件
  ~985MB RSS / 3.2s —— 即 **4.7× 内存、74× 慢**(4.7GB/240s 之由来)。
- 诊断三根因:
  1. **存活散布钉页**:不压实 → 最高存活块贴近 bump 顶端,死块与活块同页,
     无任何 madvise/归还机制(运行时至今只有 mmap/munmap,无 madvise,
     系统调用表见 `runtime/core/allocator.js:229-246`);
  2. **sweep 线性扫高水位**:`_gc_sweep` 从 `heap_base` 走到 `heap_base+heap_used`
     (`allocator.js:3518-3527`),`heap_used` 只增不减 —— 降阈值勤 GC 则每次扫全
     高水位堆,512MB 阈值时自编译 >400s;minor 专用 `_gc_sweep_young` 只走
     `[_gc_last_ptr, heap_end)`(`allocator.js:2189-2190`)缓解了 young 段,
     但 full 仍扫全堆;
  3. **固定虚拟预留**(见 §2.4)。
- 已验证的大赢(与 GC 结构正交):模块解析三函数记忆化后自编译 240s→73s、
  分配 1.05亿→5749万、高水位 5.87GB→4.03GB(memory:gc-perf-diagnosis)。
  即 GB 级高水位主要是"未回收的瞬时 churn",不是保留数据 —— 这恰恰是
  压实/复制式 GC 的理想工况(存活小、 churn 大)。

**目标**:让 RSS ≈ live(自编译场景 445MB 量级),sweep 扫描面 ≈ live 而非高水位,
死页可归还 OS。本文档给出从"止血"到"全堆压实"的四阶段路线与每阶段门禁风险。

---

## 2. 现状架构速览

### 2.1 分配器三级(`runtime/core/allocator.js`)

| 层 | 适用 | 机制 | 关键位置 |
|---|---|---|---|
| size-class 空闲链表 | ≤512B,18 档(8..512) | `META_FREE_LISTS@32`(18×8)头插链表,sweep 从零重建 | size classes `allocator.js:97-117`;meta 布局 `:153-162`;查链 `_alloc` `:728` 起,小对象分发 `:856-859` |
| span bump | 小对象链空时 | 每 class 一块 64KB 对齐 span bump(`SPAN_SIZE=65536` `:125`);pagemap 1B/64KB 页记 class+1;span 尾余/gap 以 class=63 哨兵块填充保持 sweep 线性同步 | span 分配 `:923-1040`(pagemap 写 `:1032`);pagemap 初始化 `:650-673`;标签 `:4296` |
| 大对象 bump | >512B | `_heap_ptr` bump + `large_free@176` 最佳适配;出口置 startmap 起始位 | `_alloc_large` `:1107`;startmap 登记 `:1221-1235` |

**块头 16B**(`allocator.js:193-205`):`flags_and_size@0`(bits0-1 mark 遗留位——实际
标记走独立位图不动头;bits2-5 type;bits6-9 class;bits16-63 用户大小)、
`HDR_NEXT@8`(仅空闲块的链表指针,活块此字段属用户区前一语义——**不可挪作 forwarding**,
见 §6)。

### 2.2 标记与清扫

- **标记位图**:独立 mmap,每 8 字节堆 1 bit(`bitIdx=(block-heap_base)>>3`),
  448MB 虚拟(28GB/64)惰性提交。mark 位放位图而非头部的原因:保守误判指针只会
  点亮一个从不被读的位,不会腐蚀活对象头(`allocator.js:212-215`;
  `_gc_mark_one` `:3057-3090`)。
- **startmap**:同尺寸 448MB,每块起始 1 bit,内部指针回析真容器
  (`allocator.js:622-648`;mark 内解析 `:3075-3090`)。
- **pagemap**:1B/64KB 页,span 页内任意(含内部)指针 O(1) 格网整除得块起始
  (`allocator.js:3092-3124`)。
- **标记栈**(gray 队列):独立 mmap 1GB 虚拟惰性提交(`allocator.js:210`,
  `_gc_push_gray` `:1736`,`_gc_drain` `:3232`,溢出 `_gc_rescan_overflow` 重扫)。
- **sweep**:零 call 表驱动内循环(`_gc_s2c`/`_gc_c2s` 数据段表),逐块读头、
  位图查活、死块按 class 头插回 free-list(`_gc_sweep` `:3497` 起,范围设置
  `:3518-3527`)。`GC_POISON` 模式死块毒填 0xDEAD 不挂链,供漏标判别(`:3580-3582`)。

### 2.3 根集(全保守)

`_gc_mark_roots`(`allocator.js:3311-3369`)两类根,逐 qword 过 `_gc_is_heap_ptr`
保守判定:

1. **native 栈** `[当前 SP, _stack_base)`(`:3319-3337`);协程栈上执行时不触发 GC
   (`:782-793`,SP 落堆内会跨未映射区);linux-arm64 多 M 有扩展根扫描
   `_gc_scan_stack_range`(`:3371` 起)。
2. **数据段** `[_data_start, _data_gc_end)`,跳过 `[_heap_meta, _heap_meta_end)`
   (`:3339-3366`)。`_data_gc_end` 由编译器在所有 qword 数据(含 IC 站点槽、
   全局/模块导出/捕获变量的 box 槽)之后、字符串常量之前落下
   (`compiler/index.js:3094-3097`)。
3. **寄存器根**:`_alloc` 触发 GC 前把 A0-A5、V4-V7 存进 `_gc_regsave`(数据段
   10 qword,落根扫描区),GC 后原样恢复——注释明言"GC 不移动对象,指针仍有效"
   (`allocator.js:794-809`、`:842-853`,标签 `:4360`)。

**保守判定** `_gc_is_heap_ptr`(`allocator.js:2982-3028`):高 16 位 tag ∈
{0(裸指针), 0x7ffc..0x7fff(串/对象/数组/函数)}、payload 8 对齐 floor、落在
`[heap_base+16, heap_base+heap_used]` → 视为指针。**无法区分"恰好像指针的整数"
与真指针,也无法枚举某对象的全体引用者**——这是移动 GC 的根本障碍(§4)。

### 2.4 分代机制与虚拟预留

分代缺省开启(`allocator.js:579-595`):

- **nursery trigger**:缺省 256MB(`268435456`,`:586`),`GC_THRESHOLD` env 可调,
  `GC_DISABLE`/`GC_FULLONLY` 改行为;full 步调 GOGC 式:首个 full 在累计 512MB,
  其后 `since_full ≥ live×2` 或 `_rs_overflow` → full,否则 minor(`:811-840`,
  初值设置 `:590-595`)。
- **sticky mark-bit minor**(`_gc_collect_minor` `:1758-1846`):不清位图(老对象
  保持已标,drain O(1) 跳过);根 = 常规根 + **全量 box 登记表**(`:1779-1795`)+
  **记忆集容器**(`:1797-1811`,经 `_gc_scan_container` 类型感知重扫间接块);
  `_gc_sweep_young` 只走 young 段、不清 free_lists,存活者保持标记(sticky)即晋升
  old(`:2241`),young 起点 `_gc_last_ptr` 推进到 heap_ptr(`:1836`)。
- **写屏障** `_gc_remember`(`:2305-2369`):目标容器 < `_gc_last_ptr`(old)时记入
  RS(上限 128MB/16M 条,满置溢出旗 minor 退化 full);**容器级去重位图**
  (1 bit/8B 块起始)防热容器 O(写次数×容器) 平方爆炸(`:2333-2358`)。
- **box 登记**(`_box_alloc` `:2271-2303`):编译器内联发射 box 写无法可靠插屏障,
  故所有装箱变量块指针登记成表(上限 64MB/800 万条),minor 全量当根扫
  (`:486-489` 注释即此结构性替代的说明)。
- **诊断**:GC_SHADOW 影子快照区(两遍 mark 对照查漏标,`:558-577`、
  `_gc_collect_shadow` `:1936` 起)、GC_POISON(死块毒填)、GC_STATS。

**固定虚拟预留**(native 路径,均为惰性提交,RSS 按触碰增长):

| 区 | 尺寸 | 位置 |
|---|---|---|
| 堆本体 | 28GB(`INITIAL_HEAP_SIZE`,`:90`,给足以免重定位绕 SIGBUS bug) | `:388` 起 |
| 标记位图 | 448MB(heap/64) | `:215`、mmap `:597-619` |
| startmap | 448MB | `:622-648` |
| RS 去重位图 | 448MB | `:531-556` |
| 标记栈 | 1GB | `:210`、mmap `:469-473` 一带 |
| box 登记 64MB + 记忆集 128MB | 192MB 一段 | `:485-521` |
| pagemap | 448KB(heap/64KB) | `:650-673` |

合计 ~30.5GB 虚拟地址(32GB 机器可容,wasm32 按比例缩至 1GB 堆,`:297-305`)。
虚拟预留本身不吃 RSS,但标记位图/startmap/去重位图会随堆触碰面增长——
压实若能把堆触碰面压到 live 量级,这三张 448MB 位图的 RSS 也同步 shrinks。

---

## 3. 精确根盘点表

移动对象 = 必须把**每一处**指向旧地址的引用改写为新地址。下表盘点所有"持内部/
外部堆指针"的站点(核实后行号)。修补方式列按"引用存储位置"分三类:
**A=对象自身字段**(随对象拷贝,无需单独修补)、**B=根表/数据段槽**(停世界扫描
修补)、**C=代码数据段烙入**(需专门表 + 修补)。

| # | 指针类别 | 来源与核实位置 | 数量级 | 移动时修补方式 |
|---|---|---|---|---|
| ① | 对象头 `props_ptr@32` / `flags_ptr@40` | 对象头 56B 布局 `runtime/types/object/index.js:29-33`;读写热路 `_object_get` `:396,429,459`、`_object_get_ic` `:1101,1121,1135`、`_object_set_ic` `:1391,1406,1448`;GC 侧 `_gc_scan_container` 读 props@32/flags@40 `allocator.js:1892-1897` | 每对象 1-2 个 | **A**:字段在对象头内,拷贝新对象时随之拷贝即完成。真正要修补的是"持有该对象头指针的外部引用"(见 ④⑤⑥);props/flags 间接块本身若移动,则持有它的头字段需重写——即对象拷贝阶段按类型布局自修补 |
| ② | 数组头 `data_ptr@24` | 数组头布局 `runtime/types/array/index.js:4-8,20`(type@0/length@8/capacity@16/data_ptr@24);增长拷贝 `:75`;GC 侧 `allocator.js:1886`;**编译器内联快路**:`arr[i]` 内联读 `compiler/functions/statements.js:1467-1469`(P5.0)、`compiler/expressions/members.js:774`;布局注释 `allocator.js:2918` | 每数组 1 个 | **A**:同 ①,data_ptr 在数组头内随拷。注意 data 区存的是 boxed JSValue 数组,移动 data 区时其内容(指向其他堆对象的装箱值)需逐 8B 扫描修补——类型已知(定长 qword 数组),可精确扫 |
| ③ | **代码数据段 IC 站点槽** | 读 IC 站点槽 24B `{obj_shape@0, holder@8, index@16}`:`object/index.js:1060-1093`(槽结构注释 `:1060`,holder 读 `:1116`,obj_shape 读 `:1093`);写 IC 站点槽 16B `{shape@0, index@8}`:`object/index.js:1380-1402`(shape 读 `:1383`,index 读 `:1387`)。**发射点**:`compiler/expressions/members.js:183-189`(24B)与 `:208-213`(16B),经 `addDataLabel`/`addDataQword` 烙进**数据段**(非 __text) | 编译期每属性访问站点 1 个;编译器自身数千,用户程序按规模 | **C**:`holder@8` 是裸堆指针(多为原型对象)。站点槽落在 `[_data_start, _data_gc_end)` 内(`compiler/index.js:3094-3097`)→ 现已被根扫描保守当根(存活安全),但**移动时必须修补**。修补需要"IC 槽清单":编译器发射时已知全部 `icg_site`/`ics_site` 标签 → 追加一张 ic_site 表(标签地址+槽宽)即可批量扫改。`obj_shape` 字段:v1 形状描述符是**静态数据段记录**(非堆指针,`docs/SHAPE_IC_DESIGN.md` §2),不移动 → 该字段免修补;v2 若改为堆上 transition shape 则需一并修补。route B 引擎片段已暴露相关约束:片段页 RX 只读,IC 槽回写会 SIGBUS,故片段走 `engineNoIC` 形态(`members.js:170-182`)——未来任何"扫改代码侧数据"都要面对写保护问题 |
| ④ | `__proto__@16` 裸链 | 对象头内存**裸指针**(非 nanbox):`object/index.js:467`(原型链查找 load + 出口处 or 0x7FFD 装箱 `:471`)、IC 直接原型键 `:1131`;`instanceof` 上溯 `runtime/core/jsvalue.js:899,918`(raw load@16,64 层防环) | 每对象 ≤1 | **A**:字段在对象头内随拷。原型对象本身移动时,所有持有它的子对象头 @16 需在堆内引用修补阶段按类型布局重写(对象头是 56B 定长、@16 语义已知 → 可精确) |
| ⑤ | 字符串 nanbox payload(0x7FFC 装箱值) | `JS_MKSTR` `jsvalue.js:151-153`:payload 直指 char 数据(JSValue 层无头,`:169-170`);堆字符串(运行期 concat 产物)块移动时,所有持 0x7FFC 值的槽都要重新装箱 | **最大宗**:遍布 props value 槽、数组元素、box[0]、全局槽、栈/寄存器临时值 | 堆字符串若**钉住不移动**(字符串不可变+驻留,是钉住首选),则免修;若移动,需在全部"可持 boxed 值"的位置(②data 区/props 区随拷精确扫、⑥根表修补、栈/寄存器——后者保守不可修补,见 §4)重装箱 |
| ⑥ | 根表本身:box 登记 / 记忆集 / 寄存器根 | `_box_alloc` 登记表 `allocator.js:2271-2303`(box 裸指针数组,上限 800 万);`_gc_remember` 记忆集 `:2305-2369`(old 容器裸指针,去重位图);`_gc_regsave` `:794-809`(A0-A5/V4-V7 十 qword) | box=装箱变量数;RS=去重后容器数(通常 ≪ 上限);regsave 恒 10 | **B**:box 表逐条修补(box 本身也移动则表项改新址;box[0] 内容若为装箱值亦需重装箱);RS 表两条路——修补条目,或**丢弃重建**(移动后屏障重新捕获,代价=下轮 minor 前 old→young 边无记录,需一次性全量重扫 old 容器兜底);regsave 是 GC 内部暂存,GC 流程自身控制,可在修补后写回新值(现行 `:842-853` 恢复逻辑需同步改) |

**补充根(已被保守扫描覆盖但移动时需同等对待)**:数据段全局/模块导出/捕获变量的
box 槽(`_data_gc_end` 之前)、memoized 内建引用槽 `_builtinref_*`
(`compiler/expressions/members.js:219-229`)、Promise 微任务队列头尾
(`allocator.js:4406` 附近)、per-M 上下文 `MCTX_*` 活值槽(`allocator.js:164-191`,
在根扫描区内)。

---

## 4. 根本障碍:保守根 vs 精确根

**移动 GC 的不变量**:对象 O 从 A 移到 B 后,系统中不得残留任何指向 A 的活引用。
这要求 GC 能**精确枚举 O 的全体引用者**。保守根做不到:

- `_gc_is_heap_ptr`(`allocator.js:2982-3028`)只回答"这个字**像不像**堆指针",
  对栈/寄存器里的字,无法区分 ①真对象指针 ②恰落堆址范围的整数/位模式
  ③内部指针(字节游标,startmap 回析已处理标记但无法修补)三类。
- 若对"像指针"的字做修补写回:会把一个整数字段改成指针 → 程序语义损坏。
- 若不修补:被误判字指向的旧地址处对象若已移动 → 悬空。

**两条路线**:

### 路线 ①:全局精确根化

- **栈**:编译器在每个 GC 安全点(主要是 `call _alloc` 及一切可触发 GC 的 call)
  发射栈映射(stack map),声明"此刻哪些寄存器/栈槽持堆指针"。现状是
  AST→asm 直发、**无 IR 层、无寄存器分配器抽象**(memory:gc-perf-diagnosis 结论),
  活值位置信息在发射后即丢失 —— 需要一层帧描述符基础设施。
- **寄存器**:`_gc_regsave` 机制(`:794-809`)已是"GC 点寄存器根快照"的雏形,
  缺的是"哪些是精确指针"的标注;保守地把 10 个 qword 全当根可以,但精确化
  才能解锁移动。
- **数据段**:编译期完全已知——全局槽、IC 站点槽(③)、memo 槽都可建分类表。
- **堆内**:运行时容器布局类型感知,`_gc_scan_container`(`:1848-1934`)已是
  "半精确扫描"(按 type 字节只扫指针槽)的现成蓝本(ROADMAP.md:231-233 亦指向此)。

结论:堆内已半精确,数据段可全精确,**栈/寄存器是唯一硬缺口**,且其解法
(栈映射 + 帧描述符)与未来的 IR 层/寄存器分配器专项强耦合,是比自举更大的工程。

### 路线 ②:保守 + 钉住(pinning)混合

保留保守扫描,但**对保守根可达的对象一律钉住不移动**,只移动"仅由精确根
(数据段槽、box 表、堆内字段)可达"的对象:

- 栈/寄存器扫描发现"像 young 指针"的字 → 把其指向对象钉住(不移动)。
- 数据段/box 表/堆内字段是精确可枚举的 → 其独占可达的对象可安全移动并修补。
- 这是 BDW 式保守 GC 做压实的经典思路(页/块级钉住),**无需栈精确化即可起步**;
  压实比取决于"栈/寄存器直达对象占存活的比例"——编译器场景大量活结构挂在数据段
  (模块表/AST 根)与 box 上,预期可移面不小,但**必须实测**(开放问题 §9-Q1)。

两路线不互斥:② 是 ① 的真子集前置——先上 pinning 移动,栈映射基建落地后再逐步
解钉。本文档 §8 路线按此排布。

---

## 5. 两案权衡:句柄化 vs GC 时批量修补

移动之后引用如何找到新地址,有两种实现形态:

### 案 A:句柄化(indirection)

所有 JS 对象引用改为 handle→object 二级间接;移动只改 handle 表,访问站点永不修补。

- **代价**:每次属性读/数组读多一跳依赖 load(流水气泡),与本项目性能支柱正面冲突
  ——解箱 int 驻留、静态 Shape 单 `ldr` 偏移(memory:perf-five-pillars、
  subscript-inline-p5:P5.0 数组下标读 12×→2.1× 的收益全部建立在"裸指针单跳"上);
  全局估计 20-40% 慢化;handle 表本身新增 RSS 与一次分配。
- **收益**:移动/修补代价低且均匀,概念简单。
- **裁定**:与性能模型根本冲突,**不推荐**。

### 案 B:GC 时批量修补(停世界扫描改写)

引用仍是裸指针;STW 期间扫描全体精确根位置,把旧地址改写为新地址,旧块写
forwarding word(§6)兜底查表。

- **修补面**(配合 §3 表):
  1. 堆内字段:拷贝阶段按类型布局**自修补**(对象头 56B 定长 @16/@32/@40、
     数组头 32B @24、props 区 16B/属性 value@8、data 区 8B/元素——逐类已知);
  2. 数据段:复用 `_gc_mark_roots` 的数据段扫描循环(`:3339-3366`),
     mark 动作换成"命中 young→改写";IC 槽经 ic_site 表精确定位(③);
  3. box 表 / RS 表:线性扫改(⑥);
  4. 栈/寄存器:路线②下**不修补,只钉住**;路线①下按栈映射精确修补。
- **代价**:修补暂停 ∝ (精确根总量 + live 堆字数);mutator **零日常开销**——
  这是关键优势:保护现行全部快路(IC、解箱、内联下标)。
- **已知工程约束**:数据段 RW 可写,修补无碍;但 route B 引擎片段页 RX 只读
  (`members.js:170-182`),片段内若持有堆引用(当前以 `engineNoIC` 规避),
  全堆修补阶段需 mprotect 窗口或继续豁免。
- **裁定**:**推荐案 B**,前提是 §4 路线②/① 的根精确性分级。

---

## 6. forwarding word 方案:shape_ptr@48 挪用分析

移动 GC 在旧块留 forwarding word,供"尚未修补到的引用"查表重定向(修补不保证
原子一次性完成时尤其需要)。

### 6.1 候选余量盘点

- **对象头 56B 的 shape_ptr@48**(`object/index.js:29-33`):当前**恒 0 占位**
  (`:294-295` 显式写 0;`_object_new` 之外无任何写点),是对象头唯一空闲 qword。
- **16B 块头 HDR_NEXT@8**(`allocator.js:201,205`):仅死块用作 free-list 指针。
  压实场景死块本就不进 free-list,看似可复用,但 sweep/free-list 路径与"死块"
  语义深度纠缠,双用需全局判别,不推荐。

### 6.2 与形状 IC 的冲突/共存

- 形状 IC 读 @48 做形状比对:读 IC `object/index.js:1113`(`load shape_ptr@48`
  vs 槽缓存)、写 IC `:1402`。
- **v1 共存成立**:形状描述符是**静态数据段记录**(`docs/SHAPE_IC_DESIGN.md` §2
  `__shape_lit_<id>`),非堆指针、不移动;对象拷贝时 @48 的形状值原样带入新址,
  IC 槽缓存的形状值继续有效。forwarding word 只写进**旧(已死)副本**,修补完成
  后无活引用到达旧址 → 二者时序上互斥。
- **判别 forwarding vs 真形状**:形状描述符地址 ∈ `[_data_start, _data_gc_end)`
  (静态数据段),forwarding 新址 ∈ `[heap_base, heap_end)` → **地址段即可判别**;
  亦可征最高位 tag。
- **v2 冲突**:`SHAPE_IC_DESIGN.md` §2 明言 v2 再评运行时 transition 链——一旦
  形状对象改为**堆分配**,shape_ptr 变堆指针:它自身需要被修补(堆内自修补阶段
  处理),且 @48 不再"恒为静态值或 0"→ forwarding 判别逻辑需升级或改址。
  **结论:@48 是"借",不是"让";shape IC v2 立项时必须同步交还方案。**
  **2026-07-22 更新:shape v2 已立项(`docs/SHAPE_TRANSITIONS_DESIGN.md`),其 §4 提出
  仲裁案——shape 堆化先行、本方案 forwarding 改走 §6.3 位图判活通用方案(待评审)。**

### 6.3 @48 覆盖不到的类型 → 通用 forwarding 方案

@48 只存在于对象头。数组头 32B(字段全占用)、函数/闭包块、字符串块、8B box、
Map/Set 节点等都没有空闲 qword。通用方案:

- **利用独立标记位图判活**(本项目特有优势):mark 位不在头里(§2.2),
  "旧块是否已死"= 位图该块 bit=0。于是 forwarding 协议可为:
  **旧块用户区首 qword 写 {新址|1}**;引用查表路径先查位图——活则按原语义读
  (首 qword 是 type 字段,不会被误当 forwarding),死则读首 qword 重定向。
  代价:每次潜在 forwarding 查询多一次位图 load;收益:全类型统一,不依赖类型余量。
- 对象头可同时用 @48 做**零位图查询快路**(查 @48 是否堆址段),位图方案兜底。
- 与 `GC_POISON` 互斥:死块要么是 forwarding 要么是毒填,诊断模式需二选一。

---

## 7. 分代协同:nursery 半空间复制试点

nursery 是移动 GC 的天然首选:young 段小(256MB 触发)、根集小且大半精确。

### 7.1 布局

- 现 young 段是主堆 bump 尾部(`_gc_last_ptr` 到 `_heap_ptr`,`:524-529,1836`),
  无独立 to-space。半空间试点两条路:
  - **(a) 堆内分区**:在主堆 28GB 范围内划 from/to,复用标记位图/startmap
    (位图索引 = 堆偏移,天然覆盖);bump 在 to-space 分配,from/to 角色每轮互换。
  - **(b) 独立 to-space mmap**:位图/startmap 需扩索引域或独立第二张——不推荐,
    牵动 `_gc_is_heap_ptr` 的范围判定(`:3012-3021`)与全部位图计算。
  建议 **(a)**。

### 7.2 复制 + 修补协议(配合 §4 路线②)

1. **栈/寄存器保守扫 → 钉住集**:扫 `[SP,_stack_base)` 与 `_gc_regsave`,
   凡"像 young 指针"的字 → 其指向对象进钉住集(不复制,原地晋升)。
2. **精确根枚举**:数据段扫描循环(mark→patch 变体)+ box 表 + RS 表 →
   可达 young 对象 BFS 复制到 to-space,旧块写 forwarding(§6);
   复制时按类型布局自修补新对象内部引用。
3. **钉住对象处理**:原地保留,其内部指向"被复制对象"的字段仍需修补
   (钉住≠其出边免修——按类型布局扫钉住对象一遍)。
4. **晋升语义**:复制即晋升(to-space 归 old);现 sticky 位图晋升
   (`_gc_sweep_young` `:2241`)在试点区停用,位图"存活=已标"语义需重新定义
   (半空间内复制后新址置位、旧址清位)。

### 7.3 记忆集 / box 登记适配

- **RS**:条目是 old 容器裸指针。容器**内容**(props value 槽/数组元素/Map 节点)
  可能持 young 引用——复制阶段扫 RS 容器内容、重装箱/改写 young 新址(⑤)。
  容器本身在 old、不移动 → 条目地址免修。亦可选"每轮 minor 后丢弃 RS 重建"
  (屏障重新捕获;首轮代价 = 一次性全量重扫 old 容器兜底漏边)。
- **box 表**:box(8B 块)若在 young 且被复制 → 表项改写新址;box[0] 内容
  (装箱值)随拷贝自修补。box 表是精确根,扫改安全。
- **RS 去重位图**:按旧堆偏移索引 → 复制后旧偏移失效,最简=每轮清空重建
  (`_rs_clear_dedup` `:2371` 已存在类似尾部清理)。

### 7.4 IC 槽 holder

holder 多为原型对象(长期存活 → old,minor 不动);holder 为 young 的罕见情形
由数据段扫改(§5 案 B-2)覆盖。`obj_shape` 静态免修(§6.2)。

---

## 8. 分阶段路线

> **总门禁**(每阶段强制,见 `BOOTSTRAP_RULES.md` §2/§3 与 `ROADMAP.md:217`):
> fixtures 不低于基线 + 五目标 gen2==gen3(arm64 自举冻结,
> memory:arm64-bootstrap-frozen)+ 自编译耗时 ±5% + 内存布局变更原子提交
> (§3 不变量 4,`BOOTSTRAP_RULES.md:63`)。
> **双 bootstrap 风险**(§1.5,`:42-48`):运行时发射器本身被编译器自举,
> 任何头语义/布局/产物体积改动都有"gen2 静默编空壳"的组合触发风险——
> **探针字节不变不构成安全证据**,每阶段必须全链回放;产物体积增长(新增 GC 代码)
> 可能把产物推过布局敏感雷位(memory:layout-position-nondeterminism、
> text-16mb-cliff),用 baseline 定点 + 增量二分协议护航。

### 阶段 0:RSS 止血(madvise 死页归还)—— 非移动

- **改动面**:
  1. 新增 madvise 系统调用(现无,`allocator.js:229-246` 仅 mmap/munmap):
     macOS `MADV_FREE`、Linux `MADV_DONTNEED`(Linux 立即归还、macOS 惰性);
  2. full sweep 已线性走全堆(`:3526` 起)→ 顺路记**页级存活区间**(每 64KB 页
     是否含活块);sweep 结束后对"全死页"批量 madvise;
  3. 与 span 模型协同:整 span 全死(class 已知、pagemap 可查)→ 下轮 sweep
     **整 span 跳过行走**(pagemap→class→footprint 直接越过),解决"sweep 读死页
     块头又把页触碰回来"的自抵消问题。
- **保守扫重触页评估**:mark/drain 只读**活块**内容与位图/startmap,不读死块;
  死页被 madvise 后只有"下轮 sweep 读块头"会重触 → 必须配合 span 级跳过才净赚。
  bump 重分配触碰死页 = 重新提交,语义无害。
- **门禁风险**:madvise 不改产物字节流 → gen2==gen3 天然安全;但 allocator.js
  新增发射代码增大产物 → §1.5 布局敏感,需定点二分。
- **回退**:`GC_NOMADVISE` env 开关(与既有 GC_DISABLE/THRESHOLD/FULLONLY/POISON
  同模式,`:579-586` 一带)。
- **预期收益**:自编译 live 445MB vs 高水位 4.03GB → 理论 RSS 降 60-80%
  (受存活散布上限制约:只要最高活块钉在堆尾,其之前的全死页才可归还;
  残留"钉顶"量即压实要解决的剩余)。

### 阶段 1:nursery 半空间(钉住版,§7)—— 只移动年轻代

- **改动面**:堆内 from/to 分区(§7.1-a)+ 复制器(按类型布局)+ forwarding
  协议(§6,对象头 @48 快路 + 位图判活兜底)+ 栈/寄存器钉住集 + 数据段/box/RS
  扫改(§7.2-7.3)。`_gc_collect_minor` 现行实现**并行保留**,env 切换
  (如 `GC_MINOR_COPY=1`)。
- **门禁风险**:minor 路径是热路径(每 256MB 一次),复制正确性错一个字段即毁堆;
  **复用 GC_SHADOW 机制**(`:558-577`,`:1936` 起)做正确性 oracle——影子模式
  两遍 mark 对照可直接验证"复制后对象图与原图同构"。§1.5 双 bootstrap:
  复制器/forwarding 是新发射代码大头,体积敏感,分段增量 + 每段全链回放。
- **回退**:env 退回 sticky minor(旧代码原样在)。
- **前置实测**(决定可行性):钉住集占比(§9-Q1)——若栈/寄存器直达对象占 young
  存活 >90%,本阶段收益不足,直接跳阶段 2。

### 阶段 2:精确根基础设施 —— 不改 GC 行为,只供元数据

- **改动面**:
  1. **栈映射**:GC 安全点(所有可触发 GC 的 call 点)帧描述符——哪些寄存器/
     栈槽是堆指针。与 IR 层/寄存器分配器专项强耦合(memory:gc-perf-diagnosis:
     无 IR 是硬缺口),可能需先落最小帧描述符(仅标注 `_alloc` call 点)。
  2. **数据段槽分类表**:IC 站点表(icg_site/ics_site 标签+槽宽,§3-③)、
     全局槽类型表。编译器发射期完全已知,纯追加数据段表。
- **门禁风险**:表落数据段 → 产物体积与 `_data_gc_end` 边界变化 → §1.5 敏感;
  表本身不参与 GC(本阶段不改行为),gen2==gen3 应自然保持,但须验证
  `_data_gc_end` 移动不改变根扫描覆盖(`:3339-3366` 的范围语义)。
- **回退**:编译期开关不发射表。

### 阶段 3:全堆压实 —— 基于精确根

- **改动面**:sliding compaction 或分代 evacuation 扩展到 old;full 修补
  (§5 案 B 全量);代码数据段 IC holder 扫改(数据段 RW,无写保护障碍);
  sweep 扫描面从"高水位"缩到"存活集 + forwarding 表";栈映射精确修补解锁
  解钉(§4 路线①完成)。
- **门禁风险**:头语义最终定型需第二次"原子布局变更"(第一次是 48→56B,
  `SHAPE_IC_DESIGN.md` 铁律 4);**arm64 自举冻结**(memory:arm64-bootstrap-frozen)
  与本阶段正面冲突——大概率需要用户决策解冻,或保持压实对 arm64 产物字节中性
  (发射代码变化难以字节中性,乐观度低)。
- **回退**:env 回非移动 mark-sweep(全链路保留)。

---

## 9. 开放问题清单

1. **Q1(阶段 1 前置实测)**:自编译场景 young 存活中"栈/寄存器直达对象"占比?
   设计 GC_POISON 式探针:minor 时统计栈/regs 可达 young 块数 vs 总 young 存活块数。
   占比决定钉住版收益上限。
2. **Q2**:产物体积预算:allocator.js 已是最大发射文件之一,复制器/forwarding/
   栈映射新增代码是否把 __text 推过布局敏感雷位(16MB __text 悬崖,
   memory:text-16mb-cliff)?需先测当前 __text 余量。
3. **Q3**:wasm32/wasi 路径:4GB 线性内存封顶、堆缩至 1GB(`allocator.js:297-305`),
   半空间 from/to 在 1GB 内如何切?或 wasm 目标永久豁免压实?
4. **Q4**:多 M 并发(M5/M6,linux-arm64 STW 扩展根扫描 `allocator.js:3371` 起、
   `_gc_scan_other_ms` `:3398` 起)与复制阶段的交互:复制要求更强的"世界已停"
   一致性,parked M 的 saved_sp 之外的寄存器状态如何纳入钉住集?
5. **Q5**:route B 引擎(`engine/`,运行时编译执行):RX 片段页不可写已以
   `engineNoIC` 规避 IC 槽回写(`members.js:170-182`);全堆压实若需修补片段内
   引用(当前片段形态是否持堆引用需审计),要 mprotect RW→修补→RX 窗口。
6. **Q6**:堆动态字符串(运行期 concat 产物)体量:若显著,0x7FFC 装箱根是
   最大宗修补面;是否对字符串单独"不可变钉住"(永不移动)以彻底免修?
   代价=字符串死块无法压实归还(与阶段 0 madvise 部分抵消)。
7. **Q7**:标记位图/startmap 以"单连续堆偏移"为索引前提;阶段 1 堆内分区复用
   无碍,但若未来 old 也想 evacuation 到非连续区,位图索引域需重设计。
8. **Q8**:RS 去重位图(`:531-556`)按旧偏移索引,复制后清空的正确性证明
   (清位时机 vs 屏障竞争)需形式化;现行 `_rs_clear_dedup`(`:2371`)在
   `rs_top=0` 前调用的时序在复制协议下是否仍成立?
9. **Q9**:forwarding 与 GC_POISON(`:3580-3582`)死块毒填互斥:诊断模式与
   移动模式如何并存(诊断时关移动?)。
10. **Q10**:形状 IC v2(运行时 transition 链,`SHAPE_IC_DESIGN.md` §2 预留)
    与 @48 借用的交还时机:两个专项若并行,@48 语义冲突必须在设计评审层仲裁。
11. **Q11**:半空间复制使 bump 分配器从"单调 _heap_ptr"变"双区轮换",
    `_heap_ptr` 数据槽的多处直读站点(如 `_gc_is_heap_ptr` 范围判定
    `:3019-3021`、young 边界 `_gc_last_ptr` 语义 `:2317-2322`)需逐一审计。

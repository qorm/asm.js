# 形状驱动值类型化(支柱① v2)设计 — 属性算术解箱

> 日期:2026-07-23 · 状态:**设计评审稿(未动手)** · 上游:docs/SHAPE_TRANSITIONS_DESIGN.md(shape v2,T0/T2a 已落地)、docs/PERF_PLAN.md 支柱①、记忆 [[unboxing-int-residency-design]](P4.0/P4.1 已落地)
> 调研基础:2026-07-23 四域只读调研(算术分派 / 属性读值路 / 静态形状发射 / 解箱集成面)+ prop.js 定向采样,行号均已核实。
> 分支:arch/efficiency(门禁 = fixtures;自举定点回并 dev 时补)。
> ⚠️ 调研期遇 429 周配额耗尽(07-29 重置);形状扩展面/解箱集成两域由已回传数据 + 主循环直读补齐,未另起 agent。

---

## 1. 摘要与价值定位(诚实框架)

**必须先说清本设计不能解决什么。** prop.js(`o.a=o.b+o.c; s=s+o.a`,20M)实测 **jsbin 0.31s / node 0.03s = 10.3×**。定向采样(3513 叶样本)分解:

| 站点 | 叶采样 | 归属 | 本设计层级 |
|---|---|---|---|
| `_object_get_ic` | 18.8% | IC 读机制(×3 属性读) | **仅 L4 够得着** |
| `_js_add` | 18.4% | 算术分派(×2 加法) | **L0/L2 主攻** |
| `_ogic_getter_dispatch` | 16.6% | getter 尾跳落点(部分是调用边界假象,见 §1.1) | 不攻 |
| `_ogic_shaped` | 11.7% | IC 读形状路 | 仅 L4 |
| `_tag_key_a1` | 10.3% | 键自验证 cmp | 不攻(永久保留) |
| `_object_set_ic`+`_osic_*` | 12.3% | IC 写(o.a=) | 部分 L1 |
| `_gc_remember`+`_gc_rem_done` | **7.0%** | **写屏障(每轮 o.a 重写都登记)** | **L1 主攻** |
| `module_0_for_2` | 2.5% | 循环控制 | — |

### 1.1 三个诚实结论(重塑价值命题)

1. **主导成本不是算术分派(18.4%),而是 IC 读机制本身(~40%+:object_get_ic+ogic_shaped+tag_key+getter_dispatch)。** 值类型化(L0–L2)**够不着读路径**——读仍走 `bl _object_get_ic`。唯一攻读写机制的是 L4(静态偏移单 load),即支柱②领地、且是**已证伪的命中路径内联 POC 的同类**(那次零提速 + 产物 +144% 膨胀)。

2. **`_ogic_getter_dispatch` 16.6% 不可计为可攻成本。** T2b 已实测证伪:getter 检查短路 → method_bench 1.52s vs 1.51s、prop 0.28 vs 0.31,**零差异**。该叶采样是 bl/ret 调用边界的 PC 聚集假象,指令本身无成本。本设计**不把它算进收益**。

3. **低风险层(L0+L1+L2)的现实天花板 ≈ 消灭 _js_add(18%)+ 数值写屏障(7%)≈ 25% → prop.js 10.3× → ~7.5–8.2×。** 要再进一步必须动读机制(L3/L4),高风险、且 L4 有强失败先验。**本设计主张先吃满低风险层、用实测决定要不要碰 L3/L4,不预设全做。**

### 1.2 枢纽发现:一条近乎全程就位的休眠链路

调研的核心产出——编译器里**已存在一条完整的"静态 NUMBER 操作数 → 内联 fadd"端到端机器**,唯独缺一个"填充"步骤:

| 环节 | 现状 | file:line |
|---|---|---|
| 标量变量定型 | ✅ 已接通:`var s=0` → setVarType(s,NUMBER) | statements.js:309–318;context.js:144 |
| inferType(Identifier) | ✅ 查 getVarType | types.js:155–156 |
| **inferType(MemberExpression) 属性定型** | 🔴 **读取钩子存在但全编译器无写入点 → 恒空死代码** | **读:types.js:244–251;写:∅** |
| 两侧静态 NUMBER → 内联浮点算术 | ✅ 完整:emitNumberCoerceFast ×2 + fmov×2 + fadd,**零 _js_add** | operators.js:1093–1128 |
| 任一侧 UNKNOWN → `bl _js_add` | ✅(现状归宿) | operators.js:371–381 |

**即:`var o={a:0,b:1,c:2}` 的 `o.b+o.c` 之所以落 `bl _js_add`(18.4%),仅因 `ctx.varInitTypes` 从无写入点、属性类型推断整支休眠。** 接通填充(配闭世界单态门,§4 L0)即可让现有内联机器接管——**零新算术 codegen、纯编译器改动**。这是本专项风险最低、杠杆最直接的一刀。

---

## 2. 现状速览(已核实,带行号)

### 2.1 值表示:QuickJS 风格 NaN-boxing,判别全看 high16

(runtime/core/jsvalue.js)

| 形态 | high16 | 定义 |
|---|---|---|
| 装箱 int32 | `0x7FF8` | JS_TAG_INT32_BASE :55 |
| bool / null / undefined | `0x7FF9/7FFA/7FFB` | :56–58 |
| 装箱字符串 / 对象 / 数组 / 函数 | `0x7FFC/7FFD/7FFE/7FFF` | :59–62 |
| **裸 float64** | `<0x7FF8`(正)或 `≥0x8000`(负,符号位) | JS_VALUE_IS_FLOAT64 :102–107 |
| 裸堆指针(堆 Number/字符串) | `0`(data 段串 `0x1000/0x1001`) | coercion.js:1878–1882 |

**关键:数值 JSValue(裸 float64 或装箱 int 0x7FF8)的 high16 永不在堆指针值域(high16=0)——数值永非 young 堆指针。这是 L1 写屏障消除的 soundness 基石(§5)。** 别名坑:硬件 qNaN `0x7ff8…` 与装箱 int 0 按位同构(coercion.js:1949–1953),见 [[nan-int0-alias-trap]]。

### 2.2 属性存储:槽里就是裸 float64 位,写入零装箱

props 数组每槽 16B:key@0 + value@8(runtime/types/object/index.js:13,PROP_SIZE=16 :35)。

- **写(编译器)**:assignments.js:659 compileExpression(RHS)→ RET=裸值字;:665 `mov A2,RET`(原样,无装箱);:667 emitObjectSetIC → `bl _object_set_ic`。
- **写(运行时)**:_object_set_ic 快路 :1767 `store(V3, 8, A2)` 直写 value@8;慢路 :1827;_object_set_plain :2304。**number 落槽即裸 float64 位,全程无再装箱。**
- **读命中快路**:_object_get_ic(generateObjectGetIC :1371)零 prologue,形状自有键路:tag 守卫 :1378 → type :1386 → 形状比较 :1414 → holder==0 :1417 → 槽址 :1421 → 键自验证 :1425 → **取值 :1428 `load(RET, V0, 8)` = 裸槽字**。getter 分派 :1443–1457 只查 high16:**数值 → 1 cmp 后 :1448 直 ret,无再装箱/标签处理**;仅 high16=0 裸堆指针才尾跳 `_maybe_getter`。

**⟹ 数值属性读本身已吐裸 float64 位;成本在读之后(_js_add)与写屏障,不在读。**

### 2.3 `_js_add`:唯一带运行时分派的算术符

`_js_sub/_js_mul/_js_div/_js_mod` **不存在**(全仓 grep 空)——`- * / %` 恒内联 fsub/fmul/fdiv(operators.js:1112/1115/1118)。唯 `+` 因字符串拼接/加法双语义走运行时(runtime/core/coercion.js:683):

- prologue :687(帧 + stp S0/S1)——调用税。
- **快路 :691–712**:双侧各 6 条标签判别(`shrImm 48; cmp 0; andImm 0xfff8; cmp 0x7ff8` 排除 tag 区)→ 皆裸 double 则 fmovToFloat×2 + fadd + fmovToInt,**0 call**。
- **慢路 :714–881**:对象/数组 ToPrimitive、串判别、BigInt(`_is_bigint`×2)、指针整数;浮点路 :856–868 `_number_coerce`×2 + fadd。

**两 number 相加的三形态成本**(operators.js):
- **A. 两侧静态 NUMBER(内联路 :1093–1128)**:每操作数 slot load + emitNumberCoerceFast(正 double 7 条/0 call,:1285–1301)→ fmov×2 + fadd + fmov。**~20 条,0 call。**
- **B. 两侧 isIntExpression(:510–527)**:compileExpressionAsInt×2(裸 int 变量各 1 ldr)→ GP add → intToFloat64Bits。**~5 条,0 call,0 FP 运算**——当前已解箱最优形(支柱① P4.0)。
- **C. 任一侧 UNKNOWN(:371–381)→ bl _js_add**:1 call + 帧进出 + 12 条冗余标签判别(快路)或 4 次嵌套 call(装箱 int 慢路)。**这是"运行时是 number 但编译器静态不知"的全部税——形状驱动值类型化要跳过的就是它。**

### 2.4 写屏障:无条件登记

_object_set_ic 快路 :1767 直写 value 后 **:1768 无条件尾跳 `_gc_remember`(A0=容器)**;慢路 :1829 call。即**每轮属性写(哪怕写数值)都付屏障税**——prop.js 的 7% 来源。`_gc_remember` 精确语义(值条件 vs 容器整体登记)待 L1 POC 核验(§8 风险)。

### 2.5 形状系统(承接 shape v2)

- **静态描述符**:数据段 per-site(字面量,data_structures.js:447–456,`addDataQword(key_count)`)/per-class memo(类,expressions.js:938–953 `_classShapeSite`),内容仅 key_count;戳入 shape_ptr@48(字面量 :454 / 类实例 :1121,:1176)。
- **TYPE_SHAPE=15 转移节点**(48B):{parent@0,transitions@8,key@16,key_count@24,new_index@32,flags@40};flags@40 bit0 MEGAMORPHIC 保留(当前写 0,无 setter)。
- **TYPE_SHAPE_DESC=16 原型描述符**(16B):{@0 count|(accessor_free<<63), @8 keys_ptr}(statements.js:2774–2820 运行时建,戳入 :2819)。
- **转移表**:全局哈希,锚 `_shape_transition_root`,项 24B {from@0,key@8,to@16}。
- **置 0 站点**(键集变 → 形状失效):_object_delete :1938、_object_set 追加 :2401、setPrototypeOf :3753、整数键重排 :4392。**更新已有键不置 0**(键集不变)。
- **flags_ptr@40(对象头)**:纯 ES attrs(writable/enumerable/configurable,per-property 1B 惰性数组,index.js:25–41),**不携带值类型信息、已被 attrs 占用**——值类型化须挂 shape 侧,勿复用 flags。

---

## 3. 设计总纲:五层递进,低风险先行

值类型化的收益随"对运行时/表示的侵入深度"递增、风险同增。分五层,**每层独立可验收、独立提交,前层不预设后层必做**:

| 层 | 机制 | 侵入面 | 攻 prop.js 采样 | 风险 |
|---|---|---|---|---|
| **L0** | 编译期字面量属性定型,接通休眠 varInitTypes(配闭世界单态门) | 纯编译器 | _js_add 18.4% | **低**(soundness 靠门) |
| **L1** | 静态数值 RHS 写 → 跳过 _gc_remember 屏障 | 编译器 + set helper 变体 | 写屏障 7% | 低-中(屏障语义核验) |
| **L2** | 运行时形状承载 per-slot numeric 位掩码 + 存非数清位失效 | 运行时发射 + 形状 | L0 推广到动态对象/类实例 | 中 |
| **L3** | 表示特化:数值槽担保裸 float(Double fields),省 emitNumberCoerceFast 守卫 | 运行时表示 + 读路 | coerce 守卫残余 | 高(V8 deopt 对应物,本引擎无 deopt) |
| **L4** | 静态偏移单 load(shape guard + ldr),支柱②合流 | 编译器读路内联 | **读机制 ~40%** | **高**(命中路径内联 POC 已证伪:+144% 膨胀) |

**主张:L0→L1→L2 顺序吃满低风险层(现实天花板 prop.js ~7.5–8.2×),实测后再评审 L3/L4。**

---

## 4. L0:编译期字面量属性定型(枢纽,先做)

### 4.1 机制

在对象字面量绑定处(`var o = {a:0,b:1,c:2}`)填充休眠钩子:

```
ctx.varInitTypes["o"] = { properties: { a: NUMBER, b: NUMBER, c: NUMBER } }
```

填充点:VariableDeclarator init 为 ObjectExpression 且通过单态门(§4.2)时,按属性初值 inferType 记入(读侧 types.js:244–251、算术侧 operators.js:1093–1128 均已就位,**零新 codegen**)。`o.b+o.c` → 两侧 NUMBER → 内联 fadd,**绕过 bl _js_add**。

### 4.2 闭世界单态数值门(soundness 核心,不可省)

**裸接 varInitTypes 会错**:若 `o.b` 初值 number 后被赋字符串,陈旧 NUMBER 定型令 `"2"+1` 走数值加(得 3)而非字符串拼接(得 "21")——**本引擎无 deopt,静态定型必须保守可证**。门规则(结构同 L4 字符串拼接逃逸门 `_canIpStringAccum`,见 [[rope-string-attempt]] 的闭世界分析先例):

对每个候选对象变量 `o` 的每个属性 `p`,定型 NUMBER 当且仅当:
1. **初值数值**:`p` 的字面量初值 inferType ∈ {NUMBER, INT*, FLOAT*};
2. **写点全数值**:程序内所有 `o.p = E` 的 RHS inferType 皆数值(无字符串/对象/UNKNOWN 写);
3. **对象可追踪**:
   - `o` 未被以非成员方式逃逸(传参/返回/赋值给他变量/入数组)——逃逸则无法穷举写点,弃定型;
   - 无 `o[expr]`(计算键)写(无法静态对应到 p);
   - 无 `Object.assign(o,...)`/`delete o.p`/原型改写(键集/值域不可控);
4. **单一身份**:无跨变量别名指向同一对象的不同定型(保守:任一别名逃逸即弃)。

任一条不满足 → `p` 不定型(落 UNKNOWN → 现状 bl _js_add,正确)。门**宁漏勿错**。

**prop.js 过门核验**:`var o={a:0,b:1,c:2}` 局部;唯一写点 `o.a=o.b+o.c`(RHS 数值);o.b/o.c 不写;o 仅 `.a/.b/.c` 成员访问、不逃逸、无计算键。✓ 三门全过 → a/b/c 定 NUMBER。

### 4.3 预期收益与残余

- 消灭:`bl _js_add` 调用税 + prologue + 12 条标签判别(prop.js 18.4% 主体)。
- 残余:每操作数 emitNumberCoerceFast 7 条守卫(正 double 0 call,:1285–1301)仍在——读侧未变,读出来的裸位仍需过一遍"是否裸 double"内联守卫。**这部分要 L3(表示担保)才消。**
- 估算:prop.js _js_add 18.4% 大部分 → **10.3× → ~8.5×**(纯 L0)。

### 4.4 门禁

纯编译器改动,不动运行时发射 → 产物字节变化小(仅部分 `+` 站点从 `bl _js_add` 改内联序列,模块图不变)。arch/efficiency 门 = fixtures(380+)+ prop.js 复测 + x64 交叉。回并 dev 经定点迁移(plan.md S5)。

---

## 5. L1:数值写屏障消除

### 5.1 机制与 soundness

`o.a = <数值 RHS>` 时,编译器**按 RHS 静态类型**(非目标槽)决策:RHS inferType ∈ 数值族 → 发射 `_object_set_ic` 的无屏障变体(省 :1768 的 `_gc_remember` 尾跳)。

**Soundness 基石(§2.1):数值 JSValue(裸 float64 high16<0x7FF8/≥0x8000,或装箱 int 0x7FF8)永非 young 堆指针(high16=0)→ 写数值永不产生 old→young 指针边 → 屏障可省。** 此判据**逐写点、按 RHS**,与目标对象其它槽无关、与其它写点无关——某点写数值省屏障、另点写字符串照常屏障,互不干扰。

### 5.2 待核验(POC 前置)

`_gc_remember` 精确语义:是"值条件登记"(查 A0/写入值是否 young 指针)还是"容器整体登记"(把容器无条件入 remember-set)?
- 若**值条件**:省屏障对数值写天然安全,L1 即纯编译期路由。
- 若**容器整体登记**:省之需担保该容器无数值之外的 young 指针写——退化为"容器形状全数值槽"的更强门(与 L2 形状位掩码合流)。
POC 第一步即反汇编 `_gc_remember` 定此,再定 L1 形态。

### 5.3 收益

prop.js 写屏障 7%。与 L0 叠加:10.3× → ~8.0×。

---

## 6. L2:运行时形状承载数值类型(推广到动态世界)

### 6.1 动机

L0 只覆盖编译期字面量可定型者。动态构建对象、类实例(`this.x=<number>` ctor 赋值)的属性类型编译期不可知——需**运行时**在形状上记录"哪些槽单态数值",IC 读/算术据此走快路。这是"形状驱动"的字面含义,V8 Map field-representation 的本引擎对应物。

### 6.2 承载面(§2.5 基础上推荐)

给每个形状关联一个 **numeric-slot 位掩码**(≤64 槽单 qword,bit i=1 ⇒ 槽 i 单态数值)。挂法权衡:

| 方案 | 优 | 劣 |
|---|---|---|
| (a) TYPE_SHAPE_DESC 加第三 qword | 原型描述符天然带键序,位掩码对齐 index | 仅覆盖原型形状,字面量静态描述符(单 qword)需另处理 |
| (b) **数据段平行表,按 shape 指针键**(仿 `_shape_transition_root` 锚槽) | 静态/动态两世界统一;不改动描述符本体(数据段直存最省 GC 误判面) | 多一次查表 |
| (c) 转移节点 flags@40 扩位 | 复用已有字段 | 仅 1 qword,位宽受限;静态描述符无此字段 |
| (d) 对象头 flags_ptr@40 | — | **已被 attrs 占用(§2.5),否决** |

**推荐 (b)**:数据段锚槽平行表(仿 shape v2 转移表的成功模式),静态描述符与堆转移节点/TYPE_SHAPE_DESC 一律按 shape 指针查同一表;锚槽自动被数据段根扫描覆盖(存活性零改,§7)。

### 6.3 失效语义(承 shape v2 哲学)

- **存非数值 → 清位**:任一写点向槽 i 存非数值(字符串/对象/装箱非数)→ 清该形状 bit i(形状级,天然跨同形状对象共享),并失效键于该形状的相关 IC 站点(保守:置站点 obj_shape=0 令其 miss 回填)。这是 v1/v2 "键变 → shape_ptr=0" 的**值域版**:从"键集单态"细化到"值类型单态"。
- **delete/setPrototypeOf/整数键重排**:维持整体置 0(§2.5),不细分。
- **megamorphic 退化**:单形状清位次数超阈 → 标 MEGAMORPHIC(flags@40 bit0,已保留)→ 该形状后续永不定型。

### 6.4 与 L0 关系

L0 是 L2 的编译期特例(字面量 = 编译期已知全数值,无需运行时记录)。L2 落地后,L0 的门可放宽(运行时清位兜底),但**首期保持 L0 独立**(纯编译器、低风险),L2 另立施工。

---

## 7. GC 交互

**现有保守 GC 对 L0–L2 零改即安全:**
- L0/L1 纯编译器/写路,不改槽内容形态(数值仍裸 float64 位存槽,保守扫描面不变)。
- L1 省屏障 soundness 见 §5.1(数值非 young 指针)。
- L2 位掩码表挂数据段锚槽(§6.2b),自动被数据段根扫描覆盖;形状堆实体存活性承 shape v2 已证安全(SHAPE_TRANSITIONS_DESIGN §4)。
- **L3 协同(远期)**:数值槽担保裸 float ⇒ 该槽**无需保守扫描**(永非指针)——这是精确 GC(支柱⑤)的前置,但 L3 本身高风险,不在近期。

**铁律沿用**:L2 运行时 helper 调 `_alloc` 可触发 GC → 遵守 runtime-helper-reg-contracts(只存 S0–S4、跨 _alloc 活值存 S 寄存器、_alloc 后中间值用 V2+ 避 V0=RET 别名,见 SHAPE_TRANSITIONS_DESIGN §7.5 x64 实证坑)。

---

## 8. 风险登记

| 风险 | 层 | 等级 | 对策 |
|---|---|---|---|
| **陈旧定型致字符串拼接误算数值加**(`o.b="str"` 后 `o.b+1`) | L0 | **高** | 闭世界单态门(§4.2)宁漏勿错;无 deopt 故必须保守可证;新增 fixture 簇:属性改型后 `+` 语义(字符串拼接 vs 数值加)双分支 |
| `_gc_remember` 语义误判 → 省屏障致 minor UAF | L1 | 高 | POC 先反汇编定语义(§5.2);GC_POISON/GC_SHADOW 跑数值写密集负载;存疑则退容器级门 |
| nan-int0 别名:裸 float 守卫与装箱 int 双语义分裂 | L0/L3 | 高 | 沿用 emitNumberCoerceFast 已验证判据([0x7FF8,0x8000)+堆范围);守卫须双语义,见 [[nan-int0-alias-trap]] |
| L2 清位失效与 IC 站点不同步 → 假命中读错值 | L2 | 高 | 清位同步失效相关 IC 站点(置 obj_shape=0);键自验证**永久保留**作兜底(承 shape v2) |
| **L4 膨胀重演**(命中路径内联 POC 已证 +144%) | L4 | 高 | L4 须"极简单态序列"(guard+ldr+fadd,~4 条/站点,**非**全 IC 镜像)且 POC 重测膨胀,超 +54% 铁案红线即弃 |
| varInitTypes 跨模块/跨函数同名变量误配 | L0 | 中 | 定型按 ctx 作用域(函数级 varInitTypes),非全局;承 `_shapeClsMemo` 误配教训(记忆 builtin-prototype-singleton) |
| L0 门过严 → 收益不及预期 | L0 | 中 | 实测 prop.js + 自编译热图 _js_add 占比;门宽严用数据调,不为覆盖率牺牲 soundness |
| 自举布局位移(编译器 codegen 变 → 产物字节变) | 全部 | 中 | arch/efficiency 无定点约束;回并 dev 经定点迁移 + 增量二分诊断(layout-position-nondeterminism) |

---

## 9. 阶段与门禁

| 阶段 | 内容 | 验收 |
|---|---|---|
| **L0-POC** | 反汇编确认 emitNumberCoerceFast 对字面量对象的实际发射;手填 varInitTypes 验证 prop.js 走内联路 | prop.js 采样 _js_add 占比显著下降;时序收窄 |
| **L0** | 闭世界单态门 + varInitTypes 自动填充 | fixtures 380+ 全绿(新增属性改型 `+` 语义簇);prop.js 10.3× → 实测;arm64+x64 |
| **L1** | `_gc_remember` 语义核验 → 数值写无屏障变体 | GC_POISON 数值写负载无 UAF;prop.js 复测;fixtures 全绿 |
| **L2** | 形状 numeric 位掩码(数据段平行表)+ 存非数清位 + IC 失效 | 动态对象/类实例数值属性微基准;fixture 簇(同形状共享/清位失效/megamorphic);GC RSS 对照 |
| L3/L4 | 表示特化 / 静态偏移 load | **另行评审**,依 L0–L2 实测与膨胀 POC 定去留 |

每阶段独立提交(英文 message)、增量参数化、fixtures 只增不减、test262 不降。

## 10. 成功指标

- **prop.js**:10.3× → L0 ~8.5× → L0+L1 ~8.0× → (+L2 推广面,非 prop.js 本身);
- **prop.js 采样**:_js_add 18.4% → L0 后 <5%;写屏障 7% → L1 后 <2%;
- **自编译热图**:_js_add 占比同步下降(自编译大量属性算术);
- fixtures/test262 只增不减;GC RSS 数值负载无显著抬升。

## 11. 开放问题

1. L0 门宽严:对象"可追踪"的逃逸判定粒度(传参即弃 vs 分析被调函数是否改其属性)——首期保守(传参即弃),数据驱动放宽。
2. varInitTypes 是否升级为作用域级 Map(支持嵌套函数内字面量),首期仅顶层/函数级 var 声明。
3. L1 `_gc_remember` 语义定 L1 形态(值条件 ⇒ 纯编译期;容器级 ⇒ 与 L2 合流)。
4. L2 位掩码 ≤64 槽限制:超大对象(>64 键)退化不定型(保守正确),是否值当扩多 qword——实测大对象数值热点后定。
5. L3 表示特化无 deopt 的实现路径(本引擎无 V8 式 deopt):是否只能靠"编译期闭世界担保 + 运行时清位即失效整站"的保守组合——这是 L3 高风险的根源,需独立设计。
6. 与 engine route B(eval/new Function):运行时编译片段无编译期定型,只享受 L2 运行时形状定型——验证 RX 片段读数值槽路径。

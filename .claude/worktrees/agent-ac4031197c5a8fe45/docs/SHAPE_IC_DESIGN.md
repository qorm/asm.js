# 形状(隐藏类)IC 专项设计 — A 方案落地版

> 日期:2026-07-19 · 状态:已过方向评审(维护者选定直接上 A)· 上游:`docs/PROP_ACCESS_IC_DESIGN.md`(差距分解与 B→A 路线)
> 铁律:fixtures 不降;macos-arm64 全链 gen1==gen2==gen3;增量参数化;
> **铁律 4(内存布局原子性)是本专项主战场——对象头 48→56B 的变更必须单次提交同步全部遍历站点。**

---

## 1. 核心洞察(asm.js 特有优势)

key 全局驻留(编译期 `addString` 同字面量同地址,P0)+ AOT 静态世界 ⟹
**对象形状在编译期大多已知**:对象字面量、类实例的键序列是静态的。
⟹ 形状可以表达为**编译期数据段静态描述符**,创建时一次赋值;
无需运行时 shape 注册表 / transition 链(V8 必需的运行时机体的绝大部分可省)。

覆盖验证:编译器自身(AST 节点、context、label 表、模块表)与用户程序的
class 实例/字面量,创建后极少再加键——正是 IC 收益面;动态字典(JSON/Map 化对象)
保持旧路径不受影响。

## 2. 形状模型(v1,静态定型)

**shape 描述符(数据段静态记录)**:`{ key_count, key_0..key_n }`(key 为驻留字符串指针)。
- 字面量:按声明键序(计算键除外,见 §4 排除项)编译期发射 `__shape_lit_<id>`。
- 类实例:按字段声明序发射 `__shape_cls_<classId>`(字段初始化列表,继承链按下展平)。
- 空对象:`__shape_empty`(0 键)。

**对象头:48B → 56B**,新增 `shape_ptr@56-8=+48`(0 = 无形状,走旧路径)。
- 创建时赋值(字面量/类/空对象);`_object_set`/`_object_defineProperty`/`delete`
  **加键/删键/改键站点一律 shape_ptr 置 0**(退化为无形状,安全退化,无需重建)。
- v1 不做运行时 shape 注册/transition 链/重定型——动态加键对象永远无形状,
  走与今天完全相同的指针扫路径(零回归风险)。v2 再评 transition 收益。

## 3. IC 站点改造(命中路径 ~6 指令)

站点槽 8B → 16B:`{ shape_ptr, index }`。
`_object_get_ic` 快路重排:

```
tag==0x7FFD → 脱壳 → type==TYPE_OBJECT → load shape_ptr@48
  → cmp 缓存 shape_ptr(不等 → 慢路/重学习)
  → 按缓存 index 直接取 props[idx].value → getter 判定 → ret
```

- shape cmp 相等 ⇒ 键序列静态相等 ⇒ **键自验证可省**(V8 同构);为稳妥 v1 保留单 cmp
  (编译期开关,测量后可去)。
- 写路径 `_object_set` 同形:站点缓存 (shape_ptr, index) 直接命中写槽;
  命中非新增键,不触发 grow/shape 失效。
- 多态站点:单槽 (shape,index) 互踢,慢路径照旧;v2 评双路。

## 4. 排除与降级(保正确性优先)

- 计算键字面量(`{[k]:1}`)、含 getter/setter 声明的字面量、spread:不赋形状(置 0)。
- `Object.defineProperty`/delete/Proxy/JSON.parse 产物:置 0 或天然无形状。
- `__proto__` 赋值/`Object.assign`:目标对象 shape 置 0(键序列可能改变)。
- 原型链查找不受影响:shape 只管自有属性,原型链继续走旧路径。

## 5. 铁律 4 原子提交清单(头 48→56B 的全部遍历/初始化站点)

| 站点 | 位置 | 动作 |
|---|---|---|
| `_object_new` | runtime/types/object/index.js:271+ | 头分配 56B,shape_ptr=__shape_empty 或 0 |
| `_object_new_sized`/类实例创建 | compiler 手写头站点(5 处,BOOTSTRAP §4 C 组清单) | 同步 56B + 赋类 shape |
| `compileObjectExpression` | compiler/expressions/ | 字面量创建后赋字面量 shape(计算键/getter/spread 置 0) |
| clone 路径(Object.assign/structuredClone) | runtime | 拷贝 shape_ptr 或置 0(键序变则 0) |
| `_object_set`/`_object_defineProperty`/`_object_delete` | runtime/types/object/index.js | 改键时 shape_ptr=0 |
| GC 遍历 | runtime/core/allocator.js | shape_ptr 在 +48,保守扫自然覆盖(数据段指针非堆,不追踪,零代价) |
| print/inspect | runtime/core/print.js | 头尺寸变化同步 |
| `engine/`(L2 eval 对象读写) | engine/ | 同步头尺寸 |

一次性原子提交;提交前全链 gen1==gen2==gen3 + fixtures + test262 三门禁。

## 6. 阶段与门禁

| 阶段 | 内容 | 验收 |
|---|---|---|
| A1 | 头 48→56B + `__shape_empty` 赋值(全置 0 语义,IC 未启用) | 门禁全绿(纯布局变更,行为等价) |
| A2 | 字面量/类静态 shape 赋值 + `_object_get_ic` 16B 站点快路 | bench/prop ≤7×;门禁全绿 |
| A3 | `_object_set` 写路径同形 + 键自验证消除测量 | bench/prop ≤5×;自编译 ≤15s;门禁全绿 |
| A4(选) | 双槽多态站点 / transition 评估 | 另行评审 |

每阶段独立提交,增量参数化,坏窗口定点复测记录(plan.md 风险#1 悬崖纪律)。

## 7. 风险登记

| 风险 | 等级 | 对策 |
|---|---|---|
| 头布局变更漏站(GC/克隆/打印读旧布局) | 高 | §5 清单逐站点核对;全链定点 + fixtures + test262 + gen0 repro 矩阵;一次原子提交 |
| 形状误赋(键序与描述符不符 → 错取属性) | 高 | 赋值点静态可证(字面量/类声明);动态路径恒置 0;v1 保留键自验证单 cmp |
| 类继承字段顺序(父类字段 vs 子类) | 中 | 展平规则与现有字段初始化顺序严格一致;fixture 覆盖 |
| flags_ptr@40 与 shape 交互(属性 attrs 与键序) | 中 | attrs 变更站点同置 0;A1 纯布局阶段先验证 |

## 8. 成功指标

bench/prop ~13× → A2 ≤7×、A3 ≤5×;自编译 25.5s → ≤15s(A3);
bench/num 1.6× 不退;test262 数字只升;CHANGELOG 记录墙钟。

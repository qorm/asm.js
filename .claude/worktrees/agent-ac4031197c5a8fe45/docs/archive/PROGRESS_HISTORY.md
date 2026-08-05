> **[归档 2026-07-16]** 本文件是 2026-01 → 2026-07-12(≈v1.4.x)期间的开发进展日志,此后不再更新;
> v1.5.13 起的版本级记录见 [CHANGELOG.md](../../CHANGELOG.md)。保留仅供回溯。

# JSBin JavaScript 编译器

> 命名说明:"jsbin/JSBin" 是暂定的内部代号,非最终产品名;对外发布前会另定正式名称,文中所有 "jsbin" 均按此理解。

## 里程碑 v1.1.0 —— 五目标自举（2026-07-09)

自举定点扩展到**全部五个目标**:macOS-ARM64/x64、Linux-ARM64/x64、Windows-x64,每个目标 `gen2 == gen3` 逐字节一致(尺寸表见 README)。攻克 x64 调用约定别名、x64 label 分类阈值、PE IAT 布局、path 分隔符、Windows argv 等一批"只有 11MB 级自编译才暴露"的后端 bug。Release CI(打 tag 自动交叉编译 5 目标 + 发布)已跑通。

### 里程碑 v1.0.0 —— 循环自举达成（2026-07-08）

JSBin 实现**循环自举**：编译器把自身源码编译成原生二进制，该二进制再编译整个编译器，产物与上一代**逐字节一致**——稳定的自我复现定点。无三方依赖、运行时不调外部解释器。
- 本轮攻克：内存墙 28GB(OOM)→4.3GB（实现保守式 mark-sweep GC）、全部运行期崩溃清零、9 处跨代 codegen 分歧修复。

### v1.4.4 完整 ES 核验(含 ES2025,2026-07-12)

分层对拍 node v24(ES2025)。ES 版本符合度:ES5/ES2015 ~90%、ES2016-20 ~55%、ES2021-23 ~90%、ES2024 ~25%、ES2025 ~5%。
白名单外缺陷(第五修复波目标):
- #69 ES5 函数构造器 `new F(){this.a=..}` 崩(this=NULL,_object_set NULL);class 版正常。CRITICAL。
- ~~#70 `0 ?? x`/`0 ??= ` 误判 0 为 nullish~~(已修 2026-07-12:null 发射裸 0 与数值 0.0 同位,运行时不可分辨 → 走**编译期类型判别**(路线 B,不改 null 表示):`??`/`??=` 左值经 inferType 判为数值类型(NUMBER/int/float 子类)时绝不 nullish,跳过裸-0 空值判定直返左值;非数值/未知类型仍走运行时裸-0=null 兜底保 `null ?? x`。定点 17,186,832 两链、fixtures 77/122、gcstress/x64 全绿。残留:member/call/嵌套?? 等运行时未知类型返回数值 0 的位点仍不可分辨(inferType=UNKNOWN),属路线 B 固有边界。)
- #71 `bigint.toString()` → "0."(方法未分派落数字路径;算术/String/模板本身正确)。HIGH。
- #72 `a?.[i]` 可选链计算下标 COMPILE_FAIL。HIGH。
- #73 混杂:Object.entries→0、Promise.all∘async→0、Array.prototype.with 中止、defineProperty 访问器 setter 忽略(getter 正常)。MED。
- #74 Promise 微任务未延迟(.then 即时同步执行);函数体内 TDZ 未强制。MED/LOW。
功能缺口(ES2024/25 未实现,成熟度差距非 bug):Promise.withResolvers、Iterator helpers、Promise.try。(~~Set 方法 union/intersection/…~~、~~Object.groupBy/Map.groupBy/RegExp.escape~~ 已实现,见下)
最高优先静默错值:~~#70(0??x)已修~~、#71(bigint.toString);硬失败:#69、#72。

**[已落地] ES2024/ES2025 内建三件:Object.groupBy / Map.groupBy / RegExp.escape(2026-07-12)**:
- **交付**:`Object.groupBy(items,cb)`→ `{key:[元素...]}`(普通对象,键经通用值→字符串)、`Map.groupBy(items,cb)`→ `Map{key=>[元素...]}`(键保回调原值,SameValueZero)、`RegExp.escape(str)`(ES2025,转义正则元字符)。
- **实现**:
  - `runtime/types/object/index.js` 追加 `_groupby_invoke2`(共用回调蹦床,以 (元素,索引) 调装箱闭包/async 闭包/裸函数指针)+ `_object_groupBy`(遍历数组、`_valueToStr` 键→装箱串、按键 `_object_get`/`_object_new` 分组,结果装箱对象 0x7ffd、值装箱数组 0x7ffe;用 `_object_new` 非 JS `{}` 字典免 [#32] 污染)。
  - `runtime/types/map/index.js` 追加 `_map_groupBy`(同上但结果裸 Map,键为回调原值;命中判 `_map_get` 返 0x7ffe 数组 tag,**不用 `_map_has`**——它返装箱布尔 _js_true/_js_false 均非 0)。x64 死表:`shrImm` 取 high16 用 V3(≠RET),先落栈 RET。
  - `runtime/node/__regexp_shim.js` 追加纯 JS shim `__RE_escape`(gen1-safe:仅 charCodeAt/charAt/字符串拼接/整数算术,无位运算/正则);语义对齐 Node 24:首字符 ASCII 字母/数字 → `\xHH`、语法字符前加 `\`、`\t\n\v\f\r` 控制转义、一批标点/空白 → `\xHH`。
  - 分派:`compiler/functions/functions.js` 加 `Object.groupBy`/`Map.groupBy`/`RegExp.escape`(escape 改写为 `__RE_escape(...)` 调用);`compiler/index.js` `readModuleSource` 源码含 "RegExp.escape" 文本时注入 shim import(路线同 `new RegExp`)。
- **推迟(不在本批)**:`Promise.withResolvers` / `Promise.try` —— 二者需改 `runtime/async/promise.js`,与刚落地的 #74 微任务重构冲突,需单独手工并,故本批未纳入。
- **门禁(全绿)**:① 行为——`Object.groupBy`/`RegExp.escape` 与 node v24 逐字节对拍**完全一致**;`Map.groupBy` 分组结果一致(用 `.get(k)` 探测,`new RegExp(RegExp.escape(s))` 反验匹配)。唯一偏差:Map 对象键身份判定(结构而非引用),纯 `new Map()` 已复现,**非本批引入**。② 自举定点——`gen2==gen3` **逐字节一致 17,514,512 字节**,`__text`=0x1038818(17,008,152 B ≈16.2 MB,悬崖已修故 >16M 无碍),gen2 编译并运行样例正常。③ fixtures 零回归——PASS=79/FAIL=45/TOTAL=124,与 base(1cf7c4ef 无改动)失败集**逐项 diff 完全一致**。

**[已落地] ES2025 Set 集合方法(7 组合子,2026-07-12)**:
- **交付**:`Set.prototype` 的 `union`/`intersection`/`difference`/`symmetricDifference`(返回新 Set)+ `isSubsetOf`/`isSupersetOf`/`isDisjointFrom`(返回布尔单例)。**仅 Set,刻意排除 iterator helpers**(take/drop/toArray/`ITERATOR_HELPER_METHODS`/生成器结果 map/filter 重路由——前几轮曾因此撞坏编译器自身 arr.map/filter 致自举崩)。
- **实现**:`runtime/types/set/index.js` 追加 238 行原生组合子(label `_set_union/_set_intersection/_set_difference/_set_symdiff/_set_issubset/_set_issuperset/_set_isdisjoint`),复用既有 `_set_new/_set_add/_set_has`,入口用 `0x0000ffff..` 掩码脱壳(boxed/裸指针幺等),布尔返 `_js_true/_js_false` 单例。寄存器保活:游标放 S3(穿越 `_set_add` 存/`_set_has` 不碰),布尔版游标 S2(`_set_has` 保存 S0..S2)。分派:`compiler/functions/functions.js` 的 `HOISTED_SET_METHODS` 加 7 名 + `compiler/functions/builtin_methods.js:compileSetMethod` 加 `case`(`a.<op>(b)`→A0=a A1=b)。
- **门禁(全绿)**:① 行为——与 node v24 逐例对拍**完全一致**(空集/自身/重叠/不相交/子集/超集/不交,用 `.has()`+`.size` 探测,规避既有 `Array.from(set)`/`set.forEach` 打印缺陷)。② 自举定点——`gen2==gen3` **逐字节一致 17,416,208 字节**,`__text`=0x010214e0(16,913,632 B ≈16.13 MB,悬崖已修故 >16M 无碍),gen2 编译并运行 Set 组合子样例正常。③ fixtures 零回归——本改动 PASS=79/FAIL=45/TOTAL=124,与 base(3fa394fe 无改动)失败集**逐项 diff 完全一致**。

**[已修] 全局 `isNaN`/`isFinite`(2026-07-12,v1.4.10 后,ES_CONFORMANCE_REPORT §三 项)**:
- **现象**:全局 `isNaN(x)`/`isFinite(x)` 返 `[object Object]`/`0.` 垃圾(裸函数调用未接线;`Number.isNaN`/`isFinite` 方法可用)。
- **修**:`compiler/functions/functions.js` 全局函数分派(parseInt/parseFloat 旁)加 `isNaN`/`isFinite`:`_number_coerce`(ToNumber,区别于 Number.isNaN 不 coerce)→ 按位型判定(指数全 1 + 尾数非 0 = NaN、尾数 0 = ±Inf)。
- **发现**:位型 NaN 检测对 **coerce/计算 NaN 亦有效**(int0-alias 只伤 `===` 的全位比较,不伤指数+尾数的位型检测)——`isNaN("abc")`→true 成立。
- **门禁**:isNaN(NaN/1/"abc"/"123"/Infinity)、isFinite(1/NaN/Infinity/"42") 9 情形与 node 一致;fixture `global-isnan`;**自举定点 gen2==gen3 逐字节 17,825,808**;fixtures 95/40 零回归。

**[已修] WeakMap/WeakSet 运行时崩(2026-07-12,v1.4.10 后,ES_CONFORMANCE_REPORT §三 项)**:
- **现象**:`new WeakMap()`/`new WeakSet()` 编译通过但运行崩(退出 1)——编译器零处理,落用户类 new 路径找不到类。
- **修**:`compileNewExpression` switch 加 `case "WeakMap"` fall-through 到 `case "Map"`、`case "WeakSet"` 到 `case "Set"`(产物是真 Map/Set);`inferType` 的 NewExpression 同加 WeakMap→MAP/WeakSet→SET(否则 `.set` 类型 UNKNOWN 不分派)。基础操作 set/get/has/delete/add 复用 Map/Set 运行时。
- **门禁**:`wm.set/get/has/delete`、`ws.add/has`、`has({})` 返 false 与 node 一致;fixture `weakmap-weakset`;**自举定点 gen2==gen3 逐字节 17,809,424**;fixtures 94/40 零回归。偏差:不实际弱引用(键强持有)、对象键沿用 Map 判定、WeakRef/FinalizationRegistry 未支持。

**[已落地] `#x in obj` 私有字段存在性检查(ES2022,2026-07-12,v1.4.10 后,ES_CONFORMANCE_REPORT §三 项)**:
- **现象**:`#x in o` 编译通过但恒返 false(私有字段/方法 brand check 未生效)。
- **根因**:表达式位的 `#x` 被 parser 解析为 **Identifier**(name="#x")而非 PrivateIdentifier;`in` 运算符 codegen 对该 LHS 走普通键路径(`_js_prop_key` 归一),键不是私有字段的存储键 `"#ClassName#x"` → `_prop_in` 找不到。
- **修**:`compiler/expressions/operators.js` 的 `in` 分支:LHS 是 PrivateIdentifier **或 name 以 `#` 起的 Identifier** 时,用 `manglePrivateName(name)`→`"#ClassName#x"`(与 `this.#x` 访问端同一存储键)`emitBoxedStringKey`→`_getStrContent`→`_prop_in`。
- **门禁**:私有字段/私有方法、static/实例方法内、`{}` 无字段返 false 与 node 一致;regular `in`(`"a" in {a:1}`/`0 in [5]`)回归不变;fixture `private-in`;**自举定点 gen2==gen3 逐字节 17,809,424**;fixtures 93/40 零回归。

**[已落地] `Array.prototype.toSpliced`(ES2023,2026-07-12,v1.4.9 后)**:
- **实现**:splice 收官后顺手补——非破坏 splice。运行时 `_array_toSpliced(A0=boxed arr,A1=start,A2=del,A3=items)`:`_array_slice(arr,0,-1)` 全拷贝副本 → 对副本 `_array_splice` → 返回**副本**(非 removed);原数组不变。`toSpliced` 入 HOISTED_ARRAY_METHODS/ONLY_METHODS + 活跃 switch case(参数处理同 splice)。
- **门禁**:替换/纯插/省略 delCount/负 start 与 node 一致且原数组不变;fixture `array-tospliced`;**自举定点 gen2==gen3 逐字节 17,809,424**;fixtures 92/40 零回归。

**[已修] `Array.prototype.splice`(2026-07-12,v1.4.9 后,数组变异簇专项第三刀——簇收官)**:
- **现象**:`arr.splice(...)` 数组不变、返整个数组(活跃 `compileArrayMethod` 无 case → default no-op)。
- **修**:`runtime/types/array/index.js` 加 live `_array_splice(A0=boxed arr, A1=start, A2=delCount, A3=boxed itemsArr)→removed`:① 规范化 start(负+len、钳[0,len])/delCount(钳[0,len-start]);② `removed=_array_slice(arr,start,start+del)`;③ `_array_ensure_cap(newLen=len-del+itemsLen)`;④ 尾段 [start+del,len)→[start+itemsLen,…) **双向移位**(itemsLen≥del 从高到低防覆盖、否则从低到高);⑤ 拷 items 入 [start,start+itemsLen);⑥ length=newLen。持久值 S0-S4、len/itemsLen/data_ptr 按需 reload。compiler 侧活跃 switch 加 `case "splice"`:start/delCount 编 int(省略 delCount → 0x7fffffff sentinel 运行时钳)、`...items` 编成 ArrayExpression 数组(真 arg 节点作 elements,gen2 安全)传 A3。
- **门禁**:替换增长(`splice(1,2,9,8)`)/纯删/纯插/省略 delCount/负 start/delCount 超长钳 六情形与 node 一致;fixture `array-splice`;**自举定点 gen2==gen3 逐字节 17,793,040**;fixtures 91/40 零回归。**数组变异簇 shift/unshift/splice 三刀全收官。**

**[已修] `Array.prototype.unshift`(2026-07-12,v1.4.9 后,数组变异簇专项第二刀)**:
- **现象**:`a.unshift(x)` 返 `[object Object]`、数组不变(应前插并返新长度)。同 shift 的双层死代码根因。
- **修**:`runtime/types/array/index.js` 加 live `_array_unshift`(`_array_ensure_cap` 原地扩容——头指针稳定、data_ptr@24 更新、**无需 caller 写回**;元素从尾到头右移一位;`data[0]=value`;length++ @8;返回新长度**裸 int→double 装箱** `scvtf(0,len); fmovToInt(RET,0)`——jsbin 数字是裸 IEEE double)+ 接 generate();活跃 `compileArrayMethod` switch 加 `case "unshift"`(编 value→A1、arr→A0、call;结果=新长度)。
- **门禁**:`unshift` 返新长度/连续前插/空数组/触发扩容(6 次 unshift)与 node 一致;fixture `array-unshift`;**自举定点 gen2==gen3 逐字节 17,727,504**;fixtures 90/40 零回归。偏差:多参 `unshift(a,b)` 退化只插首个(记偏差);`splice` 仍待(变长)。

**[已修] `Array.prototype.shift`(2026-07-12,v1.4.9 后,数组变异簇专项第一刀)**:
- **现象**:`a.shift()` 返回接收者数组本身、数组不变(应移除并返首元素);`[].shift()` 返 `[]`(应 undefined)。
- **根因(双层死代码)**:① `runtime/types/array/mutate.js` 的 `ArrayMutateMixin`(含 `_array_shift`)**零外部引用、未接 ArrayGenerator.generate()** → `_array_shift` label 从不生成;② `compiler/functions/builtin_array_basic.js`(含 shift dispatch)同为死代码,活跃的 `compiler/functions/builtin_methods.js:compileArrayMethod` 无 shift case → 落 `default:return false` no-op(返回接收者)。
- **修**:① `runtime/types/array/index.js` 加 live `_array_shift`(**live 布局** length@8/capacity@16/data_ptr@24,脱壳 `and 0x0000ffff..`、元素移位、length--、空数组返 `_js_undefined` 值 `lea`+`load` 非地址)+ 接入 generate();② 活跃 `compileArrayMethod` switch 加 `case "shift"`(接收者已在 RET → A0,call `_array_shift`)。
- **门禁**:`a.shift()`/连续 shift/空数组/字符串元素与 node 一致;fixture `array-shift`;**自举定点 gen2==gen3 逐字节 17,694,736**;fixtures 89/40 零回归。
- **同簇未修(专项续)**:`unshift`(需 `_array_ensure_cap` 扩容 + 返回新长度需装箱数字)、`splice`(变长,编译期 ...items 编数组传入)——见 memory:array-mutator-cluster-broken。

**[已修] Map for-of 迭代(2026-07-12,v1.4.8 后,ES_CONFORMANCE_REPORT §三 项)**:
- **现象**:`for (e of m)` / `for ([k,v] of m)`(m 为 Map)空迭代静默失败(Set 已特判、m.keys()/values() 可用)。
- **根因**:`compileForOfStatement` 的 Map 特判此前检测到 Map(type@0=4)直接跳 endLabel(避免通用 Symbol.iterator 路径把 Map 头当对象误读崩,记为"空迭代")。
- **修**:Map 特判改为调 `_map_entries(map)` 得 `[[k,v]...]` 真数组(插入序,m.entries() 同运行时),脱壳存 arrTemp、idx=0,跳数组快路 loopLabel——复用其 [k,v] 元素迭代 + storeLoopBinding(整体 `e` 或 `[k,v]` 解构均由循环体处理)。
- **门禁**:`for(e of m)`→a 1/b 2、`for([k,v] of m)`→a=1/b=2、`for([,v] of m)` 忽略键、m.keys()/values() 回归与 node 一致;fixture `map-for-of`;**自举定点 gen2==gen3 逐字节 17,661,968**;fixtures 88/40 零回归。

**[部分修] `NaN === NaN` 字面量(2026-07-12,v1.4.8 后,ES_CONFORMANCE_REPORT §三 项)**:
- **现象**:`NaN === NaN` → true(应 false)、`NaN !== NaN` → false(应 true)。
- **根因**:`_strict_eq`(coercion.js)位相等快路 `cmp; jeq _true` 对两个相同位的 NaN 判等返 true。`_abstract_eq`(`==`)早已对位相等 float 补 `fcmp` 自比较剔除 NaN,`_strict_eq` 缺此段。
- **修**:位相等后,tagged(high16≥0x7FF8)直返 true;float 走 `fmovToFloat`+`fcmp(0,0)` 自比较,NaN→false、非 NaN→true(镜像 `_abstract_eq`,双语义一致)。
- **门禁**:`NaN===NaN`→false、`NaN!==NaN`→true、`NaN==NaN`→false 与 node 一致;普通值 ===(int/string/null/bool/float/对象引用)全回归绿;fixture `nan-strict-eq`;**自举定点 gen2==gen3 逐字节 17,645,584(=== 是编译器关键路径,记忆警告区,实测无扰)**;fixtures 87/40 零回归。
- **残留偏差(表示层 int0-alias,须专项)**:计算 NaN `0/0`/`Math.sqrt(-1)` 位模式 0x7FF8000000000000 与装箱 int0 **同构**,`(0/0)===(0/0)` 仍 true、`Number.isNaN(computed)`/全局 `isNaN` 不可判别;`-0===0`→false(既有,base 同)。根治需改 NaN 表示(见 memory:nan-int0-alias-trap)。

**[已落地] ES2022 类静态初始化块 `static { ... }`(2026-07-12,v1.4.7 后,ES_CONFORMANCE_REPORT 项)**:
- **现象**:`class A { static { this.x = 1; } }` COMPILE_FAIL(`expected (, got THIS`)——parser 把 `static` 后的 `{` 误当方法名/字段。
- **修**:① `lang/parser/ast.js` 加 `StaticBlock` NodeType + 节点类;② `parseClassMember` 在 `static` 后若 curToken=`{` 则 `parseBlockStatement` → `StaticBlock(body)`;③ `compiler/functions/statements.js` 收集 `StaticBlock` 成员,类对象存 classOffset 后按序发射:临时置 `__this` 局部槽=类对象(从 classOffset 重载)、`compileStatement` 块体、块后恢复外层 this(类可声明于方法内)。块内 `this.x=v` 直写类对象(同一指针,`A.x` 可见)。
- **门禁**:`static{this.x=1}`→A.x=1、`static y=10; static{this.z=this.y+5}`→B.y B.z=10 15 与 node 一致;**fixture `class-static-block` FAIL→PASS,PASS 86→87 零回归**;自举定点 gen2==gen3 逐字节 17,645,584(编译器源码无静态块,新 codegen 路径不触,字节不变)。偏差:字段/块严格源码序交错未保证(块统一在字段后)、块内对象增长重分配写回未处理(既有对象模型限制)。

**[已修] `String(x)[i]` / unknown 类型字符串下标 → undefined(2026-07-12,v1.4.7 后,ES_CONFORMANCE_REPORT 项)**:
- **现象**:`String(1)[0]` → undefined(应 "1");`"1"[0]` 字面量正常。
- **根因**:`compiler/expressions/members.js` 静态数字下标分支对 unknown 类型基对象**提前 `_js_unbox`** 剥掉 0x7FFC 字符串标签 → `_subscript_get` 靠 A0 标签分派 charAt(subscript.js:24),标签丢失 → 落数组路径越界读 undefined。字面量/字符串类型变量走 inferType=STRING 的 charAt 路径不经此,故正常。
- **修**:删掉静态下标分支的提前 `_js_unbox`,保持 A0 装箱进入 `_subscript_get`(内部对数组/对象自行 unbox,裸/装箱皆可;A1=裸 idx 经 `_syscall_arg` 直通)。
- **门禁**:`String(1)[0]`/拼接串/数组/对象下标回归与 node 一致;**fixture `generated-string-runtime` FAIL→PASS,PASS 85→86 零回归**;自举定点 gen2==gen3 逐字节 17,629,200。偏差:数字基元下标 `(1+0)[0]` 仍崩(既有,base 同崩,基元非目标)。

**[已修] 括号箭头默认参数 `(a=7)=>` / `(a=1,b=2)=>`(2026-07-12,v1.4.7 后)**:
- **现象**:`(value = 7) => value`、首参带默认的 `(a=1,b=2)=>` COMPILE_FAIL(`no prefix parse function for =>`)。
- **根因**:`parseGroupedOrArrow` 的 isArrowMode 检测只认 curToken=IDENT 且 peek=COMMA/RPAREN;`(a=7)` 的 peek 是 ASSIGN → 漏检 → 落 `parseExpression` 得 AssignmentExpression,而其后的 `=>` 重解析条件(line 335)只接受 Identifier/SequenceExpression,不接受 AssignmentExpression → caller 遇 `=>` 无 handler。
- **修**:335 重解析条件加 `AssignmentExpression`;把 AssignmentExpression `a=7` 转为 `AssignmentPattern`(codegen 默认参数只认后者),用 **AST 类实例** `new AST.AssignmentPattern(left,right)`(非普通对象字面量,gen2 安全——避免 iterator helpers 同款合成节点分歧);SequenceExpression 内的 AssignmentExpression 同转。
- **门禁**:`(a=7)=>`/`(a=1,b=2)=>`/首参无默认/单参无默认/分组赋值回归六情形与 node 一致;**fixtures `arrow-default-param-basic`(既有)+ `arrow-default-param-paren`(新)从 FAIL→PASS,PASS 82→84 零回归**;自举定点 gen2==gen3 逐字节 17,563,664。

**[已修] `Array.from(可迭代)` 段错误(2026-07-12,v1.4.7 后)**:
- **现象**:`Array.from(g())`(生成器)、`Array.from(new Set(...))`、`Array.from("abc")` 段错误(exit 139)。
- **根因**:`Array.from(x)` 单参一律 `compileArrayMethod(x, "slice")` 把 x 当数组调 `_array_slice`——x 是生成器/Set(非数组布局)→ 越界读 → 崩。
- **修**:`inferType` 判输入:数组/TypedArray 走原快路(slice/map);非数组(生成器/Set/字符串/unknown)脱糖 `[...x]` spread 抽干——无 mapFn 走 `compileExpression([...x])`(与 iterator toArray 同,gen2 安全),有 mapFn 走 `compileArrayMethod([...x], map)`。编译器自身不用 Array.from → 分支不触 → 字节不变。
- **门禁**:生成器/生成器+map/Set/字符串/数组/数组+map 六情形与 node 一致(**含 gen2:Array.from(g(),fn) 在自举编译器正确,不同于 iterator helpers——此处仅单层 spread 无嵌套链改写**);新增 fixture `es/array-from-iterable`;自举定点 gen2==gen3 逐字节 17,563,664;fixtures 零回归。

**[已修] for 循环空 header 段 `for(;;)`(2026-07-12,v1.4.7 后)**:
- **现象**:`for(;;)`、`for(a;;c)`、`for(;test;)` 空 test/update 段此前 COMPILE_FAIL(`expected ), got ...`)。
- **根因**:`parseForStatement` 的 test 分隔符(原 line 244)与 update 结尾(RPAREN)无条件 `expectPeek(SEMICOLON)`/`expectPeek(RPAREN)`,而空段时 curToken 已是 `;`/`)`、peek 是下一个 token → expectPeek 误判失败。init 分隔符早已用"curToken 已是 `;` 则跳过 expectPeek"的正确模式,test/update 两处漏了。
- **修**:test、update 两处均镜像 init 分隔符——`if (!curTokenIs(SEP)) { if (!expectPeek(SEP)) return null; } nextToken()`,curToken 已是分隔符则直接消费。
- **门禁**:四情形(`for(;;)`/`for(a;;c)`/`for(;test;)`/`for(a;b;c)` 回归)与 node 逐字节一致;新增回归 fixture `es/for-empty-header`;自举定点 gen2==gen3 逐字节一致 17,563,664(编译器源码无空 header for → 解析不变、字节不变);fixtures 零回归(79/45,+1 新 fixture)。

**[已落地] Promise.withResolvers + Promise.try(ES2024/ES2025,2026-07-12,悬崖后 v1.4.6 增量)**:
- **交付**:`Promise.withResolvers()` → `{ promise, resolve, reject }`(pending promise + 两个绑定到它的一等 resolve/reject 函数);`Promise.try(fn)` → 同步调 `fn()`,返回值包 resolved、同步 throw 包 rejected、返回 promise 则透传。此前被 16MB 悬崖挡住 + 与 #74 promise.js 重构冲突而推迟,现悬崖已修、手工并入 #74 后的 promise.js。
- **实现**:`runtime/async/promise.js` 加 `generatePromiseWithResolvers`(label `_Promise_withResolvers`),**复用 current main 既有 helper**——闭包布局 `[CLOSURE_MAGIC@0, tramp@8, boxed_promise@16]` 直接挂 `_promise_resolve_tramp`/`_promise_reject_tramp`,resolve/reject 走 #74 后的 `_promise_resolve/reject` **天然获得微任务延迟语义**,零 promise.js 冲突。`Promise.try` 走编译器侧 `compilePromiseTry`(`compiler/functions/functions.js`):**内联异常帧镜像 `compileTryStatement`**(80B/10 槽、偏移 {link@0,catchPC@8,SP@16,FP@24,S0@32..S5@72}、`emitExcCtxRestore` 弹帧),`fn` 经 `_promise_invoke1` 调用(arg=undefined),体内 throw 无本地 try → `_throw_unwind` 跳本帧 catchLabel → 读 `_exception_value` → `_Promise_reject`。分派:Promise 静态方法块加 `withResolvers`/`try` 两 case。
- **门禁(全绿)**:① 行为——与 node v24 一致:withResolvers(resolve/reject 均延迟到同步代码后,`before/after-resolve` 先于 `resolved:42`)、try(同步返回→resolved 5、同步 throw→rejected kaboom、返回 promise→透传 9,`sync-end` 先打印)。② 自举定点——`gen2==gen3` **逐字节一致 17,563,664 字节**,`__text`=17,063,684(16.27 MB,过悬崖 +286,468 B),gen2 编译并运行 withResolvers+try 样例正常(**内联异常帧未破坏定点**)。③ fixtures 零回归——PASS=79/FAIL=45/TOTAL=124,与 base(5a96c985 无改动)失败集**逐项 diff 完全一致**。

**[已修] 16MB __text 自举悬崖 —— `_subscript_set` 2²⁴ 索引帽(CRITICAL 基建,2026-07-12)**:
- **现象**:任何把编译器自编译产物 `__text` 段推过 **16 MB(2²⁴=16,777,216 字节)** 的改动,gen2 都在写出前挂死;base `__text`=16,772,052 仅在悬崖下 5,164 字节,故 #74/ES2024/ES2025 等加码特性一律"逻辑正确却编不出 gen2"。此前误判为 gen1 fixup 回填/运行时数组存储在 >16M 元素时的 bug。
- **根因(实证复现锁定)**:`this.code` 是每字节一元素的 JS 数组,fixup 回填 `this.code[fixup.offset]=byte` 即数组元素写 `a[i]=v`,经 `_subscript_set`。`runtime/core/subscript.js:_subscript_set_array` 对 `index >= 0x1000000`(16M)**直接跳过写入**(原为防损坏巨大下标触发 `_array_ensure_cap` 巨额分配 OOM 的安全阀)。于是 `__text≥16M` 后,尾部指令的 fixup 被静默丢弃,占位符 `bl <self>`(0x94000000,跳向自身=死循环)残留 → gen2 死循环挂起。探针精确验证:`a[i]=v` 在 i≤2²⁴-1 全 OK、i≥2²⁴ 全 FAIL 且读回旧值(索引被 24 位截断,高写落回低索引);GET 侧无此帽,读 ≥2²⁴ 正常。
- **修**:`subscript.js` 帽 `0x1000000`(2²⁴)→ `0x10000000`(2²⁸=268M 元素/~2GB data),给 `this.code` 字节缓冲 16× 头room,仍拦截真正损坏的巨大下标(2²⁸–2⁴⁸)防 OOM。`movImm` 仍是单条 MOVZ(`0x1000<<16`),**指令数不变、`__text` 零增长**;base 从不触帽故行为不变。`_js_set_length`(`.length=N`)本就无帽,不受影响。
- **门禁**:定点 **gen2==gen3 逐字节一致 17,268,752**(gen1 node→gen2→gen3 全链)。抬帽后探针:`a[i]=v` 在 16,777,216 / +1 / +14 / +284 及推到 **20,000,000 元素**处散写读回全 OK(bad=0),无低区 clobber,与 node 一致(base 二进制同探针 i≥2²⁴ 必 FAIL)。**解锁全部加码特性**(#74 微任务、ES2024 groupBy/withResolvers、ES2025 Set 方法等此前被悬崖挡住的自举)。

**[已修] #74 Promise 微任务延迟(MED,2026-07-12,悬崖后首个跨界落地特性)**:
- **现象**:`.then/.catch` 回调**即时同步执行**——`console.log(s1); Promise.resolve().then(()=>log(t)); log(s2)` 打成 `s1 t s2`,规范应为 `s1 s2 t`(微任务在同步代码后)。
- **修**:`.then/.catch` 不再即时跑 reaction,而是**入微任务队列**;同步顶层代码执行完后经 `_main → _scheduler_run → _promise_drain_reactions` 排空队列按 FIFO 触发。改动 `runtime/async/promise.js`(±140 行:队列结构 + then/catch 入队 + drain)、`runtime/core/allocator.js`(+6,队列节点分配)、`compiler/index.js`(+4,顶层后接 drain 调用)。**await 路径未动**(仍走协程 yield + `_promise_await`)。
- **此前被 16MB 悬崖挡住**:#74 加 ~11KB 把 `__text` 推过 2²⁴,gen2 死循环挂,无法自举——正是本波先修悬崖(见上)的直接动因。
- **门禁**:行为 `s1 s2 s3 t1 t2 t3`(链式 `.then().then()`)逐字节匹配 node;**定点 gen2==gen3 逐字节一致 17,301,520**,gen2 `__text`=16,794,280(**过 16MB 悬崖 +17,064 字节**——修复前必挂,现干净达定点,悬崖实战验证);fixtures **PASS=79/FAIL=45** 与 base 失败集**逐项一致(零回归)**。偏差:setImmediate/process.nextTick/setTimeout 事件循环部分未落地(import-local-nexttick-* 仍失败,非本波 scope)。

**[已修] #36 Error 对象字符串化(2026-07-12)**:
- **现象**:Error 族对象(普通对象 tag 0x7FFD + `__jsbin_err` 品牌)此前 `err.toString()` 落通用方法路径找不到 toString 而崩,`String(err)`/`""+err`/模板/`console.log(err)` 出 "[object Object]"。node 期望 "name: message"(空 message → "name")。
- **实现**:新增共享运行时 `_is_jsbin_err`(tag 0x7FFD 且 `_object_has "__jsbin_err"`)与 `_error_to_str`(读 name/message,空 message 返 name,否则 `name + ": " + message`,委托既有 `_object_get`/`_strconcat`,仅用 S0-S2 避开 `_strconcat` 冲 S5)。三处 chokepoint 前插判别:print.js `_print_value_object_ptr`(console.log)、string `_valueToStr` 装箱/裸对象双分支(String/拼接/模板,裸指针分支先回装箱 0x7FFD)、functions.js `.toString()` tag 分派。另在 Error 构造显式落 `cause=undefined`(否则缺失属性访问返 int 0,`err.cause === undefined` 为 false)。
- **门禁**:node 差分逐字节(toString/String/拼接/模板/console.log、Error/TypeError/RangeError、空 message、catch 到的 error)全绿;fixtures **PASS=85/127**(error-basic/error-subtypes FAIL→PASS,零回归);自举定点 **gen2==gen3 逐字节一致(17,629,200)**,gen2 编译含 throw/catch 的 error 程序输出正确。关键:错误处理是编译器自身可能用到的路径,定点仍逐字节一致确认改动未扰自举。

**[已修] #71 + #73a/#73b/#73c(内建分派群,2026-07-12)**:
- **#71 bigint.toString**:零参 toString 的 tag 分派中,bigint 接收者(裸 user_ptr,high16==0)此前落数字路径把指针当 double → "0."。修:在 symbol 判别前插 `_is_bigint` 检测,命中则取 +0 处 64 位值 → `_intToStr`(有符号十进制,负值正确);1 参 `toString(radix)` 路径同判 bigint,取值截低 32 位重打 int32 tag 供 `_num_toString`(值域限 32 位,记偏差)。
- **#73a Object.entries/values/keys**:`_array_new_with_size`(唯一 live 版,ArrayBaseMixin 是死代码)返回**裸数组头**(未装箱),三 helper 直接返回 → console.log/JSON.stringify 按 high16==0 误判为对象("[object Object]"/0)。修:三 helper 返回前 `| 0x7FFE` 装箱,entries 内层 [k,v] 亦装箱。数据层(索引/length)一直正确,仅装箱缺失。
- **#73b Array.prototype.with**:此前 `with` 不在 HOISTED_ARRAY_METHODS → 落通用对象方法把 "with" 当键查找而中止。加 `with` 入表 + compileArrayMethod case,委托新运行时 `_array_with`(slice 全拷贝 → 归一负 idx → `_array_set` → 返回副本,不改原数组;越界不抛 RangeError,记偏差)。
- **#73c defineProperty 访问器 setter**:根因非分派缺失,而是**顺序错**——`_object_set` 命中键后 writable 守卫先执行,而 defineProperty({get,set}) 建 TYPE_GETTER 标记时 attrs 缺省全 false(writable=0),把 `o.p=v` 当"改写不可写数据属性"静默丢弃 → 永不到达 setter@16 分派。修:访问器标记检测(命中则跳 setter 分派)前置到 writable 守卫之前(访问器属性无 writable 语义);非标记数据属性走新 `_object_set_wcheck` 继续 writable 守卫,define 语义(标志=1)直接覆写不变。
门禁:node 差分逐字节(bigint toString/负值/radix、Object.entries 嵌套/values/keys、Array.with 正负 idx、defineProperty setter set+get/仅 set、writable/字面量访问器/普通属性回归)全绿;fixtures 80/127(基线 77,零回归 +3);自举定点 gen1out==gen2out==gen3out(17,219,600);gcstress(GC_THRESHOLD=8192/4096、GC_FULLONLY)逐字节一致;x64 抽验逐字节一致。偏差:console.log 直接打印嵌套数组仍崩(`console.log([[1,2]])`,pre-existing,与本批无关,JSON.stringify 正常)。

**[已修] #68 空语句 + #67 shim CWD 解析(2026-07-12)**:
- **#68 空语句 `;`(MED)**:`class B{};` 尾分号、裸 `;`、`;;`、`function f(){};`、`if(x);` 此前 COMPILE_FAIL(`no prefix parse function for ;`)。根因:`parseStatement` 无 `TokenType.SEMICOLON` 分派,`;` 落表达式路径无前缀解析函数。修:`parseStatement` 遇 SEMICOLON 返回新 AST 节点 `EmptyStatement`(codegen 已有 `case "EmptyStatement"` no-op);`for` 循环头的 `;` 由 `parseForStatement` 单独消费不经此路径,未受影响。偏差(既有正交 bug,非本项):`for(;;)`/`for(a;;c)` 空 header 段仍崩——for-header parser 在 test 段无条件 `expectPeek(SEMICOLON)`(line 244),空 test 时多要一个分号;HEAD 即已如此(实测确认),未在本波修。
- **#67 shim 路径 CWD 解析(LOW-MED)**:`this.nodeShimPath` 与 `resolveModulePath` 的内建/`__json_shim`/`__regexp_shim` 裸名一律 `path.resolve(process.cwd(), "runtime/node", …)`。从 repo root 以外目录编译(`cd /tmp && node /path/cli.js …`)→ cwd 无 runtime/node → shim 解析为空 → JSON.stringify 原样返回 `[object Object]`、JSON.parse→0、regexp 静默坏。修:新增 `runtimeNodeBase(path,fs)`——**优先 cwd**(保自举现状:自举二进制 `process.cwd()` 恒返 `"."`、恒从 repo root 跑,cwd 分支先命中,路径逐字节等旧值),cwd 无 runtime/node 时才回退**编译器自身位置**(`_compilerRootDir` 由 `import.meta.url` 上溯两级得出)。**自举二进制形态 import.meta.url 不可靠**(codegen 装箱为 `"file://<sourcePath>/module.js"`,含伪 `/module.js` 段致 dirname 偏移)——已核实:该回退分支在自举链(恒 cwd=repo root)永不触达,故不依赖其正确性,仅需能编译;最终兜底仍返 `process.cwd()`,自举形态下 `runtimeNodeBase` 恒等价旧 `process.cwd()` 值。
- **门禁**:#68 node 差分逐字节(`class B{};`/`function f(){};`/裸 `;`/`;;`/`if(x);`/非空回归)全绿,自举 gen2 亦正确编译空语句;#67 从 repo root 与从 /tmp(`cd /tmp && node …/cli.js`)JSON.stringify/parse、regexp 均正确(base 从 /tmp 实测坏:`[object Object]`/0),x64 同验;**定点 gen1out==gen2out==gen3out 逐字节一致**(macos-arm64 全链,#67 路径改动跑两链未破);fixtures 82/129(基线 79,零回归,#68 +空语句 fixture);gcstress(GC_THRESHOLD=65536/131072 + GC_VALIDATE,node 版+gen2 版)逐字节一致;x64(Rosetta)#68/#67 抽验全绿。

### 纯 ES 层三大件(2026-07-12,设计 pass → 分期实现)

- **#66 原型链子系统**:设计核实发现拓扑本来就对(实例 __proto__ 已设、_object_get 已走链),instanceof 只是没去走。三期落地(类 codegen 零改动):instanceof 用户类+继承+内建(Date/Map/Set/RegExp tag)、super.prop/getter 读(_maybe_getter 绑当前 this)、setPrototypeOf 修脱壳崩溃 + X.prototype 装箱一致性。定点 17,055,760(两链交叉)。gen1-safety 教训:agent 初版用 hasOwnProperty.call(dict,userkey) 在 gen2 恒真(#32 原型链污染),真机自举差分才抓到。存量:内建 getPrototypeOf([])===Array.prototype false、x64 getPrototypeOf=== 装箱 gap、空语句 `;`(class X{};)COMPILE_FAIL(#68)。
- **#43 BigInt P1 已落地**(64 位):算术 + - * / % **(sdiv 截断/srem/快速幂)、比较 ===/</>(有符号,修既有 _bigint_cmp 无符号 bug)、混型相等/比较近似、String/模板/打印(10n 带 n)、负值(runtime _bigint_neg 绕开布局敏感组合缺陷)。三期各独立过定点,终 17,186,832,num 0.20 零扰(保守守卫普通数值 codegen 字节不变)。偏差:任意精度押后、混型算术按数值近似(标准 TypeError)。**纯 ES 三大件(#61 描述符/#66 原型链/#43 BigInt)全部落地。**
- **#61 P3 待做**:enumerable 枚举强制。

### 第五修复波 #69 + #72(2026-07-12)

- **#69 ES5 函数构造器(CRITICAL)**:`function P(a){this.a=a;} new P(5)` 此前崩(`this`=NULL → `_object_set(A0=0)`)。根因:普通 `FunctionDeclaration` 用 `new` 走 `compileUserClassNew` 的兜底路径,按 **class 约定** 传参(`this` 在 A0、实参 A1-A5),但普通函数约定是 **形参 A0../`this` 在 A5**(见 index.js [#36]),故函数体内 `this` 读到 NULL。修:`compileNewExpression` 默认分支识别 `FunctionDeclaration` → 专路 `compilePlainFunctionNew`——建对象→`__proto__`=`F.prototype`(惰性建、存 GC 根区数据槽 `_funcproto_<sym>`,同 `_classinfo_` 机制)→形参 A0../`this`(A5)=实例→跑函数体→显式返回对象/数组(tag 0x7ffd/0x7ffe)覆盖、否则返回该实例。`new F() instanceof F` 复用实例 `__proto__` 链:运行时新增 `_instanceof_proto(实例,protoRaw)`(复用用户类 instanceof 的防环/堆守卫上溯 `_iof_proto_walk`)。**class 的 `new` 路径零改动**(定点敏感,编译器自身用)。偏差:嵌套(非顶层)函数声明 `new`、`new F(...spread)` 仍走旧兜底(预存缺口,非本波回归)。
- **#72 可选链计算下标(HIGH)**:`a?.[i]` 编译期崩(`Cannot read properties of null (reading 'length')`)。parser 的 `?.[` 分支本身正确(产 computed+optional MemberExpression),根因在 codegen:`compileMemberExpression` 的 optional 分支一律按 `getMemberPropertyName(property)`+`emitObjectGetIC` 处理属性名,对 computed 下标 `property` 是索引表达式 → propName=null → `.length` 崩。修:optional 分支按 `expr.computed` 分派——非空基对象才求值下标(短路时不求值,无副作用),走 `_subscript_get`(同 `arr[i]` 动态路径)。
- **门禁**:node 差分逐字节一致(this.x=/多字段/return 对象覆盖/无参/默认参/instanceof/短路无副作用/class 回归/`a?.m[i]` 回归);**定点 gen2==gen3(实为 gen1==gen2==gen3)17,219,600**(两链交叉,new/this 定点敏感);fixtures 77→79(+2 回归 fixture,零回归);gcstress(GC_THRESHOLD=1 minor + GC_FULLONLY)`new`/instanceof 密集分配稳定;x64(Rosetta)抽验全绿。工程教训:instanceof 初版 ~50 行内联上溯把自编译产物推过 32KB 段界至 17,252,368 → 触发既有(与本改动无关的)布局位置敏感非确定性(gen2≠gen3 振荡,详见 MEMORY);改委托运行时 `_instanceof_proto`(编译器源码占用骤降)后落回稳定 +32768 页(17,219,600),定点恢复。

### 属性描述符体系 #61(用户指出整体缺失,分三期)

- **设计 pass**:对象级冻结位塞 type 字 byte1(零成本)、per-property flags 惰性平行数组 + null 哨兵(普通对象不 materialize、定点零扰)、三期交付。
- **Phase 1 已落地**(2026-07-11):对象级 freeze/seal/preventExtensions 真语义 + isFrozen/isSealed/isExtensible,拒写/拒加/拒删守卫(IC 快路 1-byte 冻结守卫,prop bench 1.04s 零回归),定点 16,498,704。
- **Phase 2 已落地**(2026-07-12):per-property attributes。对象头 40→48(尾部加 flags_ptr@40,所有 <40 偏移零改);惰性平行 flags 数组 + null 哨兵(普通对象/编译器自身对象 flags_ptr=0 不 materialize,逐字节等价 P1)。功能:`defineProperty` 落 attrs(缺省全 false,区别普通赋值全 true)+ writable:false 写守卫精确到属性(materialize 时置 byte1 bit3=EXT_HASFLAGS 迫 IC 落慢路,快路仍只对象级 1-byte 守卫)、`getOwnPropertyDescriptor`(data/accessor/缺失)、`propertyIsEnumerable`、精确 freeze/seal(全属性清 writable|configurable / configurable,对象级位保留)。grow/delete 镜像 flags;GC 经 flags_ptr@40 保守扫 + scan_container 标记。node 差分逐字节一致、gen2==gen3 定点 16,973,840、fixtures 77/122 零回归、gcstress(minor+full)/x64 抽测通过、prop bench 0.24s 零回归。Phase 3(enumerable/for-in/Object.keys 强制过滤)待接力——当前 keys/for-in 仍列举 enumerable:false 属性(descriptor/propertyIsEnumerable 已正确读回)。

### 核验轮次(2026-07-11)——两轮独立对抗差分

**第三修复波(#44/#45/#46/#52/#59/#60)**:#52 生成器本地(核验通过)、#45 Date.UTC、#46 嵌套 join、#59 求值序/复合赋值、#60 标签 break/continue 已合并(定点 16,351,248);#44 展开非数组可迭代(迭代器协议 helper,避 P1 晋升分歧)已合并。**第三修复波全部落地**,定点 16,433,168。控制流/求值序/内建/迭代协议的边角正确性大幅补齐。
**第二修复波(#53-#58)完成**:第二修复波全部落地(#53-#58):for-of 解构、finally-abrupt、Date tag、求值序/捕获 ++、bind 预绑定参、Math.sqrt/log/cbrt、reduceRight、defineProperty accessor。定点 16,252,944。v1.4.1 已发布(#57/#58 归入下一版)。

- **第一轮**:发现 20 白名单外缺陷,核心 5 组(解构赋值/嵌套 #47-#48、生成器内 RegExp #49、JSON Date/NaN/key #50、Math/内建/Date setter #51)已修复波修复并合并,fixtures 72→76。
- **第三轮**(v1.4.2 后复验):确认前三修复波真修好(finally-abrupt/标签 break/解构/JSON 全绿、回归守卫全绿),再翻出 10 白名单外缺陷 + 1 构建环境 bug——多为既有正交缺口:4 崩溃(#62 Date 存容器、#64 Math.exp/pow 分数、#65 Map/Set 子迭代器/match.slice、)+ 静默错值(#63 方法调用重赋值副作用丢、#66 instanceof/super 原型链、#65 Symbol.toString)+ #67 shim CWD 解析。已立案 #62-#67,第四修复波进行中。#61 P1 对象级冻结、#62 Date 装箱 0x7FFD(存容器往返 typeof/方法)、#63 闭包 box 共享 + arr.length=、#65 Map/Set 子迭代器/exec.slice/Symbol.toString 已合并;#64 Math.exp/log2/log10/pow 分数已合并。**第四修复波全部收口(#61 P1/#62/#63/#64/#65)**,定点 16,744,464。第三轮核验 10 缺陷除 #66 原型链(押后设计)/#67 CWD(低优先)外全修。
- **第二轮**(修复波后复验):确认修复波真修好(解构大体/生成器+RegExp/JSON/Math 全 PASS、回归守卫全绿),又翻出 12 个更深缺陷——多为既有正交缺口 + 3 个近期相关(#53 for-of 解构绑定恒 0、#54 finally 跳过 abrupt、#55 Date.toISOString tag 污染)。已立案 #53-#58,第二修复波进行中。
- 教训:测试深度决定发现率;"改值怎么产生 vs 怎么用/存/比较"的区分(NaN 0x7FF0 可行、存储规范化不可行);shim 合成调用必测嵌套作用域;agent 陈旧基线自证漏交互,集成后独立复核是铁律。

### 当前工作面(2026-07-11 多线批)——ES 批次D 收官

- **[核验] #52 生成器体内跨 yield 改本地变量(agent 协作)**:在本代码线(#47-#58 修复波后)全面复现不出——`function* g(){var x=0;x=x+1;yield x;x=x+1;yield x;}` 最简式、fib(while(true) 有状态)、多本地交替、闭包捕获跨 yield 改本地、for-of 驱动计数器,在 arm64 与 macos-x64(Rosetta)两平台逐字节等同 node,gcstress2/3 稳定;回溯到最初立案本缺陷的提交(f57af9c)同样通过。推断:或系其后修复波(#54 finally-abrupt、#56 求值序等异常/协程路径)连带根修,或原报告出自模拟自举退化壳(见 MEMORY emulated-selfhost-verification-broken)误判。已加固定回归 fixture `es/generator-local-mutation`(6 组场景),ES_SUPPORT 从已知缺陷降级为核验通过。fixtures 76→77(+此 fixture,零回归)。
- **[修复波] #51 Math/内建/Date(agent 协作)**:Math.max/min(NaN 传播用新 jnan=fcmp-unordered 而非 x!==x、空参 ±Inf)、Math.round(负半向 +∞)、Math.sign(-0/NaN)、Math.hypot(新 fsqrt)、Array.includes/indexOf 负 fromIndex、Map.forEach、Date 多参 setter(原子多字段)。集成裁决:NaN 标识符统一为 0x7FF0…1(#51 路线,不与 int0 别名→NaN 值流经变量也打印"NaN"、fcmp 传播正确),连带把 #50 的 JSON 非有限守卫改为字符串形判(表示无关)。两链交叉定点 16,007,184。
- **[修复波] #50 JSON 缺陷群(agent 协作)**:stringify(Date)→ISO(新 __json_date_iso 内建,安全堆界判 TYPE_DATE)、NaN/Infinity→null(NaN 标识符 codegen 改发真 0x7FF8 位 + shim 双语义守卫)、toJSON(key) 字符串键(根因同 #49——JSON shim 别名嵌套作用域未登记)。定点 15,892,496。NaN 标识符路线(≠被否决的存储侧 +0.0 规范化)实测定点干净、fixtures 不退。
- **[修复波] #49 生成器/嵌套函数内 RegExp 静默失效 + arguments 对象(agent 协作)**:根因非协程状态,是**合成 __RE_* 调用在闭包分析后展开→嵌套作用域解析失败被静默丢弃**;修法把 shim 导入名登记进各 importer 的 functionAliases(仅 __regexp_shim,自举零影响)。顺带实现**此前完全缺失的 arguments 对象**(replace(fn)/matchAll+arguments 的 SIGSEGV 根源)。fixtures 75→76,定点 15,843,344。
- **[修复波] 解构补全 #47/#48(agent 协作)**:嵌套模式 `{p:{q}}`/`[{v}]`、函数参数解构、解构赋值形 `[a,b]=[b,a]`(此前静默 no-op)、成员目标 swap;内联解构去重成共享递归 helper 使定点反缩至 15,794,192。核验 agent 新发现:生成器体内跨 yield 改本地变量崩溃(零解构也崩,#52,协程本地保存缺陷)——**后续核验在本代码线复现不出,已加回归 fixture 并降级为通过,见本节顶部条目**。
- **内建语义修补(agent 协作)**:Math.max/min(...arr)(spread 恒 0 根修)、flat(depth)/flat(Infinity)、Array.fill(负索引/越界)、copyWithin(重叠方向);Math.sign 验证已修。回退:Map for-of(触发 gen0/gen2 分歧,守自举冻结)。确认不可修:Number.isNaN(NaN≡int0 别名无结构判别)。定点 15,958,032(两链交叉验证稳定)。
- **Date 完备(agent 协作)**:setXxx 全家族(反向历法 _date_civil_to_days,翻滚自洽)、Date.parse(ISO 子集)、toISOString/toJSON、getTimezoneOffset;59 断言三平台逐字节。附带根修 new Date(0)/new Date(y,m,d) 误取当前时间、负 ms 时间字段少 1h、x64 toISOString 段错误。集成核验发现 Date.UTC 未实现(调用崩,既有缺口,#45 立案),setter/parse/toISOString 本身全对。定点 15,843,344。
- **生成器收尾(agent 协作)**:yield* 委托(协程 resumer 链改造支持任意深度嵌套)、gen.return(v)、gen.throw(e)(与 #38 异常链联动)、多实参;15 微测三平台逐字节。集成核验发现 `[...gen()]` 展开崩溃系既有展开缺口(仅支持数组/字符串源,#44 立案),生成器功能本身经 for-of/next 全正确。定点 15,695,888(两条独立链交叉验证稳定,agent 报的振荡复现不出)。
- **对象解构 rest + 匿名 default export + flatMap(agent 协作)**:`{a,...rest}` 声明(_object_rest 排除键复制)、匿名类/函数 default export(合成名 + 匿名 extends)、Array.flatMap;顺带修 typeof(类引用)→"function"。集成时抓修 _object_rest 漏装箱 0x7FFD(typeof/JSON 失败)。fixtures 72→75,定点 15,564,816。
- **RegExp 高级特性(agent 协作)**:lookahead/lookbehind、反向引用、命名组+.groups、dotAll、sticky、matchAll、replace 函数参,纯 shim 内迭代;73 node 断言 + 50 编译断言三平台逐字节,fixtures 72→73,定点不变。
- **JSON 全参补全(agent 协作)**:stringify replacer(函数/数组白名单)+space 缩进、parse reviver、toJSON 协议,纯 JS shim 单文件,35 断言逐字节对齐 node;定点 15,319,056(+16KB:backend 的诊断 JSON.stringify 使 shim 编入自举)。
- **#44 Infinity 字面量发射为 0 根修**:标识符 `Infinity` 原编译成整数 0 → `0===Infinity` 恒真、`n<Infinity` 恒假、JSON 把含 Infinity 属性打成 null;改发真 +Inf 位。抽取自 bug-A 战役 worktree 的独立子修复。
- **bug A 存储侧规范化方案否决(#41)**:agent 探明"把存储 +0.0 规范化为装箱 int0 以区分 miss 哨兵"会把别名从"miss vs 零"换成"NaN vs 零"(装箱 int0 ≡ 硬件 NaN 位),导致 NaN 打印退化、`NaN===0` 变 true;净收益为负,暂缓(worktree 保留)。教训入记忆库 nan-int0-alias-trap。
- **#43 数组越界读根修(bug A 局部)**:`_array_get`/`_subscript_get` 数组分支加 length 边界检查,越界/负下标返回 tagged undefined(node 语义;此前直接越界读堆邻居,`while((v=a[i++])!==undefined)` 死循环/垃圾值)。对象属性 miss 的 undefined 化**读侧不可行已实证**:miss 哨兵裸 0 与存储的 +0.0(raw double 全零位)同位,读侧转换把零值属性全部塌成 undefined(regexp shim pos=0 崩)——根治需存储侧把 raw-double-zero 规范化为装箱 int0,已立案。零参 toString() 段错误同批根修(#42,数字/字符串/对象 tag 分派)。
- **#41 相等比较双求值根修(重大存量)**:通用二元路径先按浮点预编译操作数、`==/===/!=/!==` 四个 case 又用 compileOperandAsJSValue 重编一遍——任何带副作用的操作数(函数调用/赋值/++)在相等比较里执行两次(`while ((m=re.exec(s)) !== null)` 每轮吃两个匹配、`if (f()===x)` 调 f 两次)。修法:相等类在浮点预编译前分派早退,删除死 case;顺带每个相等比较少一次浮点强转,产物 −688KB(15,958,032→15,269,904)。#40(x64 P1 晋升"返回值变 arg0")经复核实为 #37 对齐垫已根修,__regexp_shim 的 P1 禁录规避一并解除。
- **批次D 全部落地(6 个并行 agent 协作 + 主线集成)**:bind/call/apply、Error 体系+跨函数异常(#38)、RegExp shim 子集、对象/类 getter+setter、Symbol 基础、let/const 块级+TDZ+每迭代绑定、生成器 function*/yield(复用协程,附带根修 3 个协程/GC 交互缺陷)、类私有字段 #x(附带根修构造器实参时序与隐式 super 两个类 bug)。fixtures 65→72,定点 15,958,032,num 0.20s/prop ~1.1s(布局噪声带内),五目标交叉全过。

- **let/const 块级作用域 + TDZ + 循环每迭代绑定(agent 协作)**:AST 级 alpha-renaming(`lang/analysis/blockscope.js`,parse 后一遍改名,下游闭包/捕获分析零改动)、TDZ 哨兵守卫(仅词法先读处发射,编译器全源 0 处守卫税)、捕获型 `for(let i)` 每迭代 rebox。fixtures +3,非捕获程序产物与基线逐字节一致。
- **Symbol 基础子集(agent 协作)**:裸堆指针 + TYPE_SYMBOL(61) 标记块表示(NaN-box 标签已满的出路)、typeof/description/Symbol.for/keyFor/well-known 占位、symbol 对象键零热路税(指针位比较天然正确);fixtures 转绿 symbol-call-type/symbol-global。
- **对象/类 getter/setter 全量(agent 协作)**:对象字面量访问器 parser+编译、类 setter(此前跳过)、闭包 getter/setter、写路径 setter 分派(_object_set 命中/原型链拦截)、`_object_define` 定义语义与赋值语义分离(子类覆盖父类 getter 的正确性根修)。定点 +49KB,prop/num 无回归。
- **#39 对象数值计算键塌槽根修(agent 协作)**:`_object_key_eq` 的 payload 快路把小整数 double 键(低 48 位全 0)全部判等 + 三种键形态(字面量裸 int/变量 double 位/字符串)互不相认;修法 `_js_prop_key` 数值键规范化为字符串(node 语义 `o[1]≡o["1"]`),字符串键热路零新增指令。
- **RegExp 引擎子集落地(批次D 最大件,agent 协作)**:回溯式纯 JS shim(`__regexp_shim`,~750 行 gen1-safe)+ 编译器注入(正则字面量/`new RegExp` 检测,自举 0 注入)+ 静态类型分派 test/exec/match/replace;75/75 node 差分、57 断言 fixture 三平台逐字节一致,fixtures 65→66。顺带清零编译器图内残留正则(static_linker/path/util/crypto)。副产物:立案两个新存量 bug(#39 对象数值变量计算键塌槽、#40 x64 P1 晋升错编)。
- **跨函数异常传播落地(#38)**:栈上链式 catch 上下文帧(每 try 80B 帧 + 全局 `_exc_ctx_top` 链头,无深度上限/递归安全)+ `_throw_unwind` 运行时(S0-S4→FP→S5→SP 恢复后间接跳 catchPC);finally 跨函数重抛、return/break/continue 跨 try 的链头恢复、含 try 函数放弃槽位晋升(unwind 会回滚 S 快照)。10 场景对拍 node 逐字节一致(arm64+x64),perf 无回归。
- **#32 gen1/gen2 分歧根因修复**:`let constructor` 命中 node 原型链(Object.prototype.constructor truthy)→ gen1 跳过槽位分配错编单函数,2.6MB 差异全为位移传播;Context 字典访问器全部加双语义类型守卫。残差:字符串驻留 Map 对 cstring 系键 ~4.8KB 漏去重(不 gating)。定点更新:gen2==gen3 = 15,482,896。
- **#37 x64 返回值毁坏根修**(多 agent 协作产出):分配器 S4 扩展的奇数对齐垫误用 V0(x64 V0=RAX=RET)→ epilogue 冲返回值;垫按 arch 选(x64→V5)。表象曾是箭头 rest.length=0,实际波及一切 S4 晋升 x64 函数。

### 前一工作面(2026-07-11 深夜批,v1.4.0)

- **ES 完善主线(批次A/B/C 全部落地)**:??/??=/&&=/||= 语义、字符串 for-of/spread、delete、数值 switch、Map/Set(iterable)、Object.assign 多源、Math.sign/pow(纯 asm 快速幂,根修外部 libc pow 从未链接)、Array.of/findLast(Index)/toSorted/toReversed、Object.fromEntries/hasOwn/freeze、Promise.finally/any、new Date(y,m,d,…) 与历法 getter 全家族(Hinnant,含 1970 前)、箭头默认参数/rest、数组解构默认值/rest、?.[]、**=、tagged template。附带根修 _object_has 帧失衡等存量隐雷。剩余大件在批次D(bind/call/apply、Error、let 块级、生成器、Symbol、RegExp、字面量 getter)。

### 上一工作面(2026-07-11 日间)

- **性能**:自编译 240s → ~11.9s;性能主线 P0/P1/P2 均已落地(见 [docs/PERF_PLAN.md](./docs/PERF_PLAN.md)):P0 驻留键指针扫(prop −19%)、P1 vm 录制层热槽晋升 S4(num −9%,簿记税经三代形态收敛到 +4.4% 后被 P2 抵消)、P2 属性 get/set 站点缓存(自验证键下标 IC,融合 getter/写屏障;prop 微基准对 Node 24 从 ~32× 收窄到 ~22×,Map 持平或略快)。下一杠杆:P3 每函数完整 IR + 线性扫描(#12 收官)。
- **内存/GC**:**分代 GC 已转正为缺省**(v1.2.0):sticky mark-bit minor(256MB nursery)+ GOGC 式 full 步调(live×2)+ RS 容器级去重;自编译峰值 RSS −30%(2005→1414MB)、耗时 ~+5%、产物与旧缺省字节一致。编译期可退:GC_FULLONLY(旧 full-only/4GB)、GC_DISABLE。"布局运气毁堆"根因(f32.buffer 别名违规,#19)已根除;判别工具 GC_POISON/GC_SHADOW/GC_DIAG 保留。
- **stdlib**:批次 1/2 完成;**批次 3 完成**(2026-07-10):JSON.stringify/parse 以编译器注入的纯 JS shim 落地(内建 shim 机制首铺,fixtures 61→65),连带根修负浮点 typeof/print、instanceof(空桩)、Array.isArray、_valueToStr 共享缓冲、_floatToString 写头/精度(6 位截断→15 位舍入+去尾零)。已知偏差:第 16 位有效数字边角、JSON 无 replacer/space/toJSON。
- **工具链**:`jsbin run <file>`(编译→执行→末行计时)已加。
- **规划**:四方向路线图(引擎库化/完整 ES/Node+包管理/README 完整化)见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

## 项目概述

JSBin 是一个将 JavaScript 编译为原生机器码的 AOT (Ahead-of-Time) 编译器，支持多平台输出。**已在五目标循环自举。**

| 类别 | 完成度 | 说明 |
|------|--------|------|
| 语法分析 | 85% | ES6+ 语法解析，支持类、箭头函数、模板字符串、解构等 |
| 类型系统 | 50% | 静态类型推断，内置类型识别与跟踪 |
| 运行时 | 80% | Array/Map/Set/Date/RegExp/Promise/TypedArray，GC 完成 |
| 代码生成 | 85% | macOS/Linux/Windows，ARM64/x64,五目标自举定点 |
| 异步支持 | 80% | async/await，协程调度器，Promise 基础 |
| 优化器 | 35% | 常量折叠、闭包变量分析、push/pop 配对窥孔、模块解析 memoize、热槽寄存器提升(P1)、属性站点缓存(P2) |

---

## 项目架构

```
jsbin/
├── lang/                       # 语言前端
│   ├── lexer/                  # 词法分析 (80+ Token 类型)
│   ├── parser/                 # Pratt Parser (50+ AST 节点)
│   └── analysis/               # 语义分析 (闭包变量分析)
│
├── vm/                         # 虚拟机层
│   ├── index.js                # VirtualMachine 主类
│   ├── registers.js            # 虚拟寄存器 (V0-V7, S0-S3, A0-A5)
│   └── instructions.js         # 虚拟指令集
│
├── backend/                    # 后端代码生成
│   ├── arm64.js                # ARM64 后端
│   └── x64.js                  # x64 后端 (System V / Windows ABI)
│
├── asm/                        # 汇编器
│   ├── arm64.js                # ARM64 指令编码
│   └── x64.js                  # x64 指令编码 (REX, ModRM/SIB)
│
├── binary/                     # 二进制格式生成
│   ├── macho_*.js              # Mach-O (macOS)
│   ├── elf*.js                 # ELF (Linux)
│   ├── pe*.js                  # PE (Windows)
│   └── static_linker.js        # 静态链接器
│
├── compiler/                   # 编译器核心
│   ├── index.js                # 编译入口
│   ├── core/                   # 核心模块
│   │   ├── context.js          # 编译上下文
│   │   ├── platform.js         # 平台配置
│   │   └── types.js            # 类型系统
│   ├── expressions/            # 表达式编译
│   │   ├── literals.js         # 字面量
│   │   ├── operators.js        # 运算符
│   │   ├── assignments.js      # 赋值
│   │   └── members.js          # 成员访问
│   ├── functions/              # 函数编译
│   │   ├── builtin_methods.js  # 内置方法
│   │   ├── data_structures.js  # 数据结构
│   │   └── closures.js         # 闭包
│   ├── async/                  # 异步编译
│   │   ├── index.js            # async 语句编译
│   │   └── async.js            # async 函数/调用编译
│   └── output/                 # 输出生成
│       ├── library.js          # 库管理
│       ├── wrapper.js          # C ABI 包装
│       └── generator.js        # 二进制生成
│
├── runtime/                    # 运行时库
│   ├── index.js                # RuntimeGenerator 入口
│   ├── core/                   # 核心运行时
│   │   ├── allocator.js        # 内存分配 (bump allocator)
│   │   ├── print.js            # PrintGenerator
│   │   └── strings.js          # 字符串常量
│   ├── types/                  # 类型实现 (每类型独立目录)
│   │   ├── number/             # NumberGenerator (Int + Float)
│   │   ├── string/             # StringGenerator
│   │   ├── array/              # ArrayGenerator
│   │   ├── object/             # ObjectGenerator
│   │   ├── map/                # MapGenerator
│   │   ├── set/                # SetGenerator
│   │   ├── date/               # DateGenerator
│   │   ├── regexp/             # RegExpGenerator
│   │   └── typedarray/         # TypedArrayGenerator (8种类型)
│   ├── async/                  # 异步运行时
│   │   ├── coroutine.js        # 协程调度器
│   │   └── promise.js          # Promise 实现
│   └── operators/              # 运算符
│       └── typeof.js           # TypeofGenerator
│
└── cli.js                      # 命令行接口
```

### 命名规范

所有运行时生成器统一为 `{Type}Generator` 类格式：

```javascript
class {Type}Generator {
    constructor(vm, backend = null) {
        this.vm = vm;
        this.backend = backend;
    }
    generate() { /* 生成运行时函数 */ }
}
```

---

## 平台支持

| 平台 | 架构 | 可执行(自举验证) | 动态库/静态库 |
|------|------|------------------|----------------|
| macOS | ARM64 | ✅ Mach-O(gen2==gen3,原生) | 🔶 历史通路,未在当前验证矩阵(见 ROADMAP L1) |
| macOS | x64 | ✅ Mach-O(gen2==gen3,Rosetta 2) | 🔶 同上 |
| Linux | ARM64 | ✅ ELF64(gen2==gen3,Docker) | 🔶 同上 |
| Linux | x64 | ✅ ELF64(gen2==gen3,Docker+Rosetta) | 🔶 同上 |
| Windows | x64 | ✅ PE64(gen2==gen3,Wine) | 🔶 同上 |

---

## ECMAScript 版本支持

| 版本 | 特性 | 状态 |
|------|------|------|
| ES5 | 基础语法、函数、数组、对象、异常处理 | ✅ 完整 |
| ES6 | 箭头函数、类、模板字符串、let/const、解构、展开、for-of | ✅ 大部分 |
| ES7 | Array.includes、指数运算符 | ✅ 完整 |
| ES8 | async/await、Object.entries/values | ✅ async/await |
| ES9 | 异步迭代、对象展开、Promise.finally | 🔶 对象展开/Promise.finally 已支持,异步迭代缺 |
| ES10 | Array.flat、Object.fromEntries、String.trim | 🔶 fromEntries/trim 已支持 |
| ES11 | 可选链 ?.、空值合并 ??、BigInt | ✅ ?./?? |
| ES12 | 逻辑赋值、数字分隔符、Promise.any | ✅ 逻辑赋值/Promise.any |
| ES13 | at() 方法、私有字段 | 🔶 at() |
| ES14+ | 装饰器、迭代器助手 | ❌ 未实现 |

---

## 已实现功能

### 值类型系统
- [x] 类型标签系统 (INT, FLOAT, STRING, BOOLEAN, NULL, UNDEFINED, ARRAY, OBJECT, FUNCTION, DATE, MAP, SET, REGEXP)
- [x] IEEE 754 double 统一表示 (支持 NaN, ±0, ±Infinity)
- [x] typeof/instanceof 运算符
- [x] 统一对象头部结构
- [ ] 隐藏类 (hidden class)

### 数字处理
- [x] 数字分隔符 `1_000_000`
- [x] 十六进制/八进制/二进制 (0x/0o/0b)
- [x] 科学计数法 (e/E)

### 字符串与数组
- [x] 字符串: strlen, strcmp, strcpy, strstr, strcat, strconcat
- [x] 字符串连接运算符 `+` (自动类型转换)
- [x] 字符串方法: toUpperCase, toLowerCase, charAt, charCodeAt, trim, slice, substring, indexOf, concat
- [x] 堆字符串类型头 (TYPE_STRING=6, 16字节头部 + 内容)
- [x] `_getStrContent` 自动识别堆/数据段字符串
- [x] `_str_length` 统一获取字符串长度 (堆: 读 +8, 数据段: strlen)
- [ ] 字符串方法: startsWith, endsWith, includes, repeat, split, replace
- [x] 数组: push, pop, get, set, at, includes, indexOf, slice, length
- [x] 数组动态扩容 (push 超过容量时自动 2x 扩容)
- [x] 数组 indexOf/includes 支持 Number 对象值比较
- [x] 数组布局: [type(8), length(8), capacity(8), elements...]
- [x] TypedArray: Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64Array
  - new TypedArray(length)
  - 元素读写 arr[i], arr[i] = value
  - console.log 打印支持
- [ ] Unicode 感知操作
- [ ] 排序算法 (TimSort)

### 集合类型
- [x] Map: new, set, get, has, delete, clear, size
- [x] Set: add, has, delete, clear, size
- [ ] 哈希表优化 (O(1) 访问)
- [ ] WeakMap/WeakSet

### 日期与正则
- [x] Date.now(), new Date(), getTime()
- [x] Date.toString(), toISOString() (ISO 8601 格式)
- [x] RegExp: new, test() (子字符串匹配)
- [x] getTimezoneOffset() (基础实现)
- [ ] 完整时区处理 (本地时间方法 getHours/getMinutes 等)
- [ ] 正则引擎 (NFA/DFA)

### ES6+ 语法
- [x] 箭头函数
- [x] 无括号单参数箭头函数 `x => x * 2`
- [x] 模板字符串 `` `Hello, ${name}!` `` (多插值、表达式、多行)
- [x] 模板字符串中对象属性多插值 `${obj.prop}`
- [x] 展开语法 `...`
- [x] 可选链 `?.`
- [x] 空值合并 `??`
- [x] 逻辑赋值 `&&=` `||=` `??=`
- [x] 默认参数
- [x] 计算属性名 `{ [expr]: value }`
- [x] for...of / for...in
- [x] 类声明 (class, extends, constructor)
- [ ] 私有字段 `#field`

### 闭包
- [x] 捕获变量分析
- [x] 闭包对象生成 (魔数 0xC105)
- [x] Box 包装共享变量
- [x] 嵌套闭包

### 异步编程 (async/await)
- [x] async 函数声明
- [x] async 箭头函数
- [x] await 表达式
- [x] Promise 基础 (new, then, resolve, reject)
- [x] 协程调度器 (多协程并发)
- [x] try/catch 异步异常处理
- [ ] Promise.all/race/allSettled/any

### 异常处理
- [x] try/catch/finally 语法解析
- [x] 可选 catch 绑定
- [ ] 错误堆栈追踪
- [x] Error 字符串化(#36,2026-07-12):toString/String/拼接/模板/console.log → "name: message"
- [~] Error.cause(未传 options.cause 时 `err.cause === undefined` 已对齐;options.cause 透传押后)

---

## 待实现功能

### P0 - 近期优化
- [x] Date ISO 格式打印 (2026-01-14T05:00:42.588Z)
- [x] Float 打印优化 (14.00000 → 14, 14.13000 → 14.13)
- [x] Number 子类型系统设计 (types.js):
  - NUM_INT8/16/32/64 (有符号整数)
  - NUM_UINT8/16/32/64 (无符号整数)
  - NUM_FLOAT16/32/64 (浮点数, Float64 = 默认)
- [x] TypedArray 完整实现 (8 种类型全部支持)
  - Int8Array, Uint8Array, Int16Array, Uint16Array
  - Int32Array, Uint32Array, Float32Array, Float64Array
- [x] jslib 生成控制 (--no-jslib 参数)
- [x] async/await 支持 (协程调度器 + CPS 变换)

### P1 - 高优先级
- [ ] Symbol 类型
- [ ] 迭代器协议 (@@iterator)
- [ ] Promise 高级组合 (all, race, allSettled, any)
- [ ] JSON.parse/stringify
- [ ] Math 对象方法

### P2 - 中优先级
- [ ] 生成器 (Generator)
- [ ] 异步生成器 (async generator)
- [ ] 私有字段和方法
- [ ] Proxy/Reflect
- [ ] 装饰器
- [ ] 模块系统 (import/export)

### P3 - 优化
- [ ] 常量折叠和传播
- [ ] 无用代码消除 (DCE)
- [ ] 函数内联
- [ ] 内联缓存 (IC)
- [ ] 分代 GC
- [ ] Source Map

---

## 技术实现细节

### 虚拟指令集
```
数据移动: MOV, MOV_IMM, LOAD, STORE
算术运算: ADD, SUB, MUL, DIV, MOD
位运算:   AND, OR, XOR, SHL, SHR, SAR, NOT
比较跳转: CMP, JEQ, JNE, JLT, JLE, JGT, JGE
函数调用: CALL, RET, PROLOGUE, EPILOGUE
浮点运算: FADD, FSUB, FMUL, FDIV, F2I, I2F
```

### 虚拟寄存器
```
通用: V0-V7   (caller-saved;x64 别名:V0=RAX=RET、V1=RCX=A3、V2=RDX=A2)
保存: S0-S5   (callee-saved;arm64 X19-X24;x64 S5 走栈槽)
参数: A0-A5
特殊: RET, FP, SP
```

### 内存布局
```
数组:       [type: 8B][length: 8B][capacity: 8B][elem0: 8B][elem1: 8B]...
TypedArray: [type: 8B][length: 8B][data...]  (元素大小按类型: 1/2/4/8B)
闭包:       [magic: 2B][padding: 6B][func_ptr: 8B][captured...]
Date:       [type: 8B][timestamp: 8B]
RegExp:     [type: 8B][pattern_ptr: 8B][flags: 8B][lastIndex: 8B]
Promise:    [type: 8B][status: 8B][value: 8B][then_handlers: 8B][catch_handlers: 8B][coroutine: 8B]
Coroutine:  [type: 8B][status: 8B][stack_base: 8B][stack_size: 8B][saved_sp: 8B][saved_fp: 8B][saved_lr: 8B][func_ptr: 8B][arg: 8B][result: 8B][next: 8B][promise: 8B][closure_ptr: 8B]
```

### 系统调用
| 功能 | macOS | Linux | Windows |
|------|-------|-------|---------|
| 写入 | write (0x2000004) | write (1) | WriteConsoleA |
| 退出 | exit (0x2000001) | exit (60) | ExitProcess |
| 内存 | mmap (0x20000C5) | mmap (9) | VirtualAlloc |
| 时间 | gettimeofday | clock_gettime | GetSystemTimeAsFileTime |

---

## 开发命令

```bash
# 编译并运行
node cli.js input.js -o output && ./output

# 指定平台
node cli.js input.js -o output --target linux-x64

# 生成动态库
node cli.js input.js -o libout.dylib --shared --export myFunc

# 生成静态库
node cli.js input.js -o libout.a --static
```

---

## 更新日志

### 2026-07(自举后)

- **JSON + Number 精度**(#15 批次3):JSON shim + 注入机制;instanceof/isArray 实现;负浮点 NaN-box 判定双修(typeof/print);_valueToStr/_floatToString 串头三连修(共享缓冲拷出、游标差长度、15 位舍入);print_float 委托 floatToString 单源化。
- **GC 三连**(#19/#11/#20/#21):布局运气毁堆根除(f32.buffer 别名违规);分代 GC 转正缺省(v1.2.0,RSS −30%);span 页模型 S1(mark O(1) 解析);x64 变长移位毁 RCX 全族修复(x64 GC 由来已坏的统一根因)。
- **寄存器分配器阶段 2 定论**(#12):全量块内缓存净负 5-9%(自举簿记税),零成本紧邻 store→load 转发保留;阶段 3 定为每函数 IR 线性扫描。

- **五目标自举定点**(v1.1.0):x64 SysV 内部约定统一、x64 label 分类、PE IAT、path 分隔符、Windows argv;所有非 ARM64 修复按目标门控。
- **性能 6.8×**:自编译 72.3s→10.6s(strconcat 免扫描、_strlen O(1) 头契约、对象属性首字节预滤、模块解析 memoize 3 处 O(n²)、_alloc_large 扫描上限)。
- **GC**:分配统计/阈值/禁用 env 门控;sweep 零 call 化(位图内联+class 查表);分代 GC 基建(box 登记、8 写屏障、minor、影子对照模式)+ Map/Set 全链扫描;**内部指针毁堆根因定位**(GC_DIAG 抓到栈上内部指针→容器未标→sweep 误回收;修复进行中,任务 #19)。
- **stdlib 批次 1/2**:str.at/repeat/toUpperCase/toLowerCase 栈失衡与 dispatch、array lastIndexOf/sort/reverse、fromCharCode、tofixed 等(平台测试驱动,五目标)。
- **工具链**:`jsbin run`(编译→执行→计时)、LABEL_MAP 符号化、GC_DIAG/ALLOC_DBG 诊断、Release CI(tag 触发 5 目标交叉编译发布)。
- **文档**:README 优劣势章节 + 中文版 README.zh-CN.md + docs/ROADMAP.md(四方向规划)。
- **寄存器注**:虚拟寄存器现为 V0-V7 / S0-S5 / A0-A5(旧文档 S0-S3 已过时);x64 别名陷阱(V0=RAX=RET、V1=RCX=A3、V2=RDX=A2)见 BOOTSTRAP_RULES。

### 2026-01-15
- **TypedArray 完整实现**
  - 8 种 TypedArray 类型: Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64Array
  - `new TypedArray(length)` 构造函数
  - 元素读取 `arr[i]` 和写入 `arr[i] = value`
  - console.log 多参数支持 `console.log("label:", typedArray)`
  - 统一的 `_subscript_get/_subscript_set` 处理 Array 和 TypedArray
  - Boxed Number 自动 unbox 到 TypedArray 元素

- **ARM64 后端偏移修复**
  - 修复 STUR/LDUR 指令 9 位有符号偏移限制 (-256 到 +255)
  - 超出范围的偏移使用 ADD/SUB + STR/LDR 组合
  - 修复临时变量累积导致的栈偏移超限 bug

- **console.log 多参数支持**
  - 支持任意数量参数 `console.log(a, b, c, ...)`
  - 参数间自动添加空格分隔
  - `_print_value_no_nl` 处理 Boxed Number (TYPE_NUMBER=13) 和 TypedArray

- **字符串方法修复与完善**
  - `charAt(index)`: 修复浮点索引转整数顺序错误
  - `charCodeAt(index)`: 添加浮点转整数、调用 `_getStrContent`
  - `slice(start, end)`: 修复 `cmpImm` 不支持负数比较问题，使用寄存器比较
  - `_str_charAt` / `_str_charCodeAt`: 调用 `_getStrContent` 获取内容指针

- **字符串连接与模板字符串**
  - 字符串 `+` 运算符: 支持字符串与变量连接、链式连接
  - `_strconcat`: 带类型标记的堆字符串分配
  - `_getStrContent`: 统一处理数据段字符串和堆字符串
  - 模板字符串词法分析: TEMPLATE_HEAD/MIDDLE/TAIL 三种 Token
  - 模板字符串解析: `templateDepth` 跟踪嵌套 `${}`
  - 模板字符串编译: quasis + expressions 交替连接
  - 类型转换: `_intToStr`, `_boolToStr` 用于插值

- **字符串综合测试通过**
  - length 属性 (字符串/数组/字面量)
  - charAt/charCodeAt (数据段和堆字符串)
  - 字符串连接 (+多重连接)
  - toUpperCase/toLowerCase
  - trim (空格/制表符)
  - slice (单参数/双参数)

### 2026-01-15 (晚)

- **TypedArray 继承 Array 方法**
  - `forEach`: 支持 TypedArray 遍历
  - `map`: 支持 TypedArray，返回同类型 TypedArray
  - `filter`: 支持 TypedArray，动态调整结果数组大小
  - `reduce`: 支持 TypedArray，含/不含初始值两种形式

- **Number 打印系统修复**
  - **寄存器别名 Bug**: `VReg.V0/A0/RET` 都映射到 X0
    - `_print_number`: 使用 S1 保存类型，避免被 A0 覆盖
    - `_print_float`: 使用 S2 保存 fcvtzs 结果，避免打印负号时被覆盖
  - **TYPE_NUMBER 类型路由**: TYPE_NUMBER=13 内部存储 float64，需走浮点路径
    - 修正逻辑: type==13 或 type>=28 走浮点，type∈[20,27] 走整数

- **统一类型推断**
  - `inferType()` 对所有数字字面量返回 `Type.NUMBER`
  - 避免 INT64/FLOAT64 与 NUMBER 对象混用导致比较失败

- **TypedArray.length 修复**
  - 返回 Number 对象而非原始整数
  - 添加 SCVTF 指令将整数转换为浮点后装箱

- **f2i 指令添加**
  - VM: `f2i(dest, src)` 从 Number 对象提取整数
  - ARM64: 加载 float64 位 → FMOV → FCVTZS

### 2026-01-14 (下午)
- **async/await 完整实现**
  - 协程调度器 (coroutine.js): 创建、恢复、挂起、返回
  - Promise 运行时 (promise.js): new, then, resolve, reject, _promise_await
  - CPS 变换: async 函数编译为协程，await 编译为 yield + promise 等待
  - async 箭头函数支持
- **Bug 修复**
  - ARM64 addImm/subImm: 修复大立即数 (>4095) 被截断问题
  - 协程栈指针 16 字节对齐: 修复多协程 bus error
  - async 箭头函数解析: 修复 `async () =>` 语法
  - print 作为一等公民: 支持 `promise.then(print)`

### 2026-01-16 (凌晨)

- **严格相等比较 `===` 实现完成**
  - 添加 `generateStrictEq()` 方法到 `runtime/core/coercion.js`
  - 类型检查逻辑:
    - 提取高 16 位检查是否为 float (high16 < 0x7FF8)
    - 如果都是 float，直接比较原始位
    - 如果都是 tagged，比较 tag (high16 & 7)
    - Tag 相同时，比较 payload
  - 添加快速路径: 直接比较原始值，如果相等则返回 true
  - 测试通过: `true === true`, `1 === 1`, `"hello" === "hello"`, `null === null`

- **已知问题**
  - 字符串连接 `"hello" + " world"` 返回空字符串（待修复）

### 2026-01-14
- 运行时生成器命名统一为 `{Type}Generator` 类格式
- 目录重组: runtime/types/ 下每个类型独立目录
- Number 类型包含 IntGenerator 和 FloatGenerator
- 编译器模块拆分 (index.js 1490→552 行)
- 修复: 数组索引浮点转整数、成员赋值、栈破坏

---

*最后更新: 2026-07-10*

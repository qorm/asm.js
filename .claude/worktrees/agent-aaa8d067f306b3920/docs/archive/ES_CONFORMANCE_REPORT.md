> **[归档 2026-07-16]** 本报告是 2026-07-12(v1.4.6→v1.4.11)时点的 ES 符合性检验报告;
> 其定位的核心失败项彼时均已修复,后续状态见 [../ES_SUPPORT.md](../ES_SUPPORT.md) 与 [CHANGELOG.md](../../CHANGELOG.md)。保留仅供回溯。

# JSBin ES 标准符合性检验报告

根据项目需要，我们对 `jsbin` 进行了系统的 **ES 标准符合性检验**（排除了与动态 JIT/引擎库相关的规划功能，例如 `eval`、`new Function` 以及运行时的动态 `import()`）。

> **更新(2026-07-12,v1.4.6→v1.4.11 修复批)**:本报告初版定位的 **§二 三大核心失败已全部修复**,**§三 缺口清单大部分已修**。逐项状态见下方 ✅/⏳ 标注。**里程碑:纯 ES fixture 套件 100% 通过**——`tests/run_fixtures.mjs` 全量 96 PASS / 40 FAIL / 136 TOTAL,其中**全部 40 个失败均为架构性延后**(11 动态 `import()` = L2 引擎库、29 CJS/`node_modules`/包生态 = 方向三 Node 兼容),`es/` 目录 fixtures **零失败**。

---

## 一、 检验概述与总体数据

*(初版数据,历史留存)* 运行测试套件在纯 ES 特性测试中的初版通过率:

*   **ES 测试套(`es` suite)**:初版 **59 PASS / 3 FAIL / 62 TOTAL** → **现 100% 通过**(3 大失败全修 + 新增回归 fixture)。
*   **模块测试套(`modules` suite)**:**15 PASS / 11 FAIL**——11 失败中 8 项动态 `import()` 属 L2 引擎库规划,剔除后 ESM 静态链路 100%。
*   **正确的运行命令**是 `node tests/run_fixtures.mjs`(初版误写 `scripts/run-fixtures.mjs`)。

---

## 二、 ES 测试套（es suite）三大失败项深度剖析

以下是本次检验中发现的 3 个核心失败项，我们定位到了它们在源码中的具体成因，并给出了精准的修复建议。**三项均已修复(2026-07-12,各带回归 fixture,自举定点稳、零回归)。**

### 1. ✅ `es/class-static-block` (类静态块 `static { ... }`) —— **已修(ce0ded97)**
*   **表现**：编译期语法解析错误：`expected (, got THIS`。
*   **标准定义**：ES2022 引入，类静态块在类定义加载时执行，且块内的 `this` 必须指向该类对象。
*   **根本原因**：
    1.  **AST 节点缺失**：[ast.js](file:///Users/dmy/work/jsbin/lang/parser/ast.js) 中未定义 `StaticBlock` 节点类型。
    2.  **解析器处理缺失**：在 [classes.js](file:///Users/dmy/work/jsbin/lang/parser/classes.js#L62-L75) 中，`parseClassMember()` 遇到 `static` 关键字后会调用 `nextToken()`。如果下一个 token 是 `{`，它将无法识别，并尝试将其误判为常规字段，从而导致解析失败。
    3.  **编译器处理缺失**：在 [statements.js](file:///Users/dmy/work/jsbin/compiler/functions/statements.js#L1735) 的类声明编译中，未对 `StaticBlock` 进行收集和发射。
*   **修复建议**：
    *   **AST 扩展**：在 [ast.js](file:///Users/dmy/work/jsbin/lang/parser/ast.js) 的 `NodeType` 中增加 `StaticBlock: "StaticBlock"`，并定义 `export class StaticBlock extends Node { constructor(body) { super(NodeType.StaticBlock); this.body = body; } }`。
    *   **解析器修复**：在 [classes.js](file:///Users/dmy/work/jsbin/lang/parser/classes.js#L68) 增加对静态块的专门判别：
        ```javascript
        if (isStatic && this.curTokenIs(TokenType.LBRACE)) {
            return this.parseStaticBlock();
        }
        ```
        并实现 `parseStaticBlock()` 循环解析语句直到 `RBRACE`。
    *   **编译器修复**：在 [statements.js](file:///Users/dmy/work/jsbin/compiler/functions/statements.js#L1735) 中收集 `StaticBlock` 节点。在类对象创建完毕、静态字段初始化时，临时在当前词法上下文（`this.ctx`）中分配 `__this` 并绑定到类对象，然后依次编译执行 `StaticBlock` 体内的语句，结束后恢复 `__this`。

---

### 2. ✅ `es/error-basic` (Error 字符串化 + `cause`) —— **已修(c84ec913)**
> 实修范围比初版剖析更广:除 `err.cause===undefined`(构造器显式置 undefined 值)外,主修 **Error 字符串化**——`err.toString()`/`String(err)`/`""+err`/`` `${err}` ``/`console.log(err)` 均输出 `"name: message"`(空 message → `"name"`),共享运行时 `_error_to_str`/`_is_jsbin_err`。初版指出的 `_js_undefined` **取地址而非值**(`lea` 后缺 `load`)是通用陷阱,已在相关处修正。
*   **表现**：运行期 `err.cause === undefined` 评估为 `false`（预期为 `true`）。
*   **标准定义**：当未显式提供 `cause` 选项时，Error 实例的 `cause` 属性应该为 `undefined`。
*   **根本原因**：
    *   在 [error/index.js](file:///Users/dmy/work/jsbin/runtime/types/error/index.js#L217-L219) 中，初始化 `cause` 为 `undefined` 时使用了以下汇编生成逻辑：
        ```javascript
        vm.lea(VReg.V0, "_js_undefined");
        vm.store(VReg.S1, 32, VReg.V0);
        ```
        这里将 `_js_undefined` 符号的 **数据段内存地址** 存入了 `cause` 字段，而不是存入 `_js_undefined` 变量中实际保存的值（即 `JS_UNDEFINED = 0x7ffb000000000000n`）。这导致 `err.cause` 变成了指向数据段的野指针。
    *   相同的错误也存在于 `generateErrorNewWithType()` 写入 `cause`（第 296-297 行）以及 `generateErrorNewWithCause()` 写入 `stack`（第 331-332 行）的逻辑中。
    *   此外，在 `_error_to_string` 的第 430-431 行，比较 message 是否为 `undefined` 时，也是直接 cmp 寄存器与 `_js_undefined` 的地址，导致判定恒为 false。
*   **修复建议**：
    *   在 `runtime/types/error/index.js` 的这四处 `vm.lea(reg, "_js_undefined")` 之后，必须立即补上解引用载入指令：
        ```javascript
        vm.load(VReg.V0, VReg.V0, 0); // 取出 undefined 实际的 NaN-boxed 值
        ```

---

### 3. ✅ `es/generated-string-runtime` (`String(x)[i]` 下标得 `undefined`) —— **已修(8f26a99e)**
> 采纳初版建议的**核心刀法**:移除 `members.js` 静态数字下标分支的提前 `_js_unbox`,保持基对象装箱进入 `_subscript_get`,运行时按 0x7FFC 标签正确分派 charAt。初版附带指出的 `mutate.js:_array_shift_empty` 返地址 bug —— 该文件是**死代码**(未接 generate),真正的 shift 缺失,已在**数组变异簇专项**(bfcc9501)用 live 布局重写 `_array_shift`(含空数组返 undefined **值**)一并解决。
*   **表现**：`String(1)[0]` 评估为 `undefined`（预期为 `"1"`），而 `"1"[0]` 可以正确打印 `"1"`。
*   **标准定义**：通过 `String()` 或拼接生成的动态字符串应与字面量字符串一样，支持 `[index]` 下标访问。
*   **根本原因**：
    1.  **静态类型推断不力**：在 [types.js](file:///Users/dmy/work/jsbin/compiler/core/types.js#L315) 中，`inferType()` 未识别 `String(...)` 调用的返回类型，将其归为 `Type.UNKNOWN`。这使得 `String(1)[0]` 的基对象被当作未知类型编译。
    2.  **解箱时机错误**：在 [members.js](file:///Users/dmy/work/jsbin/compiler/expressions/members.js#L365-L375) 的静态数字下标处理中，当基对象类型未知时，编译器生成了以下代码：
        ```javascript
        this.vm.call("_js_unbox"); // 提前将 JSValue unbox 为裸指针
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.movImm(VReg.A1, idx);
        this.vm.call("_subscript_get");
        ```
        由于提前 unbox，传入 `_subscript_get` 的 `A0` 已经丢失了 `0x7FFC`（字符串的 NaN-box 标签）。
    3.  **运行时分派失败**：在运行时 [subscript.js](file:///Users/dmy/work/jsbin/runtime/core/subscript.js#L23-L26) 中，`_subscript_get` 第一步会根据 `A0` 是否带有 `0x7FFC` 标签来分派到 `_str_charAt`。由于传入的 `A0` 已经没有标签，分派逻辑将其误判为常规数组，最终越界读取导致返回 `undefined`。
    4.  **附带缺陷**：在 [mutate.js](file:///Users/dmy/work/jsbin/runtime/types/array/mutate.js#L53) 中，`_array_shift_empty` 返回 `_js_undefined` 符号地址而不是值。
*   **修复建议**：
    *   在 [types.js](file:///Users/dmy/work/jsbin/compiler/core/types.js#L318) 中增加对 `String(...)` 的推断支持，直接返回 `Type.STRING`。
    *   In [members.js](file:///Users/dmy/work/jsbin/compiler/expressions/members.js#L372) 中，**移除** 在静态数字下标分支中对 `_js_unbox` 的提前调用，保持基对象装箱状态进入 `_subscript_get`，让运行时能够正确识别 `0x7FFC` 字符串标签并正确分派。
    *   在 `mutate.js` 中补全对 `_js_undefined` 的 `load` 操作。

---

## 三、 排除引擎库功能后的 ES 标准缺口清单（ES2015 - ES2024）

与主流完整规范相比，JSBin 目前除开 `eval()`、`new Function()` 和动态 `import()` 等已被标记为 L2 引擎库（与静态 AOT 冲突）的非目标功能外，仍存在以下纯 ES 语法/API 缺口。这些项后续应纳入纯 ES 正确性增强路线（ROADMAP E2/E3）：

### 1. ES2015 (ES6) 核心语义缺口
*   ✅ **WeakMap / WeakSet**(**已修 b93d5e3b**):构造 + inferType 路由到 Map/Set,基础操作 set/get/has/delete/add 复用;此前运行崩(退出 1)。偏差:不实际弱引用、`WeakRef`/`FinalizationRegistry` 仍未支持。
*   ⏳ **x64 箭头函数 rest 参数错值**:`(...rest) => {}` 在 x64 上 `rest.length` 恒 `0`(SysV ABI × callee-saved 别名,已立案)。**未修**(x64 后端专项)。
*   ✅ **Map 的 for-of 迭代**(**已修 0c4383b8**):`for(e of m)`/`for([k,v] of m)` 迭代 [k,v] 条目(Map 特判调 `_map_entries` 走数组快路)。
*   ⏳ **原型链内建一致性**:`getPrototypeOf([]) === Array.prototype` 仍 `false`(用户类已对,内建对象原型链装箱不一致)。**未修**(niche edge)。
*   ✅ *(附:数组变异簇 `shift`/`unshift`/`splice` 曾全静默坏——双层死代码——已全修 bfcc9501/3f9958fd/f17b0365)*

### 2. ES2020 核心语义缺口
*   🟡 **NaN 比较**(**部分修 900270c0**):`NaN === NaN`/`!==`/`==` 对**字面量 NaN**(0x7FF0)已修——`_strict_eq` 位相等快路补 `fcmp` 自比较剔除。`Number.isNaN`/全局 `isNaN`(**已修 6b68e14e**,位型检测)对**计算 NaN 亦有效**。**残留**:`(0/0)===(0/0)` 仍误判 true——计算 NaN 位模式 0x7FF8 与装箱 int0 同构(`===` 全位比较无法区分),须**表示层 int0-alias 专项**(高风险)。

### 3. ES2022 / ES2023 / ES2024 边角语法与 API
*   ✅ **`#x in obj` 运算符**(**已修 0e6773c0**):私有字段/方法 brand check;表达式位 `#x` 解析为 name 以 `#` 起的 Identifier,用 `manglePrivateName`→`"#ClassName#x"` 存储键走 `_prop_in`。
*   ⏳ **RegExp `d`/`v` 标志**:`d`(ES2022 索引)/`v`(ES2024 集合运算)未支持。**未修**(正则引擎工程量大)。
*   ✅ **`Array.prototype.toSpliced`**(**已修 e4aa9a0e**):ES2023 非破坏 splice(全拷贝副本+splice+返副本)。
*   ⏳ **Resizable ArrayBuffer**(ES2024):可变大小 buffer 未实现。**未修**。

---

## 四、 剩余工作分类(2026-07-12)

**纯 ES fixture 缺口已清空**(es/ 100%)。剩余按性质分三类:
1. **架构性延后(另立战线,非 ES 缺陷)**:动态 `import()`/`eval`/`new Function`(L2 引擎库)、CJS/`node_modules`/包生态(方向三 Node 兼容)——40 个失败 fixture 全在此。
2. **高风险/大工程专项**:计算 NaN `===`(NaN 表示层 int0-alias)、RegExp `d`/`v` 标志(正则引擎)、x64 箭头 rest(后端 ABI)。
3. **niche edge**:内建原型链一致性、Resizable ArrayBuffer、`WeakRef`/`FinalizationRegistry`。

性能战线基线(2026-07-12,对 node v24):num ~2.7×、prop ~12×、**字符串拼接 ~206×(O(N²) 拷贝界,最大杠杆)**——见 [PERF_PLAN.md](./PERF_PLAN.md)。

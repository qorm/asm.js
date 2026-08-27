// asm.js 编译器 - 语句编译
// 编译各类 JavaScript 语句

import { VReg } from "../../vm/registers.js";
import { Type, inferType, isCompatible, typeName } from "../core/types.js";
import { analyzeSharedVariables, analyzeDirectEvalBoxedVars, collectPatternNames, analyzeCapturedVariables, collectLocalDeclarations, collectDirectFunctionDeclNames, collectVarDeclarations } from "../../lang/analysis/closure.js";

// Box 对象布局：存储被捕获变量的包装对象
// +0: 实际值
const BOX_VALUE_OFFSET = 0;
const BOX_SIZE = 8;

// getter 标记对象类型（与 runtime/core/allocator.js TYPE_GETTER 一致）
const TYPE_GETTER = 60;

// [批次D TDZ] 未初始化绑定哨兵值 —— 与 compiler/index.js 的
// UNINITIALIZED_BINDING_SENTINEL 必须保持一致(emitUninitializedBindingGuard 比对它)
const TDZ_SENTINEL = 0x7ff70000deadbeefn;

// if/while/for 条件融合比较:模块级常量表,勿在 emitTestJumpFalse 内每次 new 数组。
// gen1:短数组 + indexOf 优于 {} 属性查找(动态键线性 _object_get)。
const FUSE_COND_OPS = ["<", "<=", ">", ">=", "===", "!==", "!="];
const REL_OPS_FOR = { "<": 1, "<=": 1, ">": 1, ">=": 1 };

// extends TypedArray/ArrayBuffer:内建无 classinfo,proto 链走 _get_ctor_proto(type@16)。
const TA_SUPER_TAGS = {
    Int8Array: 0x40, Int16Array: 0x41, Int32Array: 0x42, BigInt64Array: 0x43,
    Uint8Array: 0x50, Uint16Array: 0x51, Uint32Array: 0x52, BigUint64Array: 0x53,
    Uint8ClampedArray: 0x54, Float32Array: 0x60, Float64Array: 0x61,
    ArrayBuffer: 0x70,
};
const TA_SUPER_BPE = {
    Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1,
    Int16Array: 2, Uint16Array: 2,
    Int32Array: 4, Uint32Array: 4, Float32Array: 4,
    BigInt64Array: 8, BigUint64Array: 8, Float64Array: 8,
};

// 可作 ClassHeritage 的内建名(与 functions.js BUILTIN_SUPER_NAME_SET 对齐)。
// emitLoadClassInfo 对这些名返 0;类声明处须物化构造器闭包以链接
// Sub.__proto__/Sub.prototype.__proto__。
const BUILTIN_HERITAGE_NAMES = {
    Error: 1, TypeError: 1, RangeError: 1, SyntaxError: 1, ReferenceError: 1,
    EvalError: 1, URIError: 1, AggregateError: 1,
    Array: 1, Object: 1, Function: 1, Boolean: 1, Number: 1, String: 1, Symbol: 1,
    Date: 1, RegExp: 1, Map: 1, Set: 1, WeakMap: 1, WeakSet: 1, Promise: 1,
    DataView: 1, Buffer: 1, BigInt: 1, ArrayBuffer: 1,
    Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 1, Uint16Array: 1,
    Int32Array: 1, Uint32Array: 1, Float32Array: 1, Float64Array: 1,
    BigInt64Array: 1, BigUint64Array: 1,
};

// 语句编译方法混入
export const StatementCompiler = {
    emitUnhandledExceptionExit() {
        this.vm.movImm(VReg.A0, 1);
        if (this.os === "wasi") {
            this.vm.syscall(60); // wasi 号名空间 = linux-x64
        } else if (this.arch === "arm64") {
            this.vm.syscall(this.os === "linux" ? 93 : 1);
        } else {
            this.vm.syscall(this.os === "linux" ? 60 : 0x2000001);
        }
    },

    emitThrowValue(valueReg = VReg.RET) {
        this.vm.push(valueReg);
        this.vm.lea(VReg.V0, "_exception_value");
        this.vm.pop(VReg.V1);
        this.vm.store(VReg.V0, 0, VReg.V1);

        this.vm.lea(VReg.V0, "_exception_pending");
        this.vm.movImm(VReg.V1, 1);
        this.vm.store(VReg.V0, 0, VReg.V1);

        if (this.ctx.exceptionLabel) {
            this.vm.jmp(this.ctx.exceptionLabel);
        } else if (this.ctx.inCoroBody && this.ctx.returnLabel) {
            // [gen unwind] 协程体无本地 try:不可跨栈 _throw_unwind(exc-ctx 帧在调用方栈,
            // unwind 会从协程栈跳回调用方栈中途,scheduler 状态崩)。跳 returnLabel 完成
            // 协程(pending 保留),_generator_next/_generator_throw 在调用方栈上传播。
            this.vm.jmp(this.ctx.returnLabel);
        } else {
            // [#38] 本函数无 try:交给运行时按 catch 上下文链跨函数 unwind
            //（链空时它以退出码 1 结束,与旧行为一致)
            this.vm.call("_throw_unwind");
        }
    },

    // [#38] 恢复异常上下文链头为本 try 帧的 link(= try-enter 时的旧链头)。
    // 幂等:本地 jmp 与 unwind 两种到达方式、以及跨 try 的 return/break/continue
    // 都可安全重复执行。
    emitExcCtxRestore(frameOff) {
        // 用 V2/V3:x64 V0==RET,return 路径此处已算好返回值,不得踩
        this.vm.load(VReg.V3, VReg.FP, frameOff + 0);
        this.vm.lea(VReg.V2, "_exc_ctx_top");
        this.vm.store(VReg.V2, 0, VReg.V3);
    },

    // [iterator-close] abrupt(return/break/continue)跨越协议 for-of 时先 IteratorClose。
    // boundaryLen = 目标处 iterCloseStack.length 快照(见循环/标签登记)。关闭下标
    // >=boundaryLen 的活迭代器并清零槽。同层 unlabeled break 目标为 iterCloseLabel:
    // 登记时 for-of 尚未 push,boundary==登记快照,栈顶下标>=boundary → 会先清零槽,
    // iterCloseLabel 见 0 跳过(不双调 return)。外层 labeled continue 登记时栈更短,
    // 本 for-of push 后下标>=boundary → close。
    // preserveRet:return 路径 RET 已持返回值,_iterator_close 会踩 RET,先存槽后恢复。
    emitPendingIteratorCloses(boundaryLen, preserveRet) {
        const stack = this.ctx.iterCloseStack;
        if (!stack || stack.length === 0) return;
        let needClose = false;
        for (let i = stack.length - 1; i >= boundaryLen; i--) {
            needClose = true;
            break;
        }
        if (!needClose) return;

        let retSlot = 0;
        if (preserveRet) {
            retSlot = this.ctx.getLocal("__itc_retval");
            if (!retSlot) retSlot = this.ctx.allocLocal("__itc_retval");
            this.vm.store(VReg.FP, retSlot, VReg.RET);
        }
        for (let i = stack.length - 1; i >= boundaryLen; i--) {
            const e = stack[i];
            const skipL = this.ctx.newLabel("itc_pending_skip");
            this.vm.load(VReg.V0, VReg.FP, e.slot);
            this.vm.cmpImm(VReg.V0, 0);
            this.vm.jeq(skipL);
            this.vm.load(VReg.A0, VReg.FP, e.slot);
            this.vm.call("_iterator_close");
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, e.slot, VReg.V0);
            this.vm.label(skipL);
        }
        if (preserveRet) {
            this.vm.load(VReg.RET, VReg.FP, retSlot);
        }
    },

    // [#54] abrupt completion(return/break/continue)跨越含 finally 的 try:
    // 跳转前从内到外依次内联编译各被跨越的 finalizer。boundaryLen = 目标边界处的
    // tryFrames 深度(return→0,break→breakTryLen,continue→continueTryLen);仅运行
    // ctx.finallyStack 中 tfIndex>=boundaryLen 的条目(= 词法上在边界内的 finally)。
    // preserveRet:return 路径 RET 已持返回值,finalizer 编译会踩 RET,先存槽后恢复
    //(node 语义:finally 不改 return 值——除非 finalizer 自身 abrupt,彼时其 return
    // 直跳 returnLabel 不回来,天然覆盖)。break/continue 无值,preserveRet=false。
    // finallyStack 为空 / 无跨越条目时零发射,退回 #38 既有路径。
    emitPendingFinalizers(boundaryLen, preserveRet) {
        const fs = this.ctx.finallyStack;
        if (!fs || fs.length === 0) return;
        // 最内层条目都在边界外则无需运行(条目按嵌套顺序,tfIndex 递增)
        if (fs[fs.length - 1].tfIndex < boundaryLen) return;

        let retSlot = 0;
        if (preserveRet) {
            retSlot = this.ctx.getLocal("__finally_retval");
            if (!retSlot) retSlot = this.ctx.allocLocal("__finally_retval");
            this.vm.store(VReg.FP, retSlot, VReg.RET);
        }

        const savedExcLabel = this.ctx.exceptionLabel;
        for (let i = fs.length - 1; i >= 0; i--) {
            const entry = fs[i];
            if (entry.tfIndex < boundaryLen) break;
            // finalizer 内的嵌套 abrupt 只跑更外层 finalizer(不含本身),否则无限内联
            this.ctx.finallyStack = fs.slice(0, i);
            // finalizer 内抛出 → 去本 try 之外的 handler(与 finallyExc 重抛路径一致)
            this.ctx.exceptionLabel = entry.outerExcLabel;
            // 弹本 try 的 exc 帧(链头恢复到 try 外;与既有 finally 路径一致,幂等)
            this.emitExcCtxRestore(entry.frameOff);
            this.compileStatement(entry.finalizer);
        }
        this.ctx.finallyStack = fs;
        this.ctx.exceptionLabel = savedExcLabel;
        if (preserveRet) {
            this.vm.load(VReg.RET, VReg.FP, retSlot);
        }
    },

    // [#54] 直接内联 finalizer(fall-through / catch-exit / finallyExc-重抛前)。
    // 内联前临时弹出本 try 的 finally 条目:其内的 abrupt 只应跑更外层 finally,
    // 不应重跑正在内联的这份自身。本 try 条目恒为 finallyStack 顶(block/catch 体
    // 内的嵌套 try 均已 push/pop 平衡)。
    emitDirectFinalizer(finalizer) {
        const e = this.ctx.finallyStack.pop();
        this.compileStatement(finalizer);
        this.ctx.finallyStack.push(e);
    },

    emitThrowTypeError(message = "not a function") {
        // 抛真正的 TypeError 对象(复用 `new TypeError(msg)` 的构造路径:普通对象
        // {name:"TypeError", message, __asmjs_err}),这样 `catch(e)` 里 `e instanceof
        // TypeError`、`e.name`、`e.message` 才成立(此前抛裸字符串 → instanceof 恒 false,
        // 令一批 "throws TypeError / requires new" 差分测试判负)。
        this.compileExpression({
            type: "NewExpression",
            callee: { type: "Identifier", name: "TypeError" },
            arguments: [{ type: "Literal", value: message }],
        });
        this.emitThrowValue(VReg.RET);
    },

    // [L2-②] 抛真正的 ReferenceError 对象(复用 `new ReferenceError(msg)` 构造路径,
    // 与 emitThrowTypeError 同构)。用于:读取 unresolvable 标识符 / 解构默认值求值
    // 命中 unresolvable 引用 —— 规范 GetValue 对 unresolvable reference 抛
    // ReferenceError;`catch(e)` 里 `e instanceof ReferenceError` 须成立,故不能用
    // _throw_type_error 原语(那抛 TypeError,`assert.throws(ReferenceError,…)` 判负)。
    emitThrowReferenceError(message = "is not defined") {
        this.compileExpression({
            type: "NewExpression",
            callee: { type: "Identifier", name: "ReferenceError" },
            arguments: [{ type: "Literal", value: message }],
        });
        this.emitThrowValue(VReg.RET);
    },

    // 编译语句
    compileStatement(stmt) {
        switch (stmt.type) {
            case "ExpressionStatement":
                this.compileExpression(stmt.expression);
                break;
            case "VariableDeclaration":
                this.compileVariableDeclaration(stmt);
                break;
            case "ReturnStatement":
                this.compileReturnStatement(stmt);
                break;
            case "IfStatement":
                this.compileIfStatement(stmt);
                break;
            case "WhileStatement":
                this.compileWhileStatement(stmt);
                break;
            case "ForStatement":
                this.compileForStatement(stmt);
                break;
            case "BlockStatement":
                this.compileBlockStatement(stmt);
                break;

            case "ForOfStatement":
                this.compileForOfStatement(stmt);
                break;
            case "ForInStatement":
                this.compileForInStatement(stmt);
                break;
            case "DoWhileStatement":
                this.compileDoWhileStatement(stmt);
                break;
            case "WithStatement":
                this.compileWithStatement(stmt);
                break;
            case "BreakStatement":
                this.compileBreakStatement(stmt);
                break;
            case "ContinueStatement":
                this.compileContinueStatement(stmt);
                break;
            case "LabeledStatement":
                this.compileLabeledStatement(stmt);
                break;
            case "SwitchStatement":
                this.compileSwitchStatement(stmt);
                break;
            case "TryStatement":
                this.compileTryStatement(stmt);
                break;
            case "SpawnStatement":
                // [方言] js f(x):协程派发
                this.compileSpawnStatement(stmt);
                break;
            case "ThrowStatement":
                this.compileThrowStatement(stmt);
                break;
            case "FunctionDeclaration":
                // 嵌套函数声明：编译为函数表达式并存储到局部变量
                this.compileNestedFunctionDeclaration(stmt);
                break;
            case "ImportLibDeclaration":
                // 动态库导入声明
                this.compileImportLibDeclaration(stmt);
                break;
            case "ClassDeclaration":
                // 类声明
                this.compileClassDeclaration(stmt);
                break;
            case "ImportDeclaration":
                // 导入声明：在模块初始化时绑定导入的标识符
                this.compileImportDeclaration(stmt);
                break;
            case "EmptyStatement":
                // 空语句，不需要处理
                break;
            case "Identifier":
            case "ObjectExpression":
            case "ArrayExpression":
            case "Literal":
            case "NumericLiteral":
            case "StringLiteral":
            case "BooleanLiteral":
            case "NullLiteral":
            case "MemberExpression":
            case "CallExpression":
            case "BinaryExpression":
            case "LogicalExpression":
            case "UnaryExpression":
            case "UpdateExpression":
            case "AssignmentExpression":
                // 表达式作为语句
                this.compileExpression(stmt);
                break;
            default:
                console.warn("Unhandled statement type:", stmt.type);
        }
    },

    // [批次D TDZ] 块入口哨兵:blockscope.js 标记了"同块内确有词法先于声明的读"
    // 的 let/const(node._tdzNames,已是改名后的唯一名)。在块入口分配槽位并写
    // SENTINEL,声明点写真值,先于声明的读点(Identifier._tdz)发守卫退出。
    // 正常顺序代码 _tdzNames 为空 → 零发射。
    emitTdzBlockPrologue(node) {
        const tdz = node._tdzNames;
        if (!tdz || tdz.length === 0) return;
        for (let i = 0; i < tdz.length; i++) {
            const n = tdz[i];
            // 已预建 box / 模块捕获 box 的槽里是指针,不能用裸哨兵覆盖。
            if (this.ctx.preboxedVars && this.ctx.preboxedVars.has(n)) continue;
            if (this.ctx.getMainCapturedVar && this.ctx.getMainCapturedVar(n)) continue;
            if (this.ctx.boxedVars && this.ctx.boxedVars.has(n) && this.ctx.getLocal(n)) continue;
            let off = this.ctx.getLocal(n);
            if (!off) off = this.ctx.allocLocal(n);
            this.vm.movImm64(VReg.V1, TDZ_SENTINEL);
            this.vm.store(VReg.FP, off, VReg.V1);
        }
    },

    // [L2-②] 判断块是否包含 let/const 声明(TDZ 哨兵位)或 TDZ 名前缀。
    // 纯 var/无声明的块不需要 enterScope/leaveScope——var 按 JS 语义是函数作用域。
    _blockNeedsScope(stmt) {
        if (stmt._tdzNames && stmt._tdzNames.length > 0) return true;
        // 保守扫描:若有 let/const 标记(blockscope 已改名),仍需块作用域。
        for (const s of stmt.body) {
            if (s && s.type === "VariableDeclaration" && (s.kind === "let" || s.kind === "const")) return true;
            if (s && s.type === "ClassDeclaration") return true;
        }
        return false;
    },

    _stmtListHasClass(stmts) {
        if (!stmts) return false;
        for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i];
            if (!s) continue;
            if (s.type === "ClassDeclaration") return true;
            if (s.type === "BlockStatement" && this._stmtListHasClass(s.body)) return true;
            if (s.type === "IfStatement" &&
                (this._stmtListHasClass(s.consequent && s.consequent.body) ||
                    this._stmtListHasClass(s.alternate && s.alternate.body) ||
                    (s.consequent && s.consequent.type === "ClassDeclaration") ||
                    (s.alternate && s.alternate.type === "ClassDeclaration"))) {
                return true;
            }
        }
        return false;
    },

    _switchNeedsClassScope(stmt) {
        const cases = stmt.cases || [];
        for (let i = 0; i < cases.length; i++) {
            if (this._stmtListHasClass(cases[i].consequent)) return true;
        }
        return false;
    },

    // 编译块语句
    compileBlockStatement(stmt) {
        if (this._blockNeedsScope(stmt)) {
            const saved = this.ctx.enterScope();
            this.emitTdzBlockPrologue(stmt);
            for (const s of stmt.body) {
                this.compileStatement(s);
            }
            this.ctx.leaveScope(saved);
        } else {
            // 无 let/const:var 是函数作用域,不创建块作用域,allocLocal 直接落在函数级
            for (const s of stmt.body) {
                this.compileStatement(s);
            }
        }
    },

    // with (obj) stmt:求值 obj 存帧槽,压入 ctx.withScopes(body 内标识符先查其属性),
    // 编译 body 后弹出。编译器不含 with → withScopes 恒空 → 标识符解析逐字节不变。
    compileWithStatement(stmt) {
        this.compileExpression(stmt.object);
        const slot = this.ctx.allocLocal(`__with_obj_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, slot, VReg.RET);
        // [cptn-abrupt-empty] 完成值只来自 body;勿让 binding object 残留 RET(空
        // abrupt/break 时 UpdateEmpty 须得 undefined,而非 [object Object])。
        this.vm.lea(VReg.V0, "_js_undefined");
        this.vm.load(VReg.RET, VReg.V0, 0);
        if (!this.ctx.withScopes) this.ctx.withScopes = [];
        this.ctx.withScopes.push(slot);
        this.compileStatement(stmt.body);
        this.ctx.withScopes.pop();
    },

    // var 初始化器是 PutValue:当前 with 命中则写 binding object,跳过 varEnv。
    // 只看 withScopes(本函数内 with)。嵌套函数自己的 var 是 own 绑定,不走 outerWith。
    // RET 持初始值;命中 jmp doneL,未命中 fallthrough(RET 仍为初值)。无当前 with → null。
    _emitVarInitWithPut(name) {
        const scopes = this.ctx.withScopes;
        if (!scopes || scopes.length === 0) return null;
        const vSlot = this.ctx.allocLocal(`__withvar_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, vSlot, VReg.RET);
        const doneL = this.ctx.newLabel("withvar_done");
        const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
            (this._currentModuleAst && this._currentModuleAst._bsStrict);
        const setHelper = strictSet ? "_object_set_strict" : "_object_set";
        for (let i = scopes.length - 1; i >= 0; i--) {
            const missL = this.ctx.newLabel("withvar_miss");
            const slot = scopes[i];
            this._emitObjectEnvHasBinding(slot, name, missL);
            this.vm.load(VReg.A0, VReg.FP, slot);
            this.emitBoxedStringKey(name, VReg.A1);
            this.vm.load(VReg.A2, VReg.FP, vSlot);
            this.vm.call(setHelper);
            this.vm.load(VReg.RET, VReg.FP, vSlot);
            this.vm.jmp(doneL);
            this.vm.label(missL);
        }
        this.vm.load(VReg.RET, VReg.FP, vSlot);
        return doneL;
    },

    // 编译变量声明
    compileVariableDeclaration(stmt) {
        const kind = stmt.kind; // var, let, const, int

        for (const decl of stmt.declarations) {
            // 解构声明：let {a,b}=obj / let [p,q]=arr。原来只处理 Identifier，
            // 解构被整个忽略 → 变量不绑定读成 0。lexer 用 `let {value,isEnd}=...` 读模板串，
            // 缺此支持 → gen1 编 lexer 崩、模板字面量全崩 → parse index.js(第16成员用模板串)崩。
            if (decl.id.type === "ObjectPattern" || decl.id.type === "ArrayPattern") {
                if (decl.init) this.compileExpression(decl.init);
                else this.vm.movImm(VReg.RET, 0);
                const srcSlot = this.ctx.allocLocal(`__destr_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, srcSlot, VReg.RET);
                // [#47] 递归解构:声明形绑定新局部(mode "decl")。嵌套 pattern 由
                // emitDestructurePattern/emitBindTarget 递归处理。
                this.emitDestructurePattern(decl.id, srcSlot, "decl");
                // [m120] 解构声明绑定完成 → 叶名出 TDZ(同函数体后续读免空哨兵)
                if (this.ctx._tdzClearedLocals) {
                    const names = {};
                    collectPatternNames(decl.id, names);
                    for (const n in names) {
                        if (Object.prototype.hasOwnProperty.call(names, n)) {
                            this.ctx._tdzClearedLocals.add(n);
                        }
                    }
                }
                continue;
            }
            if (decl.id.type === "Identifier") {
                const name = decl.id.name;

                // 推断类型
                let varType = Type.UNKNOWN;
                if (decl.init) {
                    varType = inferType(decl.init, this.ctx);
                    // 记录初始化表达式（用于 MemberExpression 类型推断）
                    this.ctx.varInitExprs[name] = decl.init;
                }

                // var 声明：如果变量已存在，复用它
                // 用 falsy 判定：合法局部偏移恒为负数，故「未分配」⟺ falsy。
                // 自举产物里 getLocal(missing) 返回裸 0（非 undefined），===undefined 判假 →
                // allocLocal 被跳过 → 每个新局部都拿 offset 0 → 全部别名到 FP+0 → 帧损坏栈溢出。
                let offset = this.ctx.getLocal(name);
                if (!offset) {
                    offset = this.ctx.allocLocal(name, varType);
                } else {
                    // 变量已存在，更新类型（但检查兼容性）
                    // 'constructor' 等继承自 Object.prototype 的名字并非真正的先前声明，
                    // 其"既有类型"是内建 Object 构造器 → 用户声明 var constructor 会误报
                    // 不兼容。跳过这些原型继承名的重声明告警(纯 console.warn 噪声,不影响 codegen)。
                    const existingType = this.ctx.getVarType(name);
                    if (existingType !== Type.UNKNOWN && varType !== Type.UNKNOWN &&
                        name !== "constructor" && name !== "hasOwnProperty" &&
                        name !== "toString" && name !== "valueOf") {
                        if (!isCompatible(varType, existingType)) {
                            console.warn(`Type warning: Cannot redeclare '${name}' as ${typeName(varType)}, was ${typeName(existingType)}`);
                        }
                    }
                    if (varType !== Type.UNKNOWN) {
                        this.ctx.setVarType(name, varType);
                    }
                }

                // 递归自引用箭头/函数：const rec = (x)=>...rec()... （functionBodyUsesThis 里的
                // const walk=(node)=>...walk(v)... 即此形）。同 function 声明的处理：预建 box、标
                // boxedVar，让初始化箭头捕获同一 box，编完再把闭包写回 box，体内自引用即得闭包本身。
                // 缺此：箭头捕获的是编译期空槽(值0)→ 体内 rec() 调 0 → 崩/空。命名函数声明有此逻辑，
                // 但 const=arrow 走本路径原先没有 → 递归箭头全崩（gen0/gen1 皆然）。
                // [支柱②] 去虚拟化局部 new 跟踪:`v = new X()` 记类名(X 须已注册);其它初始化清除。
                if (!this.ctx.devirtVarTypes) this.ctx.devirtVarTypes = {};
                if (decl.init && decl.init.type === "NewExpression" && decl.init.callee &&
                    decl.init.callee.type === "Identifier" && this._devirtClasses &&
                    this._devirtClasses[decl.init.callee.name]) {
                    this.ctx.devirtVarTypes[name] = decl.init.callee.name;
                } else {
                    delete this.ctx.devirtVarTypes[name];
                }

                // hasParameterExpressions / static {} 的体 varEnv 与外层同名须隔离,
                // 不得复用 mainCaptured 全局 box(paramsbody-var-open / static-init-scope-var-*)。
                const globalLabel = this.ctx.getMainCapturedVar(name);
                const useMainCapturedBox = globalLabel &&
                    !this.ctx._paramSplitBodyVarEnv && !this.ctx._staticBlockVarEnv;
                const skipScriptGlobalSync = this.ctx._paramSplitBodyVarEnv || this.ctx._staticBlockVarEnv;

                const _initE = decl.init;
                const isRecursiveInit = _initE &&
                    (_initE.type === "ArrowFunctionExpression" || _initE.type === "FunctionExpression") &&
                    this._functionBodyReferencesName(_initE.body, name);
                if (isRecursiveInit) {
                    if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
                    this.ctx.boxedVars.add(name);
                    this.vm.call("_box_alloc");
                    this.vm.movImm(VReg.V1, 0);
                    this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1);
                    this.vm.store(VReg.FP, offset, VReg.RET);
                    this.compileFunctionExpression(_initE);
                    // compileFunctionExpression 已把 offset 更新为捕获时新建的共享 box
                    this.vm.mov(VReg.V1, VReg.RET);
                    this.vm.load(VReg.V2, VReg.FP, offset);
                    this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.V1);
                    this.vm.mov(VReg.RET, VReg.V1);
                    // 若同时被顶层函数捕获，同步写入全局 box
                    const gl = useMainCapturedBox ? this.ctx.getMainCapturedVar(name) : null;
                    if (gl) {
                        this.vm.lea(VReg.V2, gl);
                        this.vm.load(VReg.V2, VReg.V2, 0);
                        this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.V1);
                    }
                    if (this.ctx._tdzClearedLocals) this.ctx._tdzClearedLocals.add(name);
                    continue;
                }

                // 检查这个变量是否需要装箱（会被闭包捕获）
                const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(name);

                // 检测是否为 node builtin 空对象声明（const os = {}）
                // 如果是，立即将堆分配的对象指针存入全局 _builtin_<name>
                // 这样即使变量被 boxed（export），builtin 也能正常工作
                const isBuiltinKnown = name === "os" || name === "process" || name === "buffer";
                const hasBuiltinMap = !!(this._currentModuleAst && this._builtinGlobals && this._builtinGlobals[this._currentModuleAst.filename]);
                const isBuiltinInit = isBuiltinKnown && hasBuiltinMap && decl.init && decl.init.type === "ObjectExpression" && (decl.init.properties || []).length === 0;
                const builtinLabel = isBuiltinInit ? "_builtin_" + name : null;

                // 为 builtin 添加全局标签（如果还没有）
                if (isBuiltinInit && !this._addedBuiltinLabels.has(builtinLabel)) {
                    this.asm.addDataLabel(builtinLabel);
                    this.asm.addDataQword(0);  // 预留 qword 空间
                    this._addedBuiltinLabels.add(builtinLabel);
                }

                if (needsBox) {
                    if (useMainCapturedBox) {
                        // 全局捕获变量：复用在 _main 入口处预分配的 box
                        this.vm.lea(VReg.V2, globalLabel);
                        this.vm.load(VReg.RET, VReg.V2, 0);
                    } else if (this.ctx.preboxedVars && this.ctx.preboxedVars.has(name)) {
                        // [L2-②] 前向引用共享局部:box 已在函数入口预建(compileFunctionBody),
                        // 直接复用既有 box(早期创建的闭包已捕获同一 box 指针)。
                        this.vm.load(VReg.RET, VReg.FP, offset);
                    } else {
                        // 局部捕获变量：正常分配 box
                        this.vm.call("_box_alloc");
                    }

                    // box 指针存储到局部变量
                    this.vm.store(VReg.FP, offset, VReg.RET);

                    if (decl.init) {
                        // 编译初始值
                        this.vm.push(VReg.RET); // 保存 box 指针
                        this.compileExpressionWithType(decl.init, varType);
                        this.vm.pop(VReg.V1); // 恢复 box 指针

                        // 如果是 builtin，立即将堆对象指针存入全局 _builtin_<name>
                        if (isBuiltinInit) {
                            // RET 已经是 boxed value（ptr | TAG），我们需要原始指针
                            // boxed value 格式：(ptr & 0x0000ffffffffffff) | TAG
                            // 提取原始指针: RET = RET & ~TAG
                            this.vm.push(VReg.V1);  // 保存 box 指针
                            this.vm.push(VReg.RET);  // 保存 boxed value
                            this.vm.emitMaskLoad(VReg.V1);
                            this.vm.andMaskReg(VReg.V1, VReg.RET, VReg.V1);  // V1 = 原始指针
                            this.vm.pop(VReg.RET);   // 恢复 boxed value
                            // 存入全局
                            this.vm.lea(VReg.V2, builtinLabel);
                            this.vm.store(VReg.V2, 0, VReg.V1);  // *label = raw_ptr
                            this.vm.pop(VReg.V1);  // 恢复 box 指针
                        }

                        // var 在 with 内:PutValue 命中 binding object 则不写 varEnv box
                        const withDone = (kind === "var") ? this._emitVarInitWithPut(name) : null;
                        this.vm.load(VReg.V1, VReg.FP, offset);
                        this.vm.store(VReg.V1, BOX_VALUE_OFFSET, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                        if (kind === "var" && !skipScriptGlobalSync) this.syncScriptGlobalVar(name, VReg.RET);
                        if (withDone) this.vm.label(withDone);
                    } else {
                        // 无初始化器 → JS_UNDEFINED(与下方非装箱路径一致)。此前装箱路径存
                        // 裸 0:`let x;` 被闭包捕获后读回裸 0,而裸 0 现只代表数值 0.0
                        // (null/undefined 恒 tagged),于是 `x ?? d` 判非 nullish 返 0、
                        // `typeof x` 报 number —— 凡捕获的未初始化 let/var 全错。
                        this.vm.movImm64(VReg.V1, 0x7ffb000000000000n);
                        this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                        if (kind === "var" && !skipScriptGlobalSync) this.syncScriptGlobalVar(name, VReg.V1);
                    }
                    // [m120] 声明点已写值(或 undefined) → 同体后续读免值级哨兵
                    if (this.ctx._tdzClearedLocals) this.ctx._tdzClearedLocals.add(name);
                } else {
                    if (decl.init) {
                        this.compileExpressionWithType(decl.init, varType);

                        // 如果是 builtin，立即将堆对象指针存入全局 _builtin_<name>
                        if (isBuiltinInit) {
                            // 提取原始指针
                            this.vm.push(VReg.RET);
                            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                            this.vm.and(VReg.V1, VReg.RET, VReg.V1);  // V1 = 原始指针
                            this.vm.lea(VReg.V2, builtinLabel);
                            this.vm.store(VReg.V2, 0, VReg.V1);  // *label = raw_ptr
                            this.vm.pop(VReg.RET);
                        }

                        const withDone = (kind === "var") ? this._emitVarInitWithPut(name) : null;
                        this.vm.store(VReg.FP, offset, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                        if (kind === "var" && !skipScriptGlobalSync) this.syncScriptGlobalVar(name, VReg.RET);
                        if (withDone) this.vm.label(withDone);
                    } else {
                        // 未初始化的变量存储 JS_UNDEFINED (0x7FFB000000000000)
                        // 这确保 typeof 和打印操作能正确识别 undefined 值
                        this.vm.movImm64(VReg.V1, 0x7ffb000000000000n); // was lea+load _js const
                        this.vm.store(VReg.FP, offset, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                        if (kind === "var" && !skipScriptGlobalSync) this.syncScriptGlobalVar(name, VReg.V1);
                    }
                    if (this.ctx._tdzClearedLocals) this.ctx._tdzClearedLocals.add(name);
                }
            }
        }
    },

    // [#47/#48] 递归解构核心:把 FP+srcSlot 处的源值按 `pattern` 解构。
    // mode "decl":每个叶子绑定名分配/复用局部并存值(声明形);
    // mode "assign":每个叶子是既有 lvalue(Identifier/成员表达式),赋值(赋值形)。
    // 嵌套 pattern(值/元素位又是 Object/ArrayPattern)递归下降,子值先落临时槽再解构。
    // 非嵌套声明形指令流与原内联版逐字节一致(标签名/临时名/顺序不变),保持自举定点。
    emitDestructurePattern(pattern, srcSlot, mode) {
        // 解构 null/undefined → TypeError(ES:不能解构 null/undefined)。此前对象形静默不抛、
        // 数组形对 null 调 _subscript_get 崩(`const [x]=null` SIGSEGV)。
        {
            const okLabel = this.ctx.newLabel("destr_src_ok");
            const throwLabel = this.ctx.newLabel("destr_null_throw");
            this.vm.load(VReg.V0, VReg.FP, srcSlot);
            this.vm.movImm64(VReg.V1, 0x7ffb000000000000n); // JS_UNDEFINED
            this.vm.cmp(VReg.V0, VReg.V1);
            this.vm.jeq(throwLabel);
            this.vm.movImm64(VReg.V1, 0x7ffa000000000000n); // JS_NULL
            this.vm.cmp(VReg.V0, VReg.V1);
            this.vm.jne(okLabel);
            this.vm.label(throwLabel);
            this.emitThrowTypeError("Cannot destructure 'null' or 'undefined'");
            this.vm.label(okLabel);
        }
        if (pattern.type === "ObjectPattern") {
            const props = pattern.properties || [];
            let restEl = null;
            const excludedKeys = [];
            const excludedComputedSlots = []; // 计算键 {[k]:v,...rest}:键运行时值落 FP 槽,rest 排除时并入
            for (const prop of props) {
                // [rest] {a, ...rest}:rest 延后处理(需先知全部具名键)
                if (prop.type === "SpreadElement") { restEl = prop; continue; }
                // 目标(可为 Identifier / 成员 / 嵌套 pattern)+ 可选默认值
                // (AssignmentPattern:{a=9} / {a:b=9} / {a:{b}={}})
                let targetNode, dflt = null;
                if (prop.value && prop.value.type === "AssignmentPattern") {
                    targetNode = prop.value.left;
                    dflt = prop.value.right;
                } else {
                    targetNode = prop.value;
                }
                if (!targetNode) continue;
                if (prop.computed) {
                    // [C2] 计算键 {[expr]: target}:求值键→_object_get。键落临时槽避免
                    // x64 A 寄存器别名踩踏(compileExpression 会毁 A/RET)。键槽同时并入
                    // rest 排除表(excludedComputedSlots),使 `{[k]:v,...rest}` 的 rest 正确
                    // 排除该运行时键(此前只收静态键 → rest 含被解构的计算键)。
                    // [rest-computed-key] 键经 _js_prop_key 归一(ToPropertyKey):数字键
                    // 1.0 的裸 float 位须转成字符串 "1" 才能命中对象侧存键(计算键 SET 侧
                    // 已归一),且排除表存的也是归一后键 → rest 排除/读键双对齐。
                    this.compileExpression(prop.key);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_prop_key");
                    const ckSlot = this.ctx.allocLocal(`__destrck_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, ckSlot, VReg.RET);
                    excludedComputedSlots.push(ckSlot);
                    this.vm.load(VReg.A0, VReg.FP, srcSlot);
                    this.vm.load(VReg.A1, VReg.FP, ckSlot);
                    this.vm.call("_object_get");
                    // [test262 S1] getter 解包:_object_get 返原始值(含 getter 标记),
                    // 补 _maybe_getter(value=RET, this=源对象)触发访问器。缺失键 raw 0 透传不影响默认值。
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, srcSlot);
                    this.vm.call("_maybe_getter");
                } else {
                    const keyName = prop.key && prop.key.name;
                    if (!keyName) continue;
                    excludedKeys.push(keyName);
                    if (keyName === "constructor") {
                        // [err-ctor 解构] `({constructor} = reason)`/异步拒绝回调形参解构:
                        // __asmjs_err 品牌对象按 name 分派回 memoized 错误构造器闭包
                        // (与 compileMemberExpression 的 .constructor 分支同构),使
                        // constructor === TypeError 成立(assert 族命门)。非品牌对象退回通用读。
                        const cid = this.nextLabelId();
                        const ctorEnd = this.ctx.newLabel("destr_ctor_end");
                        const ctorFb = this.ctx.newLabel("destr_ctor_fb");
                        this.vm.load(VReg.V0, VReg.FP, srcSlot);
                        this.vm.shrImm(VReg.V1, VReg.V0, 48);
                        this.vm.cmpImm(VReg.V1, 0x7FFD);
                        this.vm.jne(ctorFb);
                        this.vm.load(VReg.A0, VReg.FP, srcSlot);
                        this.emitBoxedStringKey("__asmjs_err", VReg.A1);
                        this.vm.call("_object_has");
                        this.vm.cmpImm(VReg.RET, 0);
                        this.vm.jeq(ctorFb);
                        const ctorName = this.ctx.allocLocal(`__dctor_name_${cid}`);
                        this.vm.load(VReg.A0, VReg.FP, srcSlot);
                        this.emitBoxedStringKey("name", VReg.A1);
                        this.vm.call("_object_get");
                        this.vm.store(VReg.FP, ctorName, VReg.RET);
                        const ERR_CTOR_NAMES_L = ["Error", "TypeError", "RangeError", "SyntaxError",
                            "ReferenceError", "EvalError", "URIError"];
                        for (let ei = 0; ei < ERR_CTOR_NAMES_L.length; ei++) {
                            const en = ERR_CTOR_NAMES_L[ei];
                            const ctorNx = this.ctx.newLabel("dctor_nx");
                            this.vm.load(VReg.A0, VReg.FP, ctorName);
                            this.emitBoxedStringKey(en, VReg.A1);
                            this.vm.call("_strict_eq");
                            this.vm.movImm64(VReg.V1, 0x7ff9000000000001n);
                            this.vm.cmp(VReg.RET, VReg.V1);
                            this.vm.jne(ctorNx);
                            this.emitErrorCtorRef(en);
                            this.vm.jmp(ctorEnd);
                            this.vm.label(ctorNx);
                        }
                        this.vm.label(ctorFb);
                        this.vm.load(VReg.A0, VReg.FP, srcSlot);
                        this.emitBoxedStringKey("constructor", VReg.A1);
                        this.vm.call("_object_get");
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.load(VReg.A1, VReg.FP, srcSlot);
                        this.vm.call("_maybe_getter");
                        this.vm.label(ctorEnd);
                    } else {
                        this.vm.load(VReg.A0, VReg.FP, srcSlot);
                        this.emitBoxedStringKey(keyName, VReg.A1);
                        this.vm.call("_object_get");
                        // [test262 S1] getter 解包(同计算键路径)
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.load(VReg.A1, VReg.FP, srcSlot);
                        this.vm.call("_maybe_getter");
                    }
                }
                if (dflt) {
                    // [L2-SameValue] _object_get 已对缺键返回 JS_UNDEFINED(0x7FFB),
                    // 不再以 raw 0 为哨兵。旧 cmpImm(RET,0) 会误把存储的数字 0.0
                    // (raw 全零位)判为"缺失"→触发默认表达式→值塌为 undefined,
                    // 令 ~30 个 dstr 测试 SameValue(undefined,0) 判负。现仅对 tagged
                    // undefined 触发默认,数值 0 正确绑定。
                    const dfltL = this.ctx.newLabel("odestr_dflt");
                    const doneL = this.ctx.newLabel("odestr_done");
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0x7FFB);
                    this.vm.jeq(dfltL);
                    this.emitBindTarget(targetNode, mode);
                    this.vm.jmp(doneL);
                    this.vm.label(dfltL);
                    this.compileExpression(dflt);
                    this._emitDestrSetFnName(dflt, targetNode);
                    this.emitBindTarget(targetNode, mode);
                    this.vm.label(doneL);
                } else {
                    this.emitBindTarget(targetNode, mode);
                }
            }
            // [rest] 排除已取键,余下自有属性成新对象
            if (restEl) {
                const rn = restEl.argument && restEl.argument.name;
                if (rn) {
                    const totalExcl = excludedKeys.length + excludedComputedSlots.length;
                    this.vm.movImm(VReg.A0, totalExcl);
                    this.vm.call("_array_new_with_size");
                    const arrSlot = this.ctx.allocLocal(`__restexc_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, arrSlot, VReg.RET);
                    for (let ki = 0; ki < excludedKeys.length; ki++) {
                        this.vm.load(VReg.A0, VReg.FP, arrSlot);
                        this.vm.movImm(VReg.A1, ki);
                        this.emitBoxedStringKey(excludedKeys[ki], VReg.A2);
                        this.vm.call("_array_set");
                    }
                    // 计算键运行时值并入排除表(接在静态键之后)
                    for (let ci = 0; ci < excludedComputedSlots.length; ci++) {
                        this.vm.load(VReg.A0, VReg.FP, arrSlot);
                        this.vm.movImm(VReg.A1, excludedKeys.length + ci);
                        this.vm.load(VReg.A2, VReg.FP, excludedComputedSlots[ci]);
                        this.vm.call("_array_set");
                    }
                    this.vm.load(VReg.A0, VReg.FP, srcSlot);
                    this.vm.load(VReg.A1, VReg.FP, arrSlot);
                    this.vm.call("_object_rest");
                    // rest 目标恒是 Identifier;经绑定路径统一(声明形分配/赋值形写既有槽)
                    this.emitBindTarget(restEl.argument, mode);
                }
            }
            return;
        }
        // ArrayPattern
        // [iter] 非数组/字符串的可迭代源(Set/Map/生成器/自定义 [Symbol.iterator] 对象)先
        // _array_spread_into 展开成数组,使下方 _subscript_get(arr,i)/rest slice 按迭代协议
        // 取元素。此前当数组下标读 → 垃圾/undefined(`let [a,b]=set` 读乱值根因)。仅对装箱
        // 对象(0x7FFD)与未装箱堆指针(high16==0 且 >=0x100200000,即 Set/Map/生成器)施加;
        // 字符串(0x7FFC)/数字/bool(高16 非上述)不动。装箱数组(0x7FFE)亦走 GetIterator
        // (覆盖 Array.prototype[@@iterator]);物化结果写入 readSlot,**不**覆写 srcSlot
        // (赋值形 `result=[x]=vals` 须 SameValue(result,vals))。
        const els = pattern.elements || [];
        const readSlot = this.ctx.allocLocal(`__destr_read_${this.nextLabelId()}`);
        {
            // 默认读源=原 src;spread 路径再覆写 readSlot
            this.vm.load(VReg.V0, VReg.FP, srcSlot);
            this.vm.store(VReg.FP, readSlot, VReg.V0);
            const els0 = els.length === 0;
            const iterSpreadL = this.ctx.newLabel("destr_iter_spread");
            const iterSpreadBoxed = this.ctx.newLabel("destr_iter_spread_boxed");
            const iterSkipL = this.ctx.newLabel("destr_iter_skip");
            const iterableOkL = this.ctx.newLabel("destr_iterable_ok");
            const iterPrimThrow = this.ctx.newLabel("destr_iter_prim_throw");
            const iterArrTryL = this.ctx.newLabel("destr_iter_arr_try");
            const iterArrBareTryL = this.ctx.newLabel("destr_iter_arr_bare_try");
            this.vm.load(VReg.V0, VReg.FP, srcSlot);
            this.vm.shrImm(VReg.V1, VReg.V0, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFD);
            this.vm.jeq(iterSpreadBoxed);    // 装箱对象 → 先检可迭代性,再展开
            this.vm.cmpImm(VReg.V1, 0x7FFE);
            // 装箱数组:先物化 Array.prototype(惰性槽),再走 GetIterator——尊重覆盖的
            // Array.prototype[Symbol.iterator](ary-ptrn-elem-id-iter-val-array-prototype)。
            // 裸 TYPE_ARRAY 仍走下标(Map 对等)。
            this.vm.jeq(iterArrTryL);
            this.vm.cmpImm(VReg.V1, 0x7FFC);
            this.vm.jeq(iterSkipL);          // 字符串(可 charAt 读)
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(iterPrimThrow);      // [L2-②] 数字/bool/symbol/null/undefined 等
            // 非指针值不可迭代:规范 array pattern 的源必须是 iterable,`[a]=5`/`[,]=true`
            // 须抛 TypeError(此前静默下标读 → 得 undefined,`array-elision-val-*` 等判负)。
            this.vm.movImm64(VReg.V1, this.os === "wasi" ? 0x8000000n : 0x100200000n);
            this.vm.cmp(VReg.V0, VReg.V1);
            this.vm.jlt(iterPrimThrow);      // 小于堆区下界(小整数/浮点位)→ 非指针,抛
            // 未装箱堆指针:类型字节 TYPE_ARRAY(1) 的裸数组(如 Map 展开产的 [k,v] 对)
            // 仍走下标路径(不 spread——否则 `[[k,v]]=map` 内层对裸数组对再 spread → 空/崩),
            // 但先做与装箱路径同判据的 GetIterator 可调用性守卫:delete
            // Array.prototype[Symbol.iterator] 后 `[a,b]=[1,2]` 须抛 TypeError
            // (ary-init-iter-get-err-array-prototype 族)。
            this.vm.loadByte(VReg.V1, VReg.V0, 0);
            this.vm.cmpImm(VReg.V1, 1);
            this.vm.jeq(iterArrBareTryL);
            // 未装箱堆指针(Set/Map/生成器等)直接展开,runtime _array_spread_into 按
            // type 字节分派(Set/Map 链表遍历;生成器走 Symbol.iterator 协议)。
            // [空 pattern `[]`] 只验可迭代、不消费迭代器(规范 ArrayBindingPattern:[] →
            // 不调用 IteratorStep;V8 对不可迭代源仍抛 TypeError)。生成器/Set/Map 裸指针
            // 按构造即可迭代 → 直接跳过展开,保持迭代器未被推进。
            if (els0) {
                this.vm.jmp(iterSkipL);
            } else {
                this.vm.jmp(iterSpreadL);
            }
            // [L2-②] 非指针/非数组/非字符串源(数字/bool/symbol/null/undefined 等)→ 非可迭代
            // 源,抛 TypeError(与装箱对象非可迭代同一守卫,规范一致)。
            this.vm.label(iterPrimThrow);
            this.emitThrowTypeError("Cannot destructure non-iterable value");
            // 装箱数组:物化 Array.prototype 后复用可迭代展开路(默认 values / 覆盖 @@iterator)
            this.vm.label(iterArrTryL);
            if (this.emitArrayProtoObject) {
                this.emitArrayProtoObject(); // RET=proto;随后重载 src
            }
            this.vm.jmp(iterSpreadBoxed);
            // 裸数组:物化 Array.prototype 后做与装箱路径同判据的可迭代性守卫,通过则走
            // 下标快路(readSlot 已存裸数组)。
            this.vm.label(iterArrBareTryL);
            if (this.emitArrayProtoObject) {
                this.emitArrayProtoObject();
            }
            this.vm.load(VReg.A0, VReg.FP, srcSlot);
            this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
            this.vm.call("_object_get");
            this.vm.shrImm(VReg.V0, VReg.RET, 48);
            this.vm.cmpImm(VReg.V0, 0x7FFF); // Symbol.iterator 须是函数(tag 0x7FFF)
            this.vm.jeq(iterSkipL);
            this.emitThrowTypeError("Cannot destructure non-iterable value");
            // [Cluster 7] 装箱对象可迭代性守卫:ES 规范要求 destructuring array pattern
            // 的源是可迭代对象;非可迭代源(如 plain `{}`)须抛 TypeError。
            this.vm.label(iterSpreadBoxed);
            this.vm.load(VReg.A0, VReg.FP, srcSlot);
            this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
            this.vm.call("_object_get");
            this.vm.shrImm(VReg.V0, VReg.RET, 48);
            this.vm.cmpImm(VReg.V0, 0x7FFF); // Symbol.iterator 须是函数(tag 0x7FFF)
            this.vm.jeq(iterableOkL);
            this.emitThrowTypeError("Cannot destructure non-iterable value");
            this.vm.label(iterableOkL);
            // [L1 IteratorClose] 赋值形阵列解构:规范先 GetIterator,再求各 AssignmentElement
            // 的 LeftHandSideExpression,再 IteratorStep。eager spread 会先 next 再求 LRef
            // → thrw-close 类 nextCount=1/returnCount=0。此处对含 MemberExpression 目标
            // 的 assign 模式:GetIterator 后先求 LRef(exceptionLabel→close 再抛),成功则
            // close 未消费的迭代器并落入下方 spread(再 GetIterator 取元素)。
            if (mode === "assign" && !els0) {
                // 仅当 LRef 求值本身可能抛/有副作用时才发 early 路径(try 帧税)。
                // `x.y` / `x["k"]` 求 LRef 不抛,eager spread 后再 bind 即可。
                const lrefNeedsEarly = (tn) => {
                    if (!tn) return false;
                    if (tn.type === "CallExpression") return true;
                    if (tn.type !== "MemberExpression") return false;
                    if (!tn.object || tn.object.type !== "Identifier") return true;
                    if (tn.computed && tn.property &&
                        tn.property.type !== "Identifier" &&
                        tn.property.type !== "Literal") return true;
                    return false;
                };
                let needsEarlyLRef = false;
                for (let ei = 0; ei < els.length; ei++) {
                    const el = els[ei];
                    if (!el) continue;
                    if (el.type === "SpreadElement" || el.type === "RestElement") {
                        if (lrefNeedsEarly(el.argument)) { needsEarlyLRef = true; break; }
                        continue;
                    }
                    const tn = el.type === "AssignmentPattern" ? el.left : el;
                    if (lrefNeedsEarly(tn)) { needsEarlyLRef = true; break; }
                }
                if (needsEarlyLRef) {
                    const earlyIterSlot = this.ctx.allocLocal(`__destr_early_it_${this.nextLabelId()}`);
                    const earlyDoneL = this.ctx.newLabel("destr_early_lref_done");
                    // GetIterator(src) → earlyIterSlot
                    this.vm.load(VReg.A0, VReg.FP, srcSlot);
                    this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
                    this.vm.call("_object_get");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, srcSlot);
                    this.vm.call("_maybe_getter");
                    this.vm.mov(VReg.V6, VReg.RET);
                    this.vm.shrImm(VReg.V0, VReg.V6, 48);
                    this.vm.cmpImm(VReg.V0, 0x7fff);
                    this.vm.jne(earlyDoneL);
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V6, VReg.V6, VReg.V1);
                    this.vm.load(VReg.V0, VReg.V6, 0);
                    this.vm.movImm(VReg.V1, 0xc105);
                    this.vm.cmp(VReg.V0, VReg.V1);
                    const earlyBareL = this.ctx.newLabel("destr_early_itbare");
                    this.vm.jne(earlyBareL);
                    this.vm.mov(VReg.S0, VReg.V6);
                    this.vm.load(VReg.V6, VReg.V6, 8);
                    const earlyDoL = this.ctx.newLabel("destr_early_itdo");
                    this.vm.jmp(earlyDoL);
                    this.vm.label(earlyBareL);
                    this.vm.movImm(VReg.S0, 0);
                    this.vm.label(earlyDoL);
                    this.vm.load(VReg.A5, VReg.FP, srcSlot);
                    this.vm.callIndirect(VReg.V6);
                    this.vm.store(VReg.FP, earlyIterSlot, VReg.RET);

                    // 真 try 帧:thrower() 在被调函数内 _throw_unwind,仅改 exceptionLabel 拦不住。
                    if (this.vm._recN >= 0) this.vm._flushRecordVerbatim();
                    let earlyExcOff = 0;
                    for (let fi = 0; fi < 10; fi++) {
                        earlyExcOff = this.ctx.allocLocal(this.ctx.newLabel("__destr_early_exc"));
                    }
                    if (!this.ctx.tryFrames) this.ctx.tryFrames = [];
                    this.ctx.tryFrames.push(earlyExcOff);
                    const closeRethrowL = this.ctx.newLabel("destr_early_close_rethrow");
                    const savedExc = this.ctx.exceptionLabel;
                    this.vm.lea(VReg.V0, "_exc_ctx_top");
                    this.vm.load(VReg.V1, VReg.V0, 0);
                    this.vm.store(VReg.FP, earlyExcOff + 0, VReg.V1);
                    this.vm.lea(VReg.V1, closeRethrowL);
                    this.vm.store(VReg.FP, earlyExcOff + 8, VReg.V1);
                    this.vm.mov(VReg.V1, VReg.SP);
                    this.vm.store(VReg.FP, earlyExcOff + 16, VReg.V1);
                    this.vm.store(VReg.FP, earlyExcOff + 24, VReg.FP);
                    this.vm.store(VReg.FP, earlyExcOff + 32, VReg.S0);
                    this.vm.store(VReg.FP, earlyExcOff + 40, VReg.S1);
                    this.vm.store(VReg.FP, earlyExcOff + 48, VReg.S2);
                    this.vm.store(VReg.FP, earlyExcOff + 56, VReg.S3);
                    this.vm.store(VReg.FP, earlyExcOff + 64, VReg.S4);
                    this.vm.mov(VReg.V1, VReg.S5);
                    this.vm.store(VReg.FP, earlyExcOff + 72, VReg.V1);
                    this.vm.subImm(VReg.V1, VReg.FP, -earlyExcOff);
                    this.vm.store(VReg.V0, 0, VReg.V1);
                    this.ctx.exceptionLabel = closeRethrowL;

                    for (let ei = 0; ei < els.length; ei++) {
                        const el = els[ei];
                        if (!el) continue;
                        let tn = null;
                        if (el.type === "SpreadElement" || el.type === "RestElement") {
                            tn = el.argument;
                        } else {
                            tn = el.type === "AssignmentPattern" ? el.left : el;
                        }
                        if (!tn || tn.type !== "MemberExpression") continue;
                        this.compileExpression(tn.object);
                        if (tn.computed && tn.property) {
                            this.compileExpression(tn.property);
                        }
                    }
                    // LRef 成功:弹帧。不 close——下方 spread 再 GetIterator 取元素。
                    // (若此处 close 再 spread,同一 iterator 工厂复用已 return 的对象 → 元素丢。)
                    this.ctx.exceptionLabel = savedExc;
                    this.emitExcCtxRestore(earlyExcOff);
                    this.ctx.tryFrames.pop();
                    this.vm.jmp(earlyDoneL);

                    this.vm.label(closeRethrowL);
                    this.emitExcCtxRestore(earlyExcOff);
                    this.ctx.tryFrames.pop();
                    this.ctx.exceptionLabel = savedExc;
                    // 保存原异常;close 时 return() 可能再抛(thrw-close-err)——规范要求
                    // completion 已是 throw 时丢弃 innerResult,保留原异常。
                    const origExcSlot = this.ctx.allocLocal(`__destr_early_origexc_${this.nextLabelId()}`);
                    this.vm.lea(VReg.V0, "_exception_value");
                    this.vm.load(VReg.V1, VReg.V0, 0);
                    this.vm.store(VReg.FP, origExcSlot, VReg.V1);
                    const suppressCatchL = this.ctx.newLabel("destr_early_suppress");
                    const rethrowOrigL = this.ctx.newLabel("destr_early_rethrow");
                    let suppressExcOff = 0;
                    for (let fi = 0; fi < 10; fi++) {
                        suppressExcOff = this.ctx.allocLocal(this.ctx.newLabel("__destr_early_sup"));
                    }
                    this.ctx.tryFrames.push(suppressExcOff);
                    this.vm.lea(VReg.V0, "_exc_ctx_top");
                    this.vm.load(VReg.V1, VReg.V0, 0);
                    this.vm.store(VReg.FP, suppressExcOff + 0, VReg.V1);
                    this.vm.lea(VReg.V1, suppressCatchL);
                    this.vm.store(VReg.FP, suppressExcOff + 8, VReg.V1);
                    this.vm.mov(VReg.V1, VReg.SP);
                    this.vm.store(VReg.FP, suppressExcOff + 16, VReg.V1);
                    this.vm.store(VReg.FP, suppressExcOff + 24, VReg.FP);
                    this.vm.store(VReg.FP, suppressExcOff + 32, VReg.S0);
                    this.vm.store(VReg.FP, suppressExcOff + 40, VReg.S1);
                    this.vm.store(VReg.FP, suppressExcOff + 48, VReg.S2);
                    this.vm.store(VReg.FP, suppressExcOff + 56, VReg.S3);
                    this.vm.store(VReg.FP, suppressExcOff + 64, VReg.S4);
                    this.vm.mov(VReg.V1, VReg.S5);
                    this.vm.store(VReg.FP, suppressExcOff + 72, VReg.V1);
                    this.vm.subImm(VReg.V1, VReg.FP, -suppressExcOff);
                    this.vm.store(VReg.V0, 0, VReg.V1);
                    this.ctx.exceptionLabel = suppressCatchL;
                    this.vm.load(VReg.A0, VReg.FP, earlyIterSlot);
                    this.vm.call("_iterator_close");
                    this.emitExcCtxRestore(suppressExcOff);
                    this.ctx.tryFrames.pop();
                    this.vm.jmp(rethrowOrigL);
                    this.vm.label(suppressCatchL);
                    this.emitExcCtxRestore(suppressExcOff);
                    this.ctx.tryFrames.pop();
                    this.vm.label(rethrowOrigL);
                    this.ctx.exceptionLabel = savedExc;
                    this.vm.load(VReg.V1, VReg.FP, origExcSlot);
                    this.vm.lea(VReg.V0, "_exception_value");
                    this.vm.store(VReg.V0, 0, VReg.V1);
                    this.vm.lea(VReg.V0, "_exception_pending");
                    this.vm.movImm(VReg.V1, 1);
                    this.vm.store(VReg.V0, 0, VReg.V1);
                    this.vm.call("_throw_unwind");
                    this.vm.label(earlyDoneL);
                }
            }
            // 空 pattern `[]`:GetIterator + IteratorClose(不 next)——规范 ArrayBindingPattern:[]。
            if (els0) {
                this.vm.load(VReg.A0, VReg.FP, srcSlot);
                this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
                this.vm.call("_object_get");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.load(VReg.A1, VReg.FP, srcSlot);
                this.vm.call("_maybe_getter"); // RET = iterator 方法
                // Call(iteratorMethod, src, «»)
                this.vm.mov(VReg.V6, VReg.RET);
                this.vm.shrImm(VReg.V0, VReg.V6, 48);
                this.vm.cmpImm(VReg.V0, 0x7fff);
                this.vm.jne(iterSkipL); // 非函数:上方已守卫,保守跳过
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V6, VReg.V6, VReg.V1);
                this.vm.load(VReg.V0, VReg.V6, 0); // magic
                this.vm.movImm(VReg.V1, 0xc105);
                this.vm.cmp(VReg.V0, VReg.V1);
                const itBareL = this.ctx.newLabel("destr_empty_itbare");
                this.vm.jne(itBareL);
                this.vm.mov(VReg.S0, VReg.V6);
                this.vm.load(VReg.V6, VReg.V6, 8);
                const itDoL = this.ctx.newLabel("destr_empty_itdo");
                this.vm.jmp(itDoL);
                this.vm.label(itBareL);
                this.vm.movImm(VReg.S0, 0);
                this.vm.label(itDoL);
                this.vm.load(VReg.A5, VReg.FP, srcSlot); // this = iterable
                this.vm.callIndirect(VReg.V6); // RET = iterator
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_iterator_close");
                this.vm.jmp(iterSkipL);
            }
            this.vm.label(iterSpreadL);
            this.vm.movImm(VReg.A0, 0);
            this.vm.call("_array_new_with_size");
            this.vm.call("_box_arr_r"); // box->helper
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.load(VReg.A1, VReg.FP, srcSlot);
            // 无 rest:限量取 els.length 并 IteratorClose(防无限迭代器超时 + 规范 close)。
            // 有 rest:抽干(rest 消费剩余 → done)。
            let hasRest = false;
            for (let ri = 0; ri < els.length; ri++) {
                if (els[ri] && els[ri].type === "SpreadElement") { hasRest = true; break; }
            }
            if (!hasRest && els.length > 0) {
                this.vm.movImm(VReg.A2, els.length);
                this.vm.call("_array_spread_into_n");
            } else {
                this.vm.call("_array_spread_into");
            }
            // 物化写入 readSlot,保留 srcSlot=RHS 原引用
            this.vm.store(VReg.FP, readSlot, VReg.RET);
            this.vm.label(iterSkipL);
        }
        for (let ei = 0; ei < els.length; ei++) {
            const el = els[ei];
            if (!el) continue;
            // [#34] rest:[..., ...rest] → slice(ei) 余下成新数组
            if (el.type === "SpreadElement") {
                const rn = el.argument && el.argument.name;
                if (!el.argument) continue;   // [test262 S1] 允许 pattern rest 目标([...[x]]);emitBindTarget 递归解构
                this.vm.load(VReg.A0, VReg.FP, readSlot);
                this.vm.call("_js_unbox");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, ei);
                this.vm.movImm(VReg.A2, 2147483647);
                this.vm.call("_array_slice");
                this.vm.call("_box_arr_r"); // box->helper
                this.emitBindTarget(el.argument, mode);
                break; // rest 必须在末位
            }
            // [#34] 默认值:AssignmentPattern —— 取值为 raw 0(越界/undefined
            // 约定)或 tagged undefined 时用默认表达式
            let targetNode, dflt = null;
            if (el.type === "AssignmentPattern") {
                targetNode = el.left;
                dflt = el.right;
            } else {
                targetNode = el;
            }
            if (!targetNode) continue;
            // A0 保持装箱(勿提前 _js_unbox):_subscript_get 靠 0x7FFC 标签分派字符串
            // charAt(数组/对象内部自 unbox)。提前 unbox 剥掉标签 → 字符串解构
            // `[a,b]="qux"` 被误判数组越界读 0(members.js 同类坑)。
            this.vm.load(VReg.A0, VReg.FP, readSlot);
            this.vm.movImm(VReg.A1, ei);
            this.vm.call("_subscript_get");
            if (dflt) {
                // [L2-SameValue] _subscript_get 已对越界元素返回 JS_UNDEFINED(0x7FFB),
                // 不再以 raw 0 为哨兵。旧 cmpImm(RET,0) 会误把存储的数字 0.0
                // (raw 全零位)判为"缺失"→触发默认表达式→值塌为 undefined,
                // 令 ~30 个 dstr 测试 SameValue(undefined,0) 判负。现仅对 tagged
                // undefined 触发默认,数值 0 正确绑定。
                const dfltL = this.ctx.newLabel("destr_dflt");
                const doneL = this.ctx.newLabel("destr_done");
                this.vm.shrImm(VReg.V1, VReg.RET, 48);
                this.vm.cmpImm(VReg.V1, 0x7FFB); // tagged undefined
                this.vm.jeq(dfltL);
                this.emitBindTarget(targetNode, mode);
                this.vm.jmp(doneL);
                this.vm.label(dfltL);
                this.compileExpression(dflt);
                this._emitDestrSetFnName(dflt, targetNode);
                this.emitBindTarget(targetNode, mode);
                this.vm.label(doneL);
            } else {
                this.emitBindTarget(targetNode, mode);
            }
        }
    },

    // [#47/#48] 绑定单个解构目标(约定:当前值已在 RET)。
    // 嵌套 pattern → 先落临时槽再递归;否则按 mode 分派到声明绑定/赋值。
    // [L2-SameValue fn-name] 解构默认值若为匿名函数/类表达式,按 ES 规范
    // SetFunctionName 把 .name 设为绑定标识符名。此前缺失 → ~24 个 dstr 测试
    // `cls.name===""` 而非 `"cls"` (SameValue("","cls") 判负)。
    _emitDestrSetFnName(dflt, targetNode) {
        if (!dflt || !targetNode || targetNode.type !== "Identifier" || !targetNode.name) return;
        // [for-of const/let] 块级改名(`arrow$blk$N`)后的绑定名须还原用户原名作为
        // .name(SetFunctionName 用源码名;ES 中 fn.name 恒为用户可见名,与内部绑定名无关)。
        // 此前把改名后名整体装箱 → for-of `const [arrow = () => {}]` 得 "arrow$blk$4"。
        const bindingName = targetNode.name;
        const blkCut = bindingName.indexOf("$blk$");
        const useName = blkCut > 0 ? bindingName.slice(0, blkCut) : bindingName;
        let isAnon = false;
        if (dflt.type === "ArrowFunctionExpression") {
            isAnon = true;
        } else if (dflt.type === "FunctionExpression") {
            isAnon = !dflt.id || !dflt.id.name;
        } else if (dflt.type === "ClassExpression" || dflt.type === "ClassDeclaration") {
            const rawId = (dflt.id && dflt.id.name) || "";
            isAnon = !rawId || rawId.indexOf("__classexpr") === 0;
            // ES SetFunctionName: class { static name() {} } 已有显式 name 静态方法,
            // SetFunctionName 不覆盖(规范 IsSimpleParameterList 路径仍按 hasOwnProperty
            // 守卫跳过)。此处 AST 级预判:存在 static name 方法 → 跳过。
            if (isAnon && dflt.body && Array.isArray(dflt.body)) {
                for (const m of dflt.body) {
                    if (m && m.static && m.key && (m.key.name === "name" || m.key.value === "name")) {
                        isAnon = false;
                        break;
                    }
                }
            }
        }
        if (!isAnon) return;
        const vm = this.vm;
        // 保存函数/类值到临时槽;后续 _js_box_string / emitBoxedStringKey 均毁 A0
        const tmpSlot = this.ctx.allocLocal(`__destrfnname_${this.nextLabelId()}`);
        vm.store(VReg.FP, tmpSlot, VReg.RET);
        // A2 = boxed 绑定名串(同 compileClassDeclaration 的 classNameForMeta 装箱路径)
        vm.lea(VReg.A0, this.asm.addString(useName));
        vm.call("_js_box_string");
        vm.mov(VReg.A2, VReg.RET);
        // A1 = boxed "name" 键
        this.emitBoxedStringKey("name", VReg.A1);
        // A0 = 函数/类对象(从临时槽恢复;emitBoxedStringKey 用 A0 调 addString,已毁)
        vm.load(VReg.A0, VReg.FP, tmpSlot);
        // _object_define 可写 classinfo 对象属性表(_closure_prop_set 只写闭包侧表,
        // classinfo 的 .name 经 _object_get 查找 → 达不到 → cls.name 仍为空串)
        vm.call("_object_define");
        // [class 默认值] 类表达式经 SetFunctionName 落 .name 后须按类规范补属性位:
        // {writable:false,enumerable:false,configurable:true}=attr 4(镜像
        // compileClassDeclaration 的 name 落位)。否则 verifyProperty 报
        // "name descriptor should not be enumerable/…configurable"。
        // [coro] 生成器/async-gen 协程体暂跳过:协程帧上 _object_set_prop_attr 对
        // 解构默认类会 SIGSEGV(async-gen dstr fn-name-class 族)——跳过仅影响该类
        // 默认类的 name 描述符(3 测试),避免 CRASH。
        if (false && (dflt.type === "ClassExpression" || dflt.type === "ClassDeclaration") &&
            !this.ctx.inCoroBody) {
            vm.load(VReg.A0, VReg.FP, tmpSlot);
            this.emitBoxedStringKey("name", VReg.A1);
            vm.movImm(VReg.A2, 4);
            vm.call("_object_set_prop_attr");
        }
        // 恢复 RET 为函数/类值
        vm.load(VReg.RET, VReg.FP, tmpSlot);
    },

    emitBindTarget(targetNode, mode) {
        if (targetNode.type === "ObjectPattern" || targetNode.type === "ArrayPattern") {
            const subSlot = this.ctx.allocLocal(`__destr_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, subSlot, VReg.RET);
            this.emitDestructurePattern(targetNode, subSlot, mode);
            return;
        }
        if (mode === "assign") {
            this.emitDestructureAssign(targetNode);
            return;
        }
        // mode "decl":叶子必是 Identifier(绑定名,可能已被块级改名)
        const name = targetNode.name;
        if (!name) return;
        let off = this.ctx.getLocal(name);
        if (!off) off = this.ctx.allocLocal(name);
        this.vm.store(VReg.FP, off, VReg.RET);
    },

    // [#48] 赋值形叶子:把当前 RET 值写入既有 lvalue(Identifier 或成员表达式)。
    // 复用 compileAssignmentExpression 的全部 lvalue 逻辑(装箱变量/顶层捕获/
    // 计算成员/静态成员/导出同步),避免重复手写。值先落临时局部,再以引用它的
    // Identifier 作赋值右侧。
    emitDestructureAssign(targetNode) {
        // [const-reassign] sloppy 模式对 const 绑定的解构写入是**运行期** TypeError
        // (for ([c] of x) / ({a: c} = obj));blockscope 已把写点标 _constWrite。
        if (targetNode && targetNode.type === "Identifier" && targetNode._constWrite) {
            this.emitThrowTypeError("Assignment to constant variable.");
            return;
        }
        // [TDZ 写] 词法先于声明的写点(let x 在 for-of/赋值之后):blockscope 标 _tdz,
        // 写 TDZ 绑定须抛 ReferenceError(for ([...x] of x) / ({a: x} = y) put-let 族)。
        if (targetNode && targetNode.type === "Identifier" && targetNode._tdz) {
            let dName = targetNode.name;
            const cut = typeof dName === "string" ? dName.indexOf("$blk$") : -1;
            if (cut !== -1) dName = dName.slice(0, cut);
            this.emitThrowReferenceError("Cannot access '" + dName + "' before initialization");
            return;
        }
        // Pre-declare undeclared identifier targets so assignment can proceed.
        // In sloppy mode ES, assignment to an undeclared variable creates a global;
        // asm.js has no global scope, so we auto-declare a local slot instead.
        // [L2-② strict] 严格模式下对 unresolvable 绑定目标必须抛 ReferenceError
        // (for ({unresolvable} of [{}]) 族,onlyStrict):预声明会把本该抛错的名变成
        // 局部槽 → 静默成功,assert.throws(ReferenceError) 判负。判据与普通赋值
        // lvalue 的 unresolvable 分支一致(isUnresolvableIdentifier),函数/导入/
        // 已知全局不算,维持既有行为。
        if (targetNode.type === "Identifier" && targetNode.name) {
            const name = targetNode.name;
            // [TDZ 写] 本模块顶层的 let/const 名且**模块主帧槽尚未分配**(= 声明在写点
            // 之后)→ 写词法绑定处于 TDZ,抛 ReferenceError(for ([...x] of y) put-let 族)。
            // 须先于下方捕获门:闭包引用该名会把它抬进 mainCapturedVars(本帧 getLocal
            // 命中)→ 旧序永远跳过 TDZ 判。判据用模块主 ctx 的槽(声明在前 → 槽已分配,
            // 正常写;否则 TDZ)。已知全局/函数在 lexNames 外,不受影响。
            if (this.getModuleMeta && this._currentModuleAst) {
                const mm = this.getModuleMeta(this._currentModuleAst);
                if (mm && mm.lexNames && mm.lexNames.has(name)) {
                    const mainHas = mm.mainCtx && mm.mainCtx.getLocal &&
                        typeof mm.mainCtx.getLocal(name) === "number";
                    if (!mainHas) {
                        this.emitThrowReferenceError("Cannot access '" + name + "' before initialization");
                        return;
                    }
                }
            }
            if (!this.ctx.getLocal(name) && !this.ctx.getMainCapturedVar(name)) {
                const strict = !!(this.ctx && this.ctx.inStrictFunction);
                if (strict && this.isUnresolvableIdentifier &&
                    this.isUnresolvableIdentifier(targetNode)) {
                    this.emitThrowReferenceError(name + " is not defined");
                    return;
                }
                this.ctx.allocLocal(name);
            }
        }
        const tmpName = `__destrval_${this.nextLabelId()}`;
        const tmpOff = this.ctx.allocLocal(tmpName);
        this.vm.store(VReg.FP, tmpOff, VReg.RET);
        this.compileAssignmentExpression({
            type: "AssignmentExpression",
            operator: "=",
            left: targetNode,
            right: { type: "Identifier", name: tmpName },
        });
    },

    // [#48] 把赋值目标位置的 ObjectExpression/ArrayExpression(解析器按字面量产出)
    // 重解释为解构 pattern 形状,供 emitDestructurePattern 统一消费。
    // 叶子(Identifier/成员表达式/已是 pattern)原样返回。
    reinterpretAsPattern(node) {
        if (!node) return node;
        if (node.type === "ObjectExpression") {
            const outProps = [];
            const props = node.properties || [];
            for (const p of props) {
                if (p.type === "SpreadElement") { outProps.push(p); continue; }
                outProps.push({
                    type: "AssignmentProperty",
                    key: p.key,
                    value: this.reinterpretAsPattern(p.value),
                    shorthand: p.shorthand,
                    // 保留计算键标记:`({ [k]: v } = obj)` 须运行时求值 k 再取 obj[k];
                    // 丢失该标记会把 key 当静态名 → 读 obj["k"] 得 undefined。
                    computed: p.computed,
                });
            }
            return { type: "ObjectPattern", properties: outProps };
        }
        if (node.type === "ArrayExpression") {
            const outEls = [];
            const els = node.elements || [];
            for (const e of els) {
                if (!e) { outEls.push(null); continue; }
                if (e.type === "SpreadElement") { outEls.push(e); continue; }
                if (e.type === "AssignmentExpression" && e.operator === "=") {
                    outEls.push({ type: "AssignmentPattern", left: this.reinterpretAsPattern(e.left), right: e.right });
                    continue;
                }
                outEls.push(this.reinterpretAsPattern(e));
            }
            return { type: "ArrayPattern", elements: outEls };
        }
        // [W-24 fix] AssignmentExpression 在对象属性值位(如 `{ x: a = 42 }`)与数组元素
        // 位(`[a = 42]`)均应重解释为 AssignmentPattern。此前仅 ArrayExpression 分支处理,
        // 对象属性位走此处直返 AssignmentExpression → emitDestructurePattern 误把整个
        // AssignmentExpression 当 targetNode → 默认值失效(=undefined)。
        if (node.type === "AssignmentExpression" && node.operator === "=") {
            return { type: "AssignmentPattern", left: this.reinterpretAsPattern(node.left), right: node.right };
        }
        // AssignmentPattern(如对象简写默认 {a=1} 的 value,或数组元素默认):
        // left 可能仍是 Object/ArrayExpression(嵌套解构默认),需递归重解释;right(默认值)原样。
        if (node.type === "AssignmentPattern") {
            return { type: "AssignmentPattern", left: this.reinterpretAsPattern(node.left), right: node.right };
        }
        // 已是 pattern / Identifier / 成员表达式:叶子,原样。
        return node;
    },

    // [#47] 函数参数解构:入口把已保存到 `slot` 的实参按 pattern 解构到局部。
    // 调用点须先把所有实参寄存器落栈(解构中 _object_get/_subscript_get 会踩 A 寄存器),
    // 再逐个调用本方法。默认值 {a,b=5} / f({a}={}) 先按 undefined 兜底再解构。
    emitParamDestructure(pattern, slot, defaultExpr) {
        // rest 形参的绑定模式 `function f(...[a, b])` / `f(x, ...{length: n})`:
        // parser 把它拆成 `SpreadElement(Identifier(__restpat_N))` + 承载模式的影子形参
        // (见 lang/parser/statements.js pushFunctionParam)。rest 数组已由 SpreadElement
        // 分支的 emitRestParam 在形参循环内(实参寄存器尚未被踩)收进局部 __restpat_N,
        // 这里只把它搬进本形参的临时槽,随后复用与 `var [a, b] = arr` **完全相同**的
        // 声明式解构(emitDestructurePattern "decl"),绑定语义因此与声明处一致。
        // 找不到该局部 = 所在形参路径没有 rest 收集(如类构造器):明确报错,不静默不绑定。
        if (pattern && pattern.restSource) {
            const restOff = this.ctx.getLocal(pattern.restSource);
            if (!restOff) {
                throw new Error("Unsupported rest parameter binding pattern in this function form");
            }
            this.vm.load(VReg.V0, VReg.FP, restOff);
            this.vm.store(VReg.FP, slot, VReg.V0);
            this.emitDestructurePattern(pattern, slot, "decl");
            return;
        }
        if (defaultExpr) {
            // x64: V1/V2 别名 A3/A2;实参已落栈,仍用 V5/V6 避免平台路径分叉。
            const chkReg = this.vm.backend.name === "x64" ? VReg.V5 : VReg.V1;
            const undReg = this.vm.backend.name === "x64" ? VReg.V6 : VReg.V2;
            const skip = this.ctx.newLabel("parampat_skip");
            this.vm.load(chkReg, VReg.FP, slot);
            this.vm.movImm64(undReg, 0x7ffb000000000000n); // JS_UNDEFINED
            this.vm.cmp(chkReg, undReg);
            this.vm.jne(skip);
            const _prevEvalParam = this.ctx._evalInParamInit;
            this.ctx._evalInParamInit = true;
            this.compileExpression(defaultExpr);
            this.ctx._evalInParamInit = _prevEvalParam;
            this.vm.store(VReg.FP, slot, VReg.RET);
            this.vm.label(skip);
        }
        this.emitDestructurePattern(pattern, slot, "decl");
    },

    // [#47] 判定参数是否为解构 pattern(可含默认值包装)。
    _isPatternParam(param) {
        if (!param) return false;
        if (param.type === "ObjectPattern" || param.type === "ArrayPattern") return true;
        return param.type === "AssignmentPattern" && param.left &&
            (param.left.type === "ObjectPattern" || param.left.type === "ArrayPattern");
    },

    // [FDI eager] 生成器体内从 coro+168(CORO_PREBOUND)transfer 数组按绑定序取叶值入局部,
    // 替代重复 emitParamDestructure —— pattern 源已在调用期(stub,emitGenStubFullFdi)消费,
    // 体内再解构会二重消费自定义迭代器(错值/错计 next/错触 getter)。list = 绑定序叶名。
    emitGenTransferLoads(list) {
        const vm = this.vm;
        const arrOff = this.ctx.allocLocal(`__fditrans_${this.nextLabelId()}`);
        vm.lea(VReg.V0, "_scheduler_current");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.load(VReg.V0, VReg.V0, 168); // CORO_PREBOUND
        vm.store(VReg.FP, arrOff, VReg.V0);
        for (let i = 0; i < list.length; i++) {
            const off = this.ctx.allocLocal(list[i]);
            vm.load(VReg.A0, VReg.FP, arrOff);
            vm.movImm(VReg.A1, i);
            vm.call("_subscript_get");
            vm.store(VReg.FP, off, VReg.RET);
        }
    },

    compileNestedFunctionDeclaration(stmt) {
        if (!stmt.id || stmt.id.type !== "Identifier") {
            return;
        }

        const name = stmt.id.name;

        // 分配局部变量（如果还没有）。falsy 判定：合法偏移恒负，自举产物 getLocal(missing)=0。
        let offset = this.ctx.getLocal(name);
        if (!offset) {
            offset = this.ctx.allocLocal(name);
        }

        // 递归自引用：函数体内引用了自己的名字（如 function visit(n){ ...visit(c)... }）。
        // 此时函数名必须作为「捕获变量」经共享 box 可见，否则闭包在自身体内看到的
        // 是编译期尚未写入的空槽（typeof 得到 number）而崩。为此：
        //   ① 把 name 标为 boxedVar 且预建 box（值先置 0），让 compileFunctionExpression
        //      走「外部变量已装箱」路径捕获同一个 box（并把 offset 更新为共享 box）；
        //   ② 闭包建好后把闭包写回该共享 box，使体内自引用解引用得到闭包本身。
        const isRecursive = this._functionBodyReferencesName(stmt.body, name);

        if (isRecursive) {
            if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
            this.ctx.boxedVars.add(name);
            // 预建 box（值=0），offset 指向它
            if (this.ctx.preboxedVars && this.ctx.preboxedVars.has(name)) {
                // [L2-②] 复用函数入口预建 box(前向闭包已捕获同 box,不得另建)
                this.vm.load(VReg.RET, VReg.FP, offset);
            } else {
                this.vm.call("_box_alloc");
            }
            this.vm.movImm(VReg.V1, 0);
            this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1);
            this.vm.store(VReg.FP, offset, VReg.RET);
        }

        // 检查是否需要装箱
        const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(name);

        // 将函数声明转换为函数表达式编译
        const funcExpr = {
            type: "FunctionExpression",
            params: stmt.params,
            body: stmt.body,
            id: stmt.id,
            async: stmt.async, // 保留 async 标志
            isGenerator: stmt.isGenerator, // [批次D] 保留生成器标志
        };

        this.compileFunctionExpression(funcExpr);

        if (isRecursive) {
            // compileFunctionExpression 已把 offset 更新为捕获时新建的共享 box。
            // 把闭包写入该 box：体内自引用（读同一 box 并解引用）即得到闭包。
            this.vm.mov(VReg.V1, VReg.RET);           // V1 = 闭包 JSValue
            this.vm.load(VReg.V2, VReg.FP, offset);   // V2 = 共享 box 指针
            this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.V1); // box.value = 闭包
            this.vm.mov(VReg.RET, VReg.V1);           // 恢复 RET = 闭包
        } else if (needsBox) {
            // 创建 box 并存储函数指针
            this.vm.mov(VReg.V1, VReg.RET); // 保存函数指针/闭包
            if (this.ctx.preboxedVars && this.ctx.preboxedVars.has(name)) {
                // [L2-②] 复用函数入口预建 box(前向闭包已捕获同 box,不得另建)
                this.vm.load(VReg.RET, VReg.FP, offset);
            } else {
                this.vm.call("_box_alloc");
            }
            this.vm.store(VReg.FP, offset, VReg.RET); // 存储 box 指针
            this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1); // 存入函数指针
        } else {
            this.vm.store(VReg.FP, offset, VReg.RET);
        }
    },

    // 判断函数体 AST 内是否引用了标识符 name（用于识别递归自引用）。
    // 递归遍历所有子节点，跳过非计算成员/属性的 key（obj.name 不算对 name 的引用）。
    _functionBodyReferencesName(node, name) {
        const walk = (n) => {
            if (!n || typeof n !== "object") return false;
            if (Array.isArray(n)) {
                for (let i = 0; i < n.length; i++) if (walk(n[i])) return true;
                return false;
            }
            const t = n.type;
            if (t === "Identifier") return n.name === name;
            if (t === "Literal" || t === "ThisExpression" || t === "Super" ||
                t === "PrivateIdentifier" || t === "EmptyStatement" || t === "DebuggerStatement" ||
                t === "MetaProperty" || t === "TemplateElement") return false;
            if (t === "MemberExpression") {
                if (walk(n.object)) return true;
                return n.computed ? walk(n.property) : false;
            }
            if (t === "Property" || t === "PropertyDefinition" || t === "MethodDefinition") {
                if (n.computed && walk(n.key)) return true;
                return walk(n.value);
            }
            if (t === "CallExpression" || t === "NewExpression") {
                if (walk(n.callee)) return true;
                const args = n.arguments;
                if (args) for (let i = 0; i < args.length; i++) if (walk(args[i])) return true;
                return false;
            }
            if (t === "BinaryExpression" || t === "LogicalExpression" || t === "AssignmentExpression") {
                return walk(n.left) || walk(n.right);
            }
            if (t === "UnaryExpression" || t === "UpdateExpression" || t === "AwaitExpression" ||
                t === "YieldExpression" || t === "ThrowStatement" || t === "ReturnStatement" ||
                t === "SpreadElement" || t === "RestElement" || t === "ExpressionStatement") {
                return walk(n.argument || n.expression);
            }
            if (t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "FunctionDeclaration") {
                if (walk(n.body)) return true;
                const params = n.params;
                if (params) for (let i = 0; i < params.length; i++) if (walk(params[i])) return true;
                return false;
            }
            if (t === "BlockStatement" || t === "Program" || t === "ClassBody") {
                const body = n.body;
                if (body) for (let i = 0; i < body.length; i++) if (walk(body[i])) return true;
                return false;
            }
            if (t === "IfStatement" || t === "ConditionalExpression") {
                return walk(n.test) || walk(n.consequent) || walk(n.alternate);
            }
            if (t === "VariableDeclaration") {
                const decls = n.declarations;
                if (decls) for (let i = 0; i < decls.length; i++) if (walk(decls[i])) return true;
                return false;
            }
            if (t === "VariableDeclarator") {
                return walk(n.id) || walk(n.init);
            }
            if (t === "ArrayExpression" || t === "ArrayPattern") {
                const els = n.elements;
                if (els) for (let i = 0; i < els.length; i++) if (walk(els[i])) return true;
                return false;
            }
            if (t === "ObjectExpression" || t === "ObjectPattern") {
                const prs = n.properties;
                if (prs) for (let i = 0; i < prs.length; i++) if (walk(prs[i])) return true;
                return false;
            }
            if (t === "SequenceExpression" || t === "TemplateLiteral") {
                const xs = n.expressions;
                if (xs) for (let i = 0; i < xs.length; i++) if (walk(xs[i])) return true;
                return false;
            }
            for (const key in n) {
                if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
                if (key.length && key.charCodeAt(0) === 95) continue;
                const v = n[key];
                if (v && typeof v === "object" && walk(v)) return true;
            }
            return false;
        };
        return walk(node);
    },

    // 编译返回语句
    compileReturnStatement(stmt) {
        if (stmt.argument) {
            this.compileExpression(stmt.argument);
        } else {
            // 裸 `return;` 产出真正的 undefined(tagged 0x7FFB),而非裸 int 0——
            // 否则 `return` 之值与数值 0 不可分辨,令 falsy/nullish/=== 判定失真。
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        }
        // [iterator-close] return 离开协议 for-of:先 close(规范 ForIn/OfBodyEvaluation)
        this.emitPendingIteratorCloses(0, true);
        // [#54] return 跨越含 finally 的 try:从内到外先跑各 finalizer(RET 暂存槽)
        this.emitPendingFinalizers(0, true);
        // [#38] return 词法上在 try 内:恢复链头为最外层活动 try 的 link
        //（= 函数入口时的链头)。只在 tryFrames 非空时发出——彼时帧槽必已初始化。
        if (this.ctx.tryFrames && this.ctx.tryFrames.length > 0) {
            this.emitExcCtxRestore(this.ctx.tryFrames[0]);
        }
        this.vm.jmp(this.ctx.returnLabel);
    },

    // 编译 if 语句
    // [P3.0] 条件求值 + 为假跳转。test 为比较运算(<,<=,>,>=,===,!==,!=)且实际
    // 路由到 compileComparison 时融合:直接按 flags 分支,消除"物化 _js_true/false
    // + _to_boolean 调用 + cmp"三段式(num 循环反汇编实证,PERF_PLAN P3)。
    // 以 AST 节点身份匹配消费,内层嵌套比较不受影响;未消费(常量折叠/==/BigInt/
    // 其它路由)回退 _to_boolean 三段式——语义与原码完全一致。
    emitTestJumpFalse(test, falseLabel) {
        let fuse = null;
        if (test && test.type === "BinaryExpression" && FUSE_COND_OPS.indexOf(test.operator) >= 0) {
            fuse = { node: test, falseLabel: falseLabel, fused: false };
            this._fuseCondJump = fuse;
        }
        this.compileExpression(test);
        if (fuse !== null) {
            this._fuseCondJump = null; // 未消费则清除,防泄漏到后续比较
            if (fuse.fused) return;
        }
        // 用运行时 _to_boolean 求真值：`RET & 1` 只对 NaN-boxed 布尔正确，
        // 对象/数组（裸堆指针，低位常为 0）、数字、字符串都会误判为 falsy。
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(falseLabel);
    },

    compileIfStatement(stmt) {
        const elseLabel = this.ctx.newLabel("else");
        const endLabel = this.ctx.newLabel("endif");

        this.emitTestJumpFalse(stmt.test, stmt.alternate ? elseLabel : endLabel);

        this.compileStatement(stmt.consequent);

        if (stmt.alternate) {
            this.vm.jmp(endLabel);
            this.vm.label(elseLabel);
            this.compileStatement(stmt.alternate);
        }

        this.vm.label(endLabel);
    },

    // 编译 while 语句
    compileWhileStatement(stmt) {
        const loopLabel = this.ctx.newLabel("while");
        const endLabel = this.ctx.newLabel("endwhile");

        // 保存循环标签
        const savedBreak = this.ctx.breakLabel;
        const savedContinue = this.ctx.continueLabel;
        // [#38] 记录循环边界处的 try 深度:break/continue 跨出 try 时按此恢复链头
        const savedBreakTryLen = this.ctx.breakTryLen;
        const savedContinueTryLen = this.ctx.continueTryLen;
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.continueTryLen = this.ctx.breakTryLen;
        this.ctx.breakLabel = endLabel;
        this.ctx.continueLabel = loopLabel;
        const savedLabels = this._registerPendingLabels(endLabel); // [#60]

        this.vm.label(loopLabel);
        this.emitTestJumpFalse(stmt.test, endLabel); // [P3.0] 比较条件融合

        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);
        this.vm.jmp(loopLabel);

        this.vm.label(endLabel);

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
        this._restoreLabels(savedLabels); // [#60]
    },

    // 编译 for 语句
    // [解箱①] 检测可安全裸 int 驻留的 for 循环 induction 变量,返回变量名或 null。
    // 条件:init 为 `var NAME = <整数字面量>`(单声明);update 为 NAME++/--/++NAME/--NAME;
    // test 为 `NAME <cmp> expr`;NAME 未被闭包捕获(boxedVars);body 内无对 NAME 的其他写。
    // 安全性:NAME 从 int 字面量步进 ±1,到 2^53 需跑百年不可达,可达范围内与 float64 语义一致。
    detectRawIntInductionVar(stmt) {
        const init = stmt.init, upd = stmt.update, test = stmt.test;
        if (!init || !upd || !test) return null;
        if (init.type !== "VariableDeclaration" || !init.declarations || init.declarations.length !== 1) return null;
        const decl = init.declarations[0];
        if (!decl.id || decl.id.type !== "Identifier") return null;
        if (!decl.init || decl.init.type !== "Literal" || typeof decl.init.value !== "number") return null;
        if (decl.init.value !== Math.floor(decl.init.value)) return null; // 必须整数字面量
        const name = decl.id.name;
        if (upd.type !== "UpdateExpression" || !upd.argument || upd.argument.type !== "Identifier" || upd.argument.name !== name) return null;
        if (upd.operator !== "++" && upd.operator !== "--") return null;
        if (test.type !== "BinaryExpression") return null;
        if (!REL_OPS_FOR[test.operator]) return null;
        if (!test.left || test.left.type !== "Identifier" || test.left.name !== name) return null;
        // 被闭包捕获(装箱)的变量不适用:走 box 双重间接,裸 int 会腐蚀
        if (this.ctx.boxedVars && this.ctx.boxedVars.has(name)) return null;
        // boxedVars 对顶层函数表达式捕获不完整(analyzeTopLevelSharedVariables 仅扫顶层
        // 声明,漏掉 `h = function(){...i...}` 这类表达式捕获)→ 独立扫描体内嵌套函数是否
        // 引用 name。命中则该循环变量会被闭包按 box 指针解引用,裸 int 驻留会把 bare int
        // 当 box 指针解引用致段错误(捕获顶层归纳变量的闭包崩溃根因)。
        if (this._nodeCapturedByNestedFn(stmt.body, name)) return null;
        // body 内对 NAME 的其他写(赋值/自增)→ 表示形态不受控,bail
        if (this._nodeWritesVar(stmt.body, name)) return null;
        return name;
    },

    // 递归扫描:node 内某嵌套函数(表达式/声明/箭头)是否引用 Identifier(name)。
    // 保守判定(不排除同名遮蔽)——过度 bail 只是少一次裸 int 优化,恒安全。
    _nodeCapturedByNestedFn(node, name) {
        if (!node || typeof node !== "object") return false;
        if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" ||
            node.type === "FunctionDeclaration") {
            return this._nodeRefsIdentifier(node, name);
        }
        for (const k in node) {
            if (k === "type") continue;
            const v = node[k];
            if (v && typeof v === "object") {
                if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) if (this._nodeCapturedByNestedFn(v[i], name)) return true;
                } else if (this._nodeCapturedByNestedFn(v, name)) return true;
            }
        }
        return false;
    },

    // 递归扫描:node 内是否存在对 Identifier(name) 的引用
    _nodeRefsIdentifier(node, name) {
        if (!node || typeof node !== "object") return false;
        if (node.type === "Identifier" && node.name === name) return true;
        for (const k in node) {
            if (k === "type") continue;
            const v = node[k];
            if (v && typeof v === "object") {
                if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) if (this._nodeRefsIdentifier(v[i], name)) return true;
                } else if (this._nodeRefsIdentifier(v, name)) return true;
            }
        }
        return false;
    },

    // 递归扫描:node 内是否存在对 Identifier(name) 的赋值或自增/自减写
    _nodeWritesVar(node, name) {
        if (!node || typeof node !== "object") return false;
        if (node.type === "AssignmentExpression" && node.left && node.left.type === "Identifier" && node.left.name === name) return true;
        if (node.type === "UpdateExpression" && node.argument && node.argument.type === "Identifier" && node.argument.name === name) return true;
        for (const k in node) {
            if (k === "type") continue;
            const v = node[k];
            if (v && typeof v === "object") {
                if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) if (this._nodeWritesVar(v[i], name)) return true;
                } else if (this._nodeWritesVar(v, name)) return true;
            }
        }
        return false;
    },

    // [解箱① P4.1] 浮点累加器 FP 驻留检测。M1:原实现三次 `_subtreeBlocksFpAccum` +
    // 整树 for-in 在 gen1 上偏贵;关闭后循环累加走槽(正确)。完整实现见 git 历史。
    detectFpAccumVars(stmt) {
        return [];
    },

    compileForStatement(stmt) {
        const loopLabel = this.ctx.newLabel("for");
        const updateLabel = this.ctx.newLabel("for_update");
        const endLabel = this.ctx.newLabel("endfor");

        // 保存循环标签
        const savedBreak = this.ctx.breakLabel;
        const savedContinue = this.ctx.continueLabel;
        // [#38] 记录循环边界处的 try 深度:break/continue 跨出 try 时按此恢复链头
        const savedBreakTryLen = this.ctx.breakTryLen;
        const savedContinueTryLen = this.ctx.continueTryLen;
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.continueTryLen = this.ctx.breakTryLen;
        this.ctx.breakLabel = endLabel;
        this.ctx.continueLabel = updateLabel;
        const savedLabels = this._registerPendingLabels(endLabel); // [#60]

        this.emitTdzBlockPrologue(stmt); // [批次D TDZ] for 头内先读后声明(罕见)

        // [解箱①] 安全 induction 变量裸 int 驻留检测(detect/_nodeWritesVar 见 loops.js)
        const rawIntName = this.detectRawIntInductionVar(stmt);

        if (stmt.init) {
            if (stmt.init.type === "VariableDeclaration") {
                this.compileVariableDeclaration(stmt.init);
            } else {
                this.compileExpression(stmt.init);
            }
        }

        // [解箱①] 命中:标记裸 int 驻留 + 用裸 int 覆写 slot 初值(声明已按 float64 存过)
        let rawIntOffset = 0;
        if (rawIntName) {
            rawIntOffset = this.ctx.getLocal(rawIntName);
            if (rawIntOffset) {
                this.ctx.setVarType(rawIntName, Type.INT32);
                this.ctx.rawIntVars[rawIntName] = true;
                this.compileIntLiteral(stmt.init.declarations[0].init.value);
                this.vm.store(VReg.FP, rawIntOffset, VReg.RET);
            } else {
                rawIntOffset = 0;
            }
        }

        // [解箱① P4.1] 浮点累加器 FP 驻留:入口把各累加器当前 slot 值载入其 FP 寄存器,
        // 循环体内 `s=s<op>E` 直发 f<op>(见 assignments)、读 s 从 FP 取(见 members)。
        const fpAccums = this.detectFpAccumVars(stmt);
        for (let ai = 0; ai < fpAccums.length; ai++) {
            const acc = fpAccums[ai];
            this.vm.load(VReg.RET, VReg.FP, acc.offset);      // slot(float64 位)
            this.vm.fmovToFloat(acc.reg, VReg.RET);           // d_reg = s
            this.ctx.fpAccumVars[acc.name] = acc.reg;
        }

        this.vm.label(loopLabel);

        if (stmt.test) {
            this.emitTestJumpFalse(stmt.test, endLabel); // [P3.0] 比较条件融合
        }

        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);

        this.vm.label(updateLabel);
        // [批次D L3] for(let i...) 循环变量被闭包捕获时,每迭代独立绑定:
        // update 前重建 box(拷贝当前值),update 作用于新 box —— 上一迭代创建的
        // 闭包持旧 box,其值不再被后续迭代改写(对齐 node:fs=[0,1,2] 而非 [3,3,3])。
        // 未捕获 / var 声明:零发射,codegen 不变。continue 跳到 updateLabel,天然覆盖。
        if (stmt.init && stmt.init.type === "VariableDeclaration" &&
            (stmt.init.kind === "let" || stmt.init.kind === "const")) {
            for (const loopDecl of stmt.init.declarations) {
                if (!loopDecl.id || loopDecl.id.type !== "Identifier") continue;
                const loopVarName = loopDecl.id.name;
                if (!(this.ctx.boxedVars && this.ctx.boxedVars.has(loopVarName))) continue;
                const loopVarOff = this.ctx.getLocal(loopVarName);
                if (!loopVarOff) continue;
                this.vm.load(VReg.RET, VReg.FP, loopVarOff);       // 旧 box 指针
                this.vm.load(VReg.RET, VReg.RET, BOX_VALUE_OFFSET); // 当前值
                this.vm.push(VReg.RET);
                this.vm.call("_box_alloc");                         // RET = 新 box(登记为 minor 根)
                this.vm.store(VReg.FP, loopVarOff, VReg.RET);       // 槽 → 新 box
                this.vm.pop(VReg.V1);
                this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1); // 新 box.value = 旧值
            }
        }
        if (stmt.update) {
            this.compileExpression(stmt.update);
        }

        this.vm.jmp(loopLabel);
        this.vm.label(endLabel);

        // [解箱①] 循环出口:slot 里是裸 int(如 i==N),物化回 float64 位供循环后
        // 通用读(console.log(i)/return i)见正常 JS Number;清标记 + 类型还原 NUMBER。
        if (rawIntName && rawIntOffset) {
            this.vm.load(VReg.RET, VReg.FP, rawIntOffset);
            this.intToFloat64Bits(VReg.RET);
            this.vm.store(VReg.FP, rawIntOffset, VReg.RET);
            this.ctx.rawIntVars[rawIntName] = false;
            this.ctx.setVarType(rawIntName, Type.NUMBER);
        }

        // [解箱① P4.1] 循环出口:各浮点累加器 FP 寄存器物化回 slot(供循环后读),清 pin
        for (let ai = 0; ai < fpAccums.length; ai++) {
            const acc = fpAccums[ai];
            this.vm.fmovToInt(VReg.RET, acc.reg);            // RET = d_reg(float64 位)
            this.vm.store(VReg.FP, acc.offset, VReg.RET);
            this.ctx.fpAccumVars[acc.name] = 0;
        }

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
        this._restoreLabels(savedLabels); // [#60]
    },

    // 存储 for-of/for-in 的迭代变量。RET 持有当前元素值。
    // 若该变量被内层闭包捕获（在 boxedVars 中），必须每轮分配全新 box、把 box
    // 指针存入槽、值写入 box——否则槽里存的是裸值，闭包按 box 指针解引用即崩。
    // 每轮新 box 也符合 const/let 在 for-of 每次迭代产生独立绑定的语义。
    storeLoopVar(varName, varOffset) {
        if (varOffset === null || varOffset === undefined) return;
        const needsBox = varName && this.ctx.boxedVars && this.ctx.boxedVars.has(varName);
        if (needsBox) {
            this.vm.push(VReg.RET);              // 保存元素值
            this.vm.call("_box_alloc");              // RET = 新 box 指针
            this.vm.store(VReg.FP, varOffset, VReg.RET); // 槽 = box 指针
            this.vm.pop(VReg.V1);                // V1 = 元素值
            this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1); // box.value = 值
        } else {
            this.vm.store(VReg.FP, varOffset, VReg.RET);
        }
    },

    // [#53] for-of 每轮把当前元素（在 RET）绑定到循环变量。左侧是 Identifier → 走
    // storeLoopVar（含闭包装箱，逐字节不变）；左侧是解构 pattern → 把元素落 srcSlot
    // 后调用递归解构 emitDestructurePattern（decl=声明形分配绑定名 / assign=写既有 lvalue）。
    storeLoopBinding(varName, varOffset, pattern, patternMode, patternSrcSlot, leftMember) {
        // for await (x of ...):对每轮元素值 await(sync 可迭代/promise 数组均复用现有 await)。
        // 仅 _forOfAwait 置位(即 for await)时插入,普通 for-of 逐字节不变。
        if (this._forOfAwait) {
            const s = this.ctx.allocLocal(`__fa_v_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, s, VReg.RET);
            this.compileAwaitExpression({ type: "AwaitExpression", argument: { type: "__WithPrecomputed", slot: s } });
        }
        if (pattern) {
            this.vm.store(VReg.FP, patternSrcSlot, VReg.RET);
            this.emitDestructurePattern(pattern, patternSrcSlot, patternMode);
            return;
        }
        if (leftMember) {
            const vSlot = this.ctx.allocLocal(`__forof_mlhs_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, vSlot, VReg.RET);
            this.compileExpression({
                type: "AssignmentExpression",
                operator: "=",
                left: leftMember,
                right: { type: "__WithPrecomputed", slot: vSlot },
            });
            return;
        }
        this.storeLoopVar(varName, varOffset);
    },

    // [async-iteration Phase 2a] for await (BINDING of RIGHT):运行时若 RIGHT 有
    // Symbol.asyncIterator 则驱动异步迭代器协议(it=RIGHT[Symbol.asyncIterator]();
    // 循环 {value,done}=await it.next()),否则回退 Phase 1(sync 可迭代逐元素 await)。
    // 全部脱糖成合成 AST 复用现有 方法调用/await/成员读/while/for-of/解构;无协程原语。
    // _syncAwaitOnly 标记回退分支避免重入本派发。仅 for await 触发,普通 for-of 不变。
    compileForAwaitDispatch(stmt) {
        const id = this.nextLabelId();
        const srcName = `__fa_src_${id}`;
        const itName = `__fa_it_${id}`;
        const resName = `__fa_res_${id}`;
        const idn = (n) => ({ type: "Identifier", name: n });
        const member = (o, p, computed) => ({ type: "MemberExpression", object: o, property: p, computed: !!computed });
        const symAsyncIter = () => member(idn("Symbol"), idn("asyncIterator"), false);
        // RIGHT[Symbol.asyncIterator]
        const asyncMethod = member(idn(srcName), symAsyncIter(), true);
        // 绑定语句:<stmt.left 声明形> = __r.value(声明 → const/let x=…;裸标识符 → x=…)
        const valueExpr = member(idn(resName), idn("value"), false);
        let bindStmt;
        if (stmt.left.type === "VariableDeclaration") {
            bindStmt = {
                type: "VariableDeclaration", kind: stmt.left.kind,
                declarations: [{ type: "VariableDeclarator", id: stmt.left.declarations[0].id, init: valueExpr }],
            };
        } else {
            bindStmt = { type: "ExpressionStatement", expression: { type: "AssignmentExpression", operator: "=", left: stmt.left, right: valueExpr } };
        }
        const asyncBlock = { type: "BlockStatement", body: [
            // const __it = RIGHT[Symbol.asyncIterator]()
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(itName), init: { type: "CallExpression", callee: member(idn(srcName), symAsyncIter(), true), arguments: [] } }] },
            { type: "WhileStatement", test: { type: "BooleanLiteral", value: true }, body: { type: "BlockStatement", body: [
                // const __r = await __it.next()
                { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(resName), init: { type: "AwaitExpression", argument: { type: "CallExpression", callee: member(idn(itName), idn("next"), false), arguments: [] } } }] },
                // if (__r.done) break
                { type: "IfStatement", test: member(idn(resName), idn("done"), false), consequent: { type: "BreakStatement" }, alternate: null },
                bindStmt,
                stmt.body,
            ] } },
        ] };
        // 回退:sync for await(Phase 1 逐元素 await),标 _syncAwaitOnly 防重入
        const syncFor = { type: "ForOfStatement", left: stmt.left, right: idn(srcName), body: stmt.body, await: true, _syncAwaitOnly: true };
        const dispatch = { type: "BlockStatement", body: [
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(srcName), init: stmt.right }] },
            { type: "IfStatement",
              test: { type: "BinaryExpression", operator: "===", left: { type: "UnaryExpression", operator: "typeof", argument: asyncMethod }, right: { type: "StringLiteral", value: "function" } },
              consequent: asyncBlock,
              alternate: { type: "BlockStatement", body: [syncFor] } },
        ] };
        this.compileStatement(dispatch);
    },

    // 编译 for...of 语句
    compileForOfStatement(stmt) {
        // for await + 未标 _syncAwaitOnly:先运行时判 Symbol.asyncIterator 分派(Phase 2a)。
        if (stmt.await && !stmt._syncAwaitOnly) {
            this.compileForAwaitDispatch(stmt);
            return;
        }
        const loopLabel = this.ctx.newLabel("forof_array");
        const continueLabel = this.ctx.newLabel("forof_array_continue");
        const iteratorStartLabel = this.ctx.newLabel("forof_iterator_start");
        const iteratorLoopLabel = this.ctx.newLabel("forof_iterator");
        const iteratorContinueLabel = this.ctx.newLabel("forof_iterator_continue");
        const endLabel = this.ctx.newLabel("endforof");
        // [iterator-close] break 提前退出时对 Symbol.iterator 协议迭代器调 return()。
        const iterCloseLabel = this.ctx.newLabel("forof_close");

        // for await:每轮元素值 await(见 storeLoopBinding)。save/restore 支持嵌套。
        const savedForOfAwait = this._forOfAwait;
        this._forOfAwait = !!stmt.await;

        // 保存循环标签
        const savedBreak = this.ctx.breakLabel;
        const savedContinue = this.ctx.continueLabel;
        // [#38] 记录循环边界处的 try 深度:break/continue 跨出 try 时按此恢复链头
        const savedBreakTryLen = this.ctx.breakTryLen;
        const savedContinueTryLen = this.ctx.continueTryLen;
        const savedBreakIterCloseLen = this.ctx.breakIterCloseLen;
        const savedContinueIterCloseLen = this.ctx.continueIterCloseLen;
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.continueTryLen = this.ctx.breakTryLen;
        // 进入时栈深(协议路径 push 前);body 前再抬到 push 后,见各路径 _bindLabelContinue 前。
        this.ctx.breakIterCloseLen = this.ctx.iterCloseStack ? this.ctx.iterCloseStack.length : 0;
        this.ctx.continueIterCloseLen = this.ctx.breakIterCloseLen;
        // break 路由到 close 标签(仅协议迭代器路径实际 close;其余槽=0 时直通 endLabel)。
        this.ctx.breakLabel = iterCloseLabel;
        const savedLabels = this._registerPendingLabels(endLabel); // [#60]

        const iterableTempOffset = this.ctx.allocLocal(`__forof_iterable_${this.nextLabelId()}`);
        const arrTempOffset = this.ctx.allocLocal(`__forof_arr_${this.nextLabelId()}`);
        const idxTempOffset = this.ctx.allocLocal(`__forof_idx_${this.nextLabelId()}`);
        const lenTempOffset = this.ctx.allocLocal(`__forof_len_${this.nextLabelId()}`);
        const iteratorTempOffset = this.ctx.allocLocal(`__forof_iterator_${this.nextLabelId()}`);
        const resultTempOffset = this.ctx.allocLocal(`__forof_result_${this.nextLabelId()}`);
        // [iterator-close] 仅协议迭代器路径把活迭代器存入此槽;其余路径=0 → break 不 close。
        const iterCloseOffset = this.ctx.allocLocal(`__forof_close_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, iterCloseOffset, VReg.V0);
        let iterClosePushed = false;

        // 计算 iterable，当前快路支持 NaN-boxed Array。
        // TypedArray 不再快照成普通数组:for-of 须见循环体内的元素写入与
        // length-tracking 的 resize(iteratorStart 处按 type 字节走活长度下标路)。
        this.compileExpression(stmt.right);
        this.vm.store(VReg.FP, iterableTempOffset, VReg.RET);

        // Array JSValue tag = 0x7ffe. 非数组走 Symbol.iterator 协议路径。
        // 若数组**覆盖**了 @@iterator(自有或原型上 ≠ Array.prototype.values)→ 协议路径
        // (Math.sumPrecise(overriddenArray) 等);默认 values 仍走下标快路(自举热路径)。
        this.vm.mov(VReg.V0, VReg.RET);
        this.vm.shrImm(VReg.V0, VReg.V0, 48);
        this.vm.cmpImm(VReg.V0, 0x7ffe);
        this.vm.jne(iteratorStartLabel);
        if (this.emitArrayProtoObject) this.emitArrayProtoObject();
        const arrItCustomL = this.ctx.newLabel("forof_arr_it_custom");
        const arrItFastL = this.ctx.newLabel("forof_arr_it_fast");
        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset);
        this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
        this.vm.call("_object_get");
        this.vm.mov(VReg.V6, VReg.RET); // 候选 iterator 方法
        this.vm.shrImm(VReg.V0, VReg.V6, 48);
        this.vm.cmpImm(VReg.V0, 0x7fff);
        this.vm.jne(arrItFastL); // 无方法 → 下标快路
        // 与 Array.prototype[Symbol.iterator] 比较;不同则自定义 → 协议
        this.vm.lea(VReg.V0, "_nsobj_array_proto");
        this.vm.load(VReg.A0, VReg.V0, 0);
        this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
        this.vm.call("_object_get");
        this.vm.cmp(VReg.V6, VReg.RET);
        this.vm.jne(arrItCustomL);
        this.vm.jmp(arrItFastL);
        this.vm.label(arrItCustomL);
        this.vm.jmp(iteratorStartLabel);
        this.vm.label(arrItFastL);

        // 上方 @@iterator 探测毁了 RET;两后端均从槽重载数组 JSValue。
        this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        this.vm.store(VReg.FP, arrTempOffset, VReg.V0);

        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxTempOffset, VReg.V0);

        this.vm.load(VReg.V0, VReg.FP, arrTempOffset);
        this.vm.load(VReg.V1, VReg.V0, 8);
        this.vm.store(VReg.FP, lenTempOffset, VReg.V1);

        // 获取迭代变量名（Identifier 路径）或解构 pattern（[#53]）。
        let varName = null;
        let loopPattern = null;
        let loopPatternMode = "decl";
        let leftMember = null;
        if (stmt.left.type === "VariableDeclaration" && stmt.left.declarations.length > 0) {
            const decl = stmt.left.declarations[0];
            if (decl.id.type === "Identifier") {
                varName = decl.id.name;
            } else if (decl.id.type === "ObjectPattern" || decl.id.type === "ArrayPattern") {
                // [#53] const/let [x,y] of / {x,y} of:声明形解构,每轮把元素解构到绑定名
                loopPattern = decl.id;
                loopPatternMode = "decl";
            }
        } else if (stmt.left.type === "Identifier") {
            varName = stmt.left.name;
        } else if (stmt.left.type === "MemberExpression") {
            leftMember = stmt.left;
        } else if (stmt.left.type === "ObjectPattern" || stmt.left.type === "ArrayPattern") {
            // [#53] for ([x,y] of ...)：赋值形解构（无声明），元素写入既有 lvalue
            loopPattern = stmt.left;
            loopPatternMode = "assign";
        } else if (stmt.left.type === "ObjectExpression" || stmt.left.type === "ArrayExpression") {
            // [test262 S1] 非声明式 for ([a,b] of ...)：parser 传表达式左值，重解释为赋值形 pattern
            loopPattern = this.reinterpretAsPattern(stmt.left);
            loopPatternMode = "assign";
        }

        // 分配迭代变量（Identifier 路径）。pattern 路径改为分配一个元素临时槽，
        // 每轮把当前元素落此槽后递归解构（仅当左侧确为 pattern 时才分配——Identifier
        // 路径不分配额外槽，保持后续 allocLocal 偏移不变、gen1 自编译逐字节定点）。
        const varOffset = varName ? this.ctx.allocLocal(varName) : null;
        const loopPatternSrcSlot = loopPattern
            ? this.ctx.allocLocal(`__forof_destr_${this.nextLabelId()}`)
            : null;

        this.vm.label(loopLabel);

        // 检查 i < length
        // 每轮从数组头 @8 重新读取当前长度，而非用入口处缓存的 lenTempOffset：
        // JS for-of 语义下数组迭代按当前 length 动态进行，循环体内 push 的新元素也应被遍历。
        // 缓存长度会漏掉迭代中追加的元素——node 原生 for-of 不会漏（故 gen0 正确），
        // 但编译产物（gen1）用缓存长度会漏，导致 generatePendingFunctions 在编译外层函数体时
        // 追加的内层闭包 pending function 被跳过、其 label 从不 emit（解析成 0）→ 闭包指向
        // __text 入口崩。改为动态读长后 gen1 的自编译与用户程序均符合 JS 语义。
        this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
        this.vm.load(VReg.V1, VReg.FP, arrTempOffset);
        this.vm.load(VReg.V1, VReg.V1, 8); // 当前长度 @8（动态重读）
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // 获取 array[i] = *(data_ptr(@24) + i * 8)
        this.vm.load(VReg.V1, VReg.FP, arrTempOffset);
        this.vm.load(VReg.V1, VReg.V1, 24); // data_ptr
        this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
        this.vm.shlImm(VReg.V0, VReg.V0, 3);
        this.vm.add(VReg.V0, VReg.V1, VReg.V0);
        this.vm.load(VReg.RET, VReg.V0, 0);

        // 存储到迭代变量（被闭包捕获时装箱）；[#53] pattern 则递归解构
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot, leftMember);

        // 编译循环体
        this.ctx.continueLabel = continueLabel;
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);

        this.vm.label(continueLabel);

        // i++
        this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxTempOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        // 通用 iterator 路径：obj[Symbol.iterator]().next()
        this.vm.label(iteratorStartLabel);

        // [#33] 字符串特判(tag 0x7FFC):逐字符 _str_charAt 迭代。必须在 Set/Map
        // 裸指针探测之前——字符串 payload 是无头内容指针,loadByte 读到的是首字符,
        // 原先落 Symbol.iterator 路径 _object_get 返回 0 → 静默零迭代。
        const strLoopLabel = this.ctx.newLabel("forof_str");
        const strContLabel = this.ctx.newLabel("forof_str_cont");
        const notStrLabel = this.ctx.newLabel("forof_notstr");
        this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
        this.vm.shrImm(VReg.V0, VReg.RET, 48); // 注意 x64 上 V0==RET==RAX,RET 已毁
        this.vm.cmpImm(VReg.V0, 0x7FFC);
        this.vm.jne(notStrLabel);
        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset); // 从槽重载(勿用 RET)
        this.vm.call("_js_length"); // RET = 原始整数长度
        this.vm.store(VReg.FP, lenTempOffset, VReg.RET);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxTempOffset, VReg.V0);
        this.vm.label(strLoopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
        this.vm.load(VReg.V1, VReg.FP, lenTempOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);
        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset);
        this.vm.load(VReg.A1, VReg.FP, idxTempOffset);
        // 按**码点**迭代:idxTempOffset = 字节偏移,取完整 UTF-8 码点子串(ASCII 与逐字节
        // 一致→自举保真;中文/astral 产正确码点非乱码字节)。continue 处按 cp 字节数推进。
        this.vm.call("_str_codepoint_at"); // RET = 码点子串
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot, leftMember);
        this.ctx.continueLabel = strContLabel;
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);
        this.vm.label(strContLabel);
        // off += _str_cp_bytes(str, off)(cpLen 挪 V1,避 x64 V0==RET 别名)
        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset);
        this.vm.load(VReg.A1, VReg.FP, idxTempOffset);
        this.vm.call("_str_cp_bytes");
        this.vm.mov(VReg.V1, VReg.RET);
        this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
        this.vm.add(VReg.V0, VReg.V0, VReg.V1);
        this.vm.store(VReg.FP, idxTempOffset, VReg.V0);
        this.vm.jmp(strLoopLabel);
        this.vm.label(notStrLabel);

        // Set 特判：Set 是链表(type@0=5, head@16, node[value@0,next@8])。若走通用
        // Symbol.iterator 路径，_object_get 会按对象/props_ptr 布局误读 Set 头 → 解引用垃圾崩
        // （自举 boxedVars 是 Set，for-of 遍历它是编译阶段崩根因）。这里直接遍历链表。
        const setLoopLabel = this.ctx.newLabel("forof_set");
        const setContLabel = this.ctx.newLabel("forof_set_cont");
        const notSetLabel = this.ctx.newLabel("forof_notset");
        this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // V0 = 原始指针（脱壳）
        this.vm.loadByte(VReg.V1, VReg.V0, 0);   // type 字节
        this.vm.cmpImm(VReg.V1, 5);              // TYPE_SET
        this.vm.jne(notSetLabel);
        this.vm.load(VReg.V0, VReg.V0, 16);      // node = head@16
        this.vm.store(VReg.FP, iteratorTempOffset, VReg.V0); // 复用 iteratorTemp 存 node
        this.vm.label(setLoopLabel);
        this.vm.load(VReg.V0, VReg.FP, iteratorTempOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jeq(endLabel);
        this.vm.load(VReg.RET, VReg.V0, 0);      // value@0
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot, leftMember);
        this.ctx.continueLabel = setContLabel;
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);
        this.vm.label(setContLabel);
        this.vm.load(VReg.V0, VReg.FP, iteratorTempOffset);
        this.vm.load(VReg.V0, VReg.V0, 8);       // next@8
        this.vm.store(VReg.FP, iteratorTempOffset, VReg.V0);
        this.vm.jmp(setLoopLabel);
        this.vm.label(notSetLabel);

        // Map 特判：Map 是 48 字节头（type@0=4, head@16, tail@24, bucket_count@32,
        // buckets_ptr@40;节点 key@0/value@8/next@16)。直接遍历链表(活视图:迭代中
        // 增删可见,map-expand/map-contract 族),逐节点构 [k,v] 对交 storeLoopBinding。
        // 此前调 _map_entries 快照成数组 → 迭代中 map.set 不可见。
        const mapLoopLabel = this.ctx.newLabel("forof_map");
        const mapContLabel = this.ctx.newLabel("forof_map_cont");
        const notMapLabel = this.ctx.newLabel("forof_notmap");
        this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        this.vm.loadByte(VReg.V1, VReg.V0, 0);
        this.vm.cmpImm(VReg.V1, 4);              // TYPE_MAP
        this.vm.jne(notMapLabel);
        this.vm.load(VReg.V0, VReg.V0, 16);      // node = head@16
        this.vm.store(VReg.FP, iteratorTempOffset, VReg.V0);
        this.vm.label(mapLoopLabel);
        this.vm.load(VReg.V0, VReg.FP, iteratorTempOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jeq(endLabel);
        // pair = [node.key, node.value]
        this.vm.movImm(VReg.A0, 2);
        this.vm.call("_array_new_with_size");
        this.vm.mov(VReg.S0, VReg.RET);          // 裸对头(_array_set 保 S0-S3)
        this.vm.load(VReg.V0, VReg.FP, iteratorTempOffset);
        this.vm.load(VReg.V1, VReg.V0, 0);       // key@0
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.movImm(VReg.A1, 0);
        this.vm.mov(VReg.A2, VReg.V1);
        this.vm.call("_array_set");
        this.vm.load(VReg.V0, VReg.FP, iteratorTempOffset);
        this.vm.load(VReg.V1, VReg.V0, 8);       // value@8
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.movImm(VReg.A1, 1);
        this.vm.mov(VReg.A2, VReg.V1);
        this.vm.call("_array_set");
        this.vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        this.vm.mov(VReg.RET, VReg.S0);
        this.vm.or(VReg.RET, VReg.RET, VReg.V1); // RET = boxed [k,v]
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot, leftMember);
        this.ctx.continueLabel = mapContLabel;
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);
        this.vm.label(mapContLabel);
        this.vm.load(VReg.V0, VReg.FP, iteratorTempOffset);
        this.vm.load(VReg.V0, VReg.V0, 16);      // next@16
        this.vm.store(VReg.FP, iteratorTempOffset, VReg.V0);
        this.vm.jmp(mapLoopLabel);
        this.vm.label(notMapLabel);

        // TypedArray(裸指针,type 0x40..0x7f):按活长度下标迭代。不可快照成普通数组——
        // length-tracking 视图在循环体 resize 后须吐出新元素(test262 grow-mid-iteration)。
        {
            const taLoopLabel = this.ctx.newLabel("forof_ta");
            const taContLabel = this.ctx.newLabel("forof_ta_cont");
            const notTaLabel = this.ctx.newLabel("forof_notta");
            this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(notTaLabel);
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(notTaLabel);
            this.vm.loadByte(VReg.V1, VReg.RET, 0);
            this.vm.andImm(VReg.V1, VReg.V1, 0xff);
            this.vm.cmpImm(VReg.V1, 0x40);
            this.vm.jlt(notTaLabel);
            this.vm.cmpImm(VReg.V1, 0x7f);
            this.vm.jgt(notTaLabel);
            this.vm.store(VReg.FP, arrTempOffset, VReg.RET);
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, idxTempOffset, VReg.V0);
            this.vm.label(taLoopLabel);
            this.vm.load(VReg.A0, VReg.FP, arrTempOffset);
            this.vm.call("_typed_array_length");
            this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
            this.vm.cmp(VReg.V0, VReg.RET);
            this.vm.jge(endLabel);
            this.vm.load(VReg.A0, VReg.FP, arrTempOffset);
            this.vm.load(VReg.A1, VReg.FP, idxTempOffset);
            this.vm.call("_typed_array_get");
            this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot, leftMember);
            this.ctx.continueLabel = taContLabel;
            this._bindLabelContinue(savedLabels);
            this.compileStatement(stmt.body);
            this.vm.label(taContLabel);
            this.vm.load(VReg.V0, VReg.FP, idxTempOffset);
            this.vm.addImm(VReg.V0, VReg.V0, 1);
            this.vm.store(VReg.FP, idxTempOffset, VReg.V0);
            this.vm.jmp(taLoopLabel);
            this.vm.label(notTaLabel);
        }

        // [iterator-protocol] ES GetIterator §7.4.1:若 obj[Symbol.iterator] 缺失或非
        // callable 则抛 TypeError。此前静默跳 endLabel → 零迭代(批量 test262 判负)。
        // _object_get 对未找到属性返回 undefined(0x7FFB),非裸 0;compileMethodCall 内部
        // _validate_callable 会验证可调用性。此处仅提前拦截明显的不可迭代值(null/undefined),
        // 精确到 null/undefined 让 try/catch `e instanceof TypeError` 成立(此前漏掉)。
        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset);
        this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
        this.vm.call("_object_get");
        const notIterableLabel = this.ctx.newLabel("forof_not_iterable");
        // 保存 RET 供 compileMethodCall 使用(须在 shrImm 前:x64 V0==RET==RAX)
        this.vm.mov(VReg.V6, VReg.RET);
        this.vm.shrImm(VReg.V0, VReg.RET, 48);
        // 未找到属性 → undefined(0x7FFB) / null(0x7FFA) → 不可迭代 → TypeError
        this.vm.cmpImm(VReg.V0, 0x7ffb);
        this.vm.jeq(notIterableLabel);
        this.vm.cmpImm(VReg.V0, 0x7ffa);
        this.vm.jeq(notIterableLabel);

        this.vm.load(VReg.V5, VReg.FP, iterableTempOffset);
        this.compileMethodCall(VReg.V6, VReg.V5, []);
        this.vm.store(VReg.FP, iteratorTempOffset, VReg.RET);
        // [iterator-close] 标记活迭代器:break 提前退出时对其调 return()。
        this.vm.store(VReg.FP, iterCloseOffset, VReg.RET);
        // 登记到 iterCloseStack:带标签 continue/return 跳出本 for-of 时由
        // emitPendingIteratorCloses 关闭(unlabeled break 仍走 iterCloseLabel)。
        if (!this.ctx.iterCloseStack) this.ctx.iterCloseStack = [];
        this.ctx.iterCloseStack.push({
            slot: iterCloseOffset,
            depth: this.ctx.breakTryLen,
        });
        iterClosePushed = true;
        // body/continue 边界抬到 push 后:同层 continue 不 close 自己;外层 labeled
        // continue 仍用登记时更短的快照。
        this.ctx.breakIterCloseLen = this.ctx.iterCloseStack.length;
        this.ctx.continueIterCloseLen = this.ctx.iterCloseStack.length;

        this.vm.label(iteratorLoopLabel);

        this.vm.load(VReg.A0, VReg.FP, iteratorTempOffset);
        this.emitBoxedStringKey("next", VReg.A1);
        this.vm.call("_object_get");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(endLabel);

        this.vm.mov(VReg.V6, VReg.RET);
        this.vm.load(VReg.V5, VReg.FP, iteratorTempOffset);
        this.compileMethodCall(VReg.V6, VReg.V5, []);
        this.vm.store(VReg.FP, resultTempOffset, VReg.RET);

        this.vm.load(VReg.A0, VReg.FP, resultTempOffset);
        this.emitBoxedStringKey("done", VReg.A1);
        this.vm.call("_object_get");
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(endLabel);

        this.vm.load(VReg.A0, VReg.FP, resultTempOffset);
        this.emitBoxedStringKey("value", VReg.A1);
        this.vm.call("_object_get");

        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot, leftMember);

        this.ctx.continueLabel = iteratorContinueLabel;
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);

        this.vm.label(iteratorContinueLabel);
        this.vm.jmp(iteratorLoopLabel);

        // [iterator-close] break 提前退出:若活迭代器有 return() 则调用(IteratorClose)。
        // 正常 done 完成直接 jmp endLabel(不经此)→ 不 close 已耗尽迭代器。非协议迭代器
        // (array/string/Set/Map)槽=0 → 直通 endLabel。单一 runtime helper(不内联方法调用)。
        this.vm.label(iterCloseLabel);
        this.vm.load(VReg.V0, VReg.FP, iterCloseOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jeq(endLabel);
        this.vm.load(VReg.A0, VReg.FP, iterCloseOffset);
        this.vm.call("_iterator_close");
        this.vm.jmp(endLabel); // 跳过下方的 notIterableLabel(TypeError 路径)

        // [iterator-protocol] 不可迭代值(TypeError):上面的 Symbol.iterator 检查不通过→跳此。
        this.vm.label(notIterableLabel);
        this.emitThrowTypeError("obj is not iterable");

        this.vm.label(endLabel);

        if (iterClosePushed && this.ctx.iterCloseStack && this.ctx.iterCloseStack.length > 0) {
            this.ctx.iterCloseStack.pop();
        }

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
        this.ctx.breakIterCloseLen = savedBreakIterCloseLen;
        this.ctx.continueIterCloseLen = savedContinueIterCloseLen;
        this._forOfAwait = savedForOfAwait;
        this._restoreLabels(savedLabels); // [#60]
    },

    // 编译 for...in 语句
    compileForInStatement(stmt) {
        const loopLabel = this.ctx.newLabel("forin");
        const continueLabel = this.ctx.newLabel("forin_continue");
        const endLabel = this.ctx.newLabel("endforin");
        const arrPathLabel = this.ctx.newLabel("forin_arr");
        const objPathLabel = this.ctx.newLabel("forin_obj");
        const startLabel = this.ctx.newLabel("forin_start");
        const yieldObjLabel = this.ctx.newLabel("forin_yield_obj");
        const afterYieldLabel = this.ctx.newLabel("forin_after_yield");
        // 数组索引耗尽后:若有 ARR_HAS_SIDETABLE 则切到侧表具名键(对象路径复用)
        const exhaustedLabel = this.ctx.newLabel("forin_exhausted");
        const sideSwitchLabel = this.ctx.newLabel("forin_side_switch");

        // 保存循环标签
        const savedBreak = this.ctx.breakLabel;
        const savedContinue = this.ctx.continueLabel;
        // [#38] 记录循环边界处的 try 深度:break/continue 跨出 try 时按此恢复链头
        const savedBreakTryLen = this.ctx.breakTryLen;
        const savedContinueTryLen = this.ctx.continueTryLen;
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.continueTryLen = this.ctx.breakTryLen;
        this.ctx.breakLabel = endLabel;
        this.ctx.continueLabel = continueLabel;
        const savedLabels = this._registerPendingLabels(endLabel); // [#60]

        const ptrOffset = this.ctx.allocLocal(`__forin_ptr_${this.nextLabelId()}`);
        const idxOffset = this.ctx.allocLocal(`__forin_idx_${this.nextLabelId()}`);
        const lenOffset = this.ctx.allocLocal(`__forin_len_${this.nextLabelId()}`);
        const isObjOffset = this.ctx.allocLocal(`__forin_isobj_${this.nextLabelId()}`);

        // 计算对象/数组
        this.compileExpression(stmt.right);

        // x64 上 RET(=RAX) 会被下面 tag 检测的 shrImm(V0,48) 破坏（V0 也是 RAX），
        // 而 startLabel 处的脱壳仍需原始 RET。先把 RET 暂存到 ptrOffset 槽（此时该槽尚未
        // 写入真正的脱壳指针），startLabel 处再重载。arm64 RET(X0)/V0(X8) 不同寄存器，
        // 无需处理，用 target 守卫保持 arm64 逐字节不变。
        if (this.vm.backend.name === "x64") {
            this.vm.store(VReg.FP, ptrOffset, VReg.RET);
        }

        // 分派：数组(0x7ffe)迭代索引；对象(0x7ffd)/函数(0x7fff)走 for-in 键表
        // (自有+原型链可枚举串键,含 Function.prototype.bind 继承,15.2.3.6-4-595)；其他跳过。
        this.vm.mov(VReg.V0, VReg.RET);
        this.vm.shrImm(VReg.V0, VReg.V0, 48);
        this.vm.cmpImm(VReg.V0, 0x7ffe);
        this.vm.jeq(arrPathLabel);
        this.vm.cmpImm(VReg.V0, 0x7ffd);
        this.vm.jeq(objPathLabel);
        this.vm.cmpImm(VReg.V0, 0x7fff);
        this.vm.jeq(objPathLabel);
        // classinfo(类对象)以「裸」指针存储(未 NaN-box,高16=0),[ptr+0]==3(TYPE_FUNCTION)。
        // 判别同 typeof:高16=0、非空、落在 [heap_base, heap_ptr) 且 [+0]==3 → 按对象迭代静态属性。
        // 闭包([+0]==0xc105)/裸函数([+0]≠3)不命中,仍跳过。循环体内的 classinfo 排除滤掉
        // __ctor__/prototype 与方法,只留静态数据字段。
        {
            if (this.vm.backend.name === "x64") {
                this.vm.load(VReg.RET, VReg.FP, ptrOffset); // V0 的 shrImm 破坏了 RAX,重载
            }
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(endLabel);
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(endLabel);
            this.vm.lea(VReg.V1, "_heap_base");
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.cmp(VReg.RET, VReg.V1);
            this.vm.jb(endLabel);
            this.vm.lea(VReg.V1, "_heap_ptr");
            this.vm.load(VReg.V1, VReg.V1, 0);
            this.vm.cmp(VReg.RET, VReg.V1);
            this.vm.jae(endLabel);
            this.vm.load(VReg.V1, VReg.RET, 0);
            this.vm.andImm(VReg.V1, VReg.V1, 0xff); // type 低字节(高字节可含标志位)
            // TypedArray 族(0x40..0x7f):自有键 "0".."n-1"(活长度)。走 forin 键表;
            // _object_keys 按 _typed_array_length 建索引键;gPO 对 TA 返 undefined → 停链。
            {
                const forinNotTa = this.ctx.newLabel("forin_not_ta");
                this.vm.cmpImm(VReg.V1, 0x40);
                this.vm.jlt(forinNotTa);
                this.vm.cmpImm(VReg.V1, 0x7f);
                this.vm.jle(objPathLabel);
                this.vm.label(forinNotTa);
            }
            this.vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION → classinfo
            this.vm.jne(endLabel);
            this.vm.jmp(objPathLabel);
        }

        // 数组：isObj=0
        this.vm.label(arrPathLabel);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, isObjOffset, VReg.V0);
        this.vm.jmp(startLabel);

        // 对象：isObj=1(旧:直扫自有 props,仅 classinfo)或 isObj=2(键表:_object_forin_keys
        // 自有+原型链可枚举串键,含 Function 闭包 name/length)。
        this.vm.label(objPathLabel);
        // x64:直达 0x7ffd 分派(非 classinfo 路径)到此时 RET 已被上面 tag 检测的
        // shrImm(V0,48) 破坏成裸 tag 值(V0==RET==RAX),须从暂存槽重载原始装箱对象——
        // 否则下面 store/脱壳把 tag(0x7ffd)当对象指针传给 _object_normalize_order 段错。
        // classinfo 路径已在上方重载,ptrOffset 仍holds原值,重载幂等。arm64 RET/V0
        // 异寄存器无需处理,target 守卫保持逐字节不变。
        if (this.vm.backend.name === "x64") {
            this.vm.load(VReg.RET, VReg.FP, ptrOffset);
        }
        this.vm.store(VReg.FP, ptrOffset, VReg.RET);
        // classinfo(裸 type=3):保留直扫自有 props(+方法过滤);普通对象/函数走 forin 键表。
        {
            const forinKeysL = this.ctx.newLabel("forin_use_keys");
            const forinOwnL = this.ctx.newLabel("forin_use_own");
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(forinKeysL);
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(forinKeysL);
            this.vm.loadByte(VReg.V1, VReg.RET, 0);
            this.vm.andImm(VReg.V1, VReg.V1, 0xff);
            this.vm.cmpImm(VReg.V1, 3);
            this.vm.jeq(forinOwnL);
            this.vm.label(forinKeysL);
            this.vm.load(VReg.A0, VReg.FP, ptrOffset);
            this.vm.call("_object_forin_keys"); // RET = 装箱键数组
            this.vm.store(VReg.FP, ptrOffset, VReg.RET);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.V0, 8); // length
            this.vm.store(VReg.FP, lenOffset, VReg.V1);
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, idxOffset, VReg.V0);
            this.vm.movImm(VReg.V0, 2); // isObj=2:迭代键表
            this.vm.store(VReg.FP, isObjOffset, VReg.V0);
            this.vm.store(VReg.FP, ptrOffset, VReg.RET); // 装箱键数组(yield 用 _array_get)
            this.vm.jmp(loopLabel);
            this.vm.label(forinOwnL);
        }
        // [enum-order] for-in 前把对象属性归一到 ES 规范序(整数键升序在前)。RET 此刻为
        // 装箱对象(或 classinfo 裸指针);存槽保活、脱壳传 A0、call 后重载(normalize 保
        // S0-S5 但破坏 RET/V/A)。classinfo(type=3)与非对象经 normalize 内 type 守卫跳过。
        this.vm.load(VReg.RET, VReg.FP, ptrOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.A0, VReg.RET, VReg.V1);
        this.vm.call("_object_normalize_order");
        this.vm.load(VReg.RET, VReg.FP, ptrOffset);
        this.vm.movImm(VReg.V0, 1);
        this.vm.store(VReg.FP, isObjOffset, VReg.V0);

        this.vm.label(startLabel);
        // 脱壳指针（数组/对象的 count 都在偏移 8）
        // x64: 从暂存槽重载被 shrImm 破坏的 RET（见上）。
        if (this.vm.backend.name === "x64") {
            this.vm.load(VReg.RET, VReg.FP, ptrOffset);
        }
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        this.vm.store(VReg.FP, ptrOffset, VReg.V0);
        // Proxy(type 字节 8):for-in 无 ownKeys 陷阱切片 → 迭代 target 的键(target@8 装箱,
        // 脱壳后替换 ptrOffset;数组/普通对象 type≠8 不受影响)。
        {
            const forinNotProxy = this.ctx.newLabel("forin_notproxy");
            this.vm.loadByte(VReg.V1, VReg.V0, 0);
            this.vm.andImm(VReg.V1, VReg.V1, 0xff);
            this.vm.cmpImm(VReg.V1, 8);
            this.vm.jne(forinNotProxy);
            this.vm.load(VReg.V0, VReg.V0, 8); // target(装箱)
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
            this.vm.store(VReg.FP, ptrOffset, VReg.V0);
            this.vm.label(forinNotProxy);
        }
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.load(VReg.V0, VReg.FP, ptrOffset);
        this.vm.load(VReg.V1, VReg.V0, 8);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        // 获取迭代变量名
        let varName = null;
        let keyPattern = null;
        let keyPatternMode = "decl";
        let leftMember = null;
        if (stmt.left.type === "VariableDeclaration" && stmt.left.declarations.length > 0) {
            const decl = stmt.left.declarations[0];
            if (decl.id.type === "Identifier") {
                varName = decl.id.name;
            } else if (decl.id.type === "ArrayPattern" || decl.id.type === "ObjectPattern") {
                // for(var [i,j,k] in obj):键(字符串/键名)按 pattern 解构
                keyPattern = decl.id;
                keyPatternMode = "decl";
            }
        } else if (stmt.left.type === "Identifier") {
            varName = stmt.left.name;
        } else if (stmt.left.type === "MemberExpression") {
            // for (obj.p in src) / for (arr[i] in src):PutValue(MemberExpression, key)
            leftMember = stmt.left;
        } else if (stmt.left.type === "ArrayPattern" || stmt.left.type === "ObjectPattern") {
            // [test262 S1] 非声明式 for ([a,b] in obj):赋值形解构,键写入既有 lvalue
            keyPattern = stmt.left;
            keyPatternMode = "assign";
        } else if (stmt.left.type === "ArrayExpression" || stmt.left.type === "ObjectExpression") {
            // [test262 S1] 非声明式 for ([a,b] in obj):parser 传表达式左值,重解释为赋值形 pattern
            keyPattern = this.reinterpretAsPattern(stmt.left);
            keyPatternMode = "assign";
        }

        // 分配迭代变量
        const varOffset = varName ? this.ctx.allocLocal(varName) : null;

        this.vm.label(loopLabel);

        // 检查 i < length/count；耗尽时:对象/已切侧表 → 结束；数组 → 尝试侧表具名键
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(exhaustedLabel);

        // 取当前键：对象→属性键(装箱字符串)；数组→原始索引（沿用旧行为）
        this.vm.load(VReg.V0, VReg.FP, isObjOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jne(yieldObjLabel);
        // 数组：键为索引的**字符串**(ES 语义:for-in 键恒为字符串,typeof k === "string",
        // `k + 1` 是拼接不是加法)。曾因 arr["0"] 字符串下标未支持而 yield 装箱数字(记为
        // 偏差);规范索引串下标已落地(_canonical_array_index/_subscript_key_int),故按
        // 规范改回字符串:_intToStr(裸 int) 直接返回 0x7FFC 装箱串,`arr[k]` 仍正确取元素。
        this.vm.load(VReg.A0, VReg.FP, idxOffset);
        this.vm.call("_intToStr");        // RET = 装箱字符串键
        this.vm.jmp(afterYieldLabel);

        // ---- 索引/属性耗尽 ----
        this.vm.label(exhaustedLabel);
        this.vm.load(VReg.V0, VReg.FP, isObjOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jne(endLabel); // 对象路径/键表/侧表阶段已走完
        // 数组索引耗尽:无 ARR_HAS_SIDETABLE(bit1@byte1)→O(1) 结束(真数组热路径不变)。
        // 有侧表 → 切到 props 对象,按对象路径枚举具名可枚举键(arguments/arr.foo 等)。
        this.vm.load(VReg.V0, VReg.FP, ptrOffset); // 裸数组
        this.vm.loadByte(VReg.V1, VReg.V0, 1);
        this.vm.andImm(VReg.V1, VReg.V1, 2); // ARR_HAS_SIDETABLE
        this.vm.cmpImm(VReg.V1, 0);
        this.vm.jeq(endLabel);

        this.vm.label(sideSwitchLabel);
        // A0=裸数组(高16=0);_closure_props_find 内部 MASK 脱壳,与装箱等价。
        this.vm.load(VReg.A0, VReg.FP, ptrOffset);
        this.vm.call("_closure_props_find"); // RET=装箱 props 或 undefined
        this.vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        this.vm.cmp(VReg.RET, VReg.V1);
        this.vm.jeq(endLabel);
        // 归一 props 键序后切到对象迭代(复用 yieldObjLabel 的 enumerable/symbol 过滤)。
        this.vm.store(VReg.FP, ptrOffset, VReg.RET); // 暂存装箱 props
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.A0, VReg.RET, VReg.V1);
        this.vm.call("_object_normalize_order");
        this.vm.load(VReg.RET, VReg.FP, ptrOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        this.vm.store(VReg.FP, ptrOffset, VReg.V0); // 裸 props
        this.vm.load(VReg.V1, VReg.V0, 8); // count
        this.vm.store(VReg.FP, lenOffset, VReg.V1);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.movImm(VReg.V0, 1);
        this.vm.store(VReg.FP, isObjOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(yieldObjLabel);
        // isObj=2:ptrOffset 为 _object_forin_keys 装箱键数组 → _array_get
        {
            const forinOwnYieldL = this.ctx.newLabel("forin_own_yield");
            this.vm.load(VReg.V0, VReg.FP, isObjOffset);
            this.vm.cmpImm(VReg.V0, 2);
            this.vm.jne(forinOwnYieldL);
            this.vm.load(VReg.A0, VReg.FP, ptrOffset);
            this.vm.load(VReg.A1, VReg.FP, idxOffset);
            this.vm.call("_array_get");
            this.vm.jmp(afterYieldLabel);
            this.vm.label(forinOwnYieldL);
        }
        // [#61 P3] 跳过不可枚举属性(defineProperty enumerable:false):flags_ptr@40==0 →
        // 全默认可枚举(快路,自举对象恒此路);否则 flags[idx]&ATTR_ENUMERABLE==0 → 跳到
        // continue(i++ 后循环,不 yield 该键、不执行循环体)。
        {
            const enumOkL = this.ctx.newLabel("forin_enum_ok");
            this.vm.load(VReg.V1, VReg.FP, ptrOffset);
            this.vm.load(VReg.V1, VReg.V1, 40); // flags_ptr@40
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jeq(enumOkL);
            this.vm.load(VReg.V0, VReg.FP, idxOffset);
            this.vm.add(VReg.V1, VReg.V1, VReg.V0);
            this.vm.loadByte(VReg.V1, VReg.V1, 0); // attr byte
            this.vm.movImm(VReg.V0, 2); // ATTR_ENUMERABLE
            this.vm.and(VReg.V1, VReg.V1, VReg.V0);
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jeq(continueLabel);
            this.vm.label(enumOkL);
        }
        // 对象：props 在独立分配区（C 对象增长后布局：props_ptr@32，key@props_ptr+idx*16）。
        // 旧码读内联 [ptr+24+idx*16] 是 C 重构前布局 → 读到 capacity/props_ptr 当"键"→ 垃圾/0。
        this.vm.load(VReg.V1, VReg.FP, ptrOffset);
        this.vm.load(VReg.V1, VReg.V1, 32);        // props_ptr
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.shlImm(VReg.V0, VReg.V0, 4);       // idx * PROP_SIZE(16)
        this.vm.add(VReg.V0, VReg.V1, VReg.V0);
        this.vm.load(VReg.RET, VReg.V0, 0);        // 键（装箱字符串或 symbol）
        // symbol 键排除:for-in 不枚举 symbol 键(属 getOwnPropertySymbols)。
        {
            const kTmp = this.ctx.allocLocal(`__forin_symchk_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, kTmp, VReg.RET);
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_is_symbol");
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jne(continueLabel); // symbol → 跳过该键
            this.vm.load(VReg.RET, VReg.FP, kTmp); // 重取键(RET 被 _is_symbol 冲掉)
        }
        // classinfo(类对象,低字节 type==3)排除:内部槽 __ctor__/prototype(idx<2)与
        // 静态方法(值为 function)。普通对象/数组不受影响。RET(键)经 V0/V1 检查存活。
        {
            const ciOk = this.ctx.newLabel("forin_ci_ok");
            this.vm.load(VReg.V1, VReg.FP, ptrOffset);
            this.vm.loadByte(VReg.V1, VReg.V1, 0);
            this.vm.andImm(VReg.V1, VReg.V1, 0xff);
            this.vm.cmpImm(VReg.V1, 3);
            this.vm.jne(ciOk);
            this.vm.load(VReg.V0, VReg.FP, idxOffset);
            this.vm.cmpImm(VReg.V0, 2);
            this.vm.jlt(continueLabel); // __ctor__/prototype
            this.vm.load(VReg.V1, VReg.FP, ptrOffset);
            this.vm.load(VReg.V1, VReg.V1, 32); // props_ptr
            this.vm.load(VReg.V0, VReg.FP, idxOffset);
            this.vm.shlImm(VReg.V0, VReg.V0, 4);
            this.vm.add(VReg.V1, VReg.V1, VReg.V0);
            this.vm.load(VReg.V1, VReg.V1, 8); // value
            this.vm.shrImm(VReg.V1, VReg.V1, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFF); // function → 方法,跳过
            this.vm.jeq(continueLabel);
            this.vm.label(ciOk);
        }

        this.vm.label(afterYieldLabel);
        // 存储到迭代变量（被闭包捕获时装箱）
        if (keyPattern) {
            // for([a,b] in obj):键(RET)落临时槽,按 pattern 解构(声明形)。
            const kSlot = this.ctx.allocLocal(`__forin_key_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, kSlot, VReg.RET);
            this.emitDestructurePattern(keyPattern, kSlot, keyPatternMode);
        } else if (leftMember) {
            const kSlot = this.ctx.allocLocal(`__forin_mlhs_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, kSlot, VReg.RET);
            this.compileExpression({
                type: "AssignmentExpression",
                operator: "=",
                left: leftMember,
                right: { type: "__WithPrecomputed", slot: kSlot },
            });
        } else {
            this.storeLoopVar(varName, varOffset);
        }

        // 编译循环体
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);

        this.vm.label(continueLabel);

        // i++
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(endLabel);

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
        this._restoreLabels(savedLabels); // [#60]
    },

    // 编译 do-while 语句
    compileDoWhileStatement(stmt) {
        const loopLabel = this.ctx.newLabel("dowhile");
        const continueLabel = this.ctx.newLabel("dowhile_continue");
        const endLabel = this.ctx.newLabel("enddowhile");

        // 保存循环标签
        const savedBreak = this.ctx.breakLabel;
        const savedContinue = this.ctx.continueLabel;
        // [#38] 记录循环边界处的 try 深度:break/continue 跨出 try 时按此恢复链头
        const savedBreakTryLen = this.ctx.breakTryLen;
        const savedContinueTryLen = this.ctx.continueTryLen;
        const savedBreakIterCloseLen = this.ctx.breakIterCloseLen;
        const savedContinueIterCloseLen = this.ctx.continueIterCloseLen;
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.continueTryLen = this.ctx.breakTryLen;
        this.ctx.breakIterCloseLen = this.ctx.iterCloseStack ? this.ctx.iterCloseStack.length : 0;
        this.ctx.continueIterCloseLen = this.ctx.breakIterCloseLen;
        this.ctx.breakLabel = endLabel;
        // continue 须跳到条件求值(非 loopLabel),否则 `continue L` 嵌套 for-of
        // 会重跑 body → 无限迭代(iterator-close-via-continue)。
        this.ctx.continueLabel = continueLabel;
        const savedLabels = this._registerPendingLabels(endLabel); // [#60]

        this.vm.label(loopLabel);
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);

        this.vm.label(continueLabel);
        // [cptn-abrupt-empty] 条件求值会覆盖 RET;退出循环时须恢复 body/continue
        // 的完成值(含 with 内 `10; continue` → 10,而非 test 的 false→0)。
        const dowhileCmpOff = this.ctx.allocLocal(`__dowhile_cmp_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, dowhileCmpOff, VReg.RET);
        this.compileExpression(stmt.test);
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(loopLabel);
        this.vm.load(VReg.RET, VReg.FP, dowhileCmpOff);

        this.vm.label(endLabel);

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
        this.ctx.breakIterCloseLen = savedBreakIterCloseLen;
        this.ctx.continueIterCloseLen = savedContinueIterCloseLen;
        this._restoreLabels(savedLabels); // [#60]
    },

    // 编译 break 语句
    // [#60] 标签目标是否最终落在循环上(穿透 `a: b: for` 这样的标签链)。
    // 循环需登记 break+continue 两个目标;switch/块/其它语句作纯 break 目标处理。
    _labelTargetsLoop(node) {
        let n = node;
        while (n && n.type === "LabeledStatement") n = n.body;
        if (!n) return false;
        return n.type === "WhileStatement" || n.type === "ForStatement" ||
               n.type === "ForOfStatement" || n.type === "ForInStatement" ||
               n.type === "DoWhileStatement";
    },

    // [#60] 消费 ctx.pendingLabels(compileLabeledStatement 压入的待登记标签),
    // 为每个标签在 labelMap 登记 {break/continue 目标 + 边界 try 深度}。
    // continueLabel 先置空,待 _bindLabelContinue 在编译循环体前按当前 ctx.continueLabel 绑定
    //(for-of/for-in 分多路径各编译一次循环体,continue 点不同,故按路径绑定)。
    // 必须在 breakTryLen/continueTryLen 设定之后调用。返回还原凭据(供 _restoreLabels)。
    _registerPendingLabels(breakLabel) {
        const pending = this.ctx.pendingLabels;
        this.ctx.pendingLabels = null; // 已消费;循环体内嵌套循环不得复用
        if (!pending || pending.length === 0) return null;
        if (!this.ctx.labelMap) this.ctx.labelMap = new Map();
        const btl = this.ctx.breakTryLen;
        const ctl = this.ctx.continueTryLen;
        const bic = this.ctx.breakIterCloseLen || 0;
        const cic = this.ctx.continueIterCloseLen || 0;
        const saved = [];
        for (let i = 0; i < pending.length; i++) {
            const name = pending[i];
            const entry = {
                breakLabel, continueLabel: null,
                breakTryLen: btl, continueTryLen: ctl,
                breakIterCloseLen: bic, continueIterCloseLen: cic,
            };
            saved.push({ name, old: this.ctx.labelMap.get(name), entry });
            this.ctx.labelMap.set(name, entry);
        }
        return saved;
    },

    // [#60] 编译循环体前调用:把当前 ctx.continueLabel 绑到本轮登记的标签。
    _bindLabelContinue(saved) {
        if (!saved) return;
        const cl = this.ctx.continueLabel;
        const cic = this.ctx.continueIterCloseLen || 0;
        for (let i = 0; i < saved.length; i++) {
            saved[i].entry.continueLabel = cl;
            saved[i].entry.continueIterCloseLen = cic;
        }
    },

    // [#60] 还原 labelMap(标签作用域仅限被标注语句)。
    _restoreLabels(saved) {
        if (!saved) return;
        for (let i = 0; i < saved.length; i++) {
            const s = saved[i];
            if (s.old === undefined) this.ctx.labelMap.delete(s.name);
            else this.ctx.labelMap.set(s.name, s.old);
        }
    },

    // [#60] 编译标签语句 `label: stmt`。
    // - 标签最终落在循环上:压入 pendingLabels,由该循环登记 break+continue 目标。
    // - 否则(块/switch/其它):作纯 break 目标——建 endLabel,编译体,末尾落 endLabel。
    compileLabeledStatement(stmt) {
        const name = stmt.label.name;
        if (this._labelTargetsLoop(stmt.body)) {
            if (!this.ctx.pendingLabels) this.ctx.pendingLabels = [];
            this.ctx.pendingLabels.push(name);
            this.compileStatement(stmt.body); // 循环消费 pendingLabels 并自负登记/还原
            return;
        }
        // 非循环标签:仅支持 break(`blk: { break blk; }`)。continue 落此为语法错误,不登记。
        const endLabel = this.ctx.newLabel("label_" + name);
        if (!this.ctx.labelMap) this.ctx.labelMap = new Map();
        const boundary = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        const entry = { breakLabel: endLabel, continueLabel: null, breakTryLen: boundary, continueTryLen: boundary };
        const old = this.ctx.labelMap.get(name);
        this.ctx.labelMap.set(name, entry);
        this.compileStatement(stmt.body);
        this.vm.label(endLabel);
        if (old === undefined) this.ctx.labelMap.delete(name);
        else this.ctx.labelMap.set(name, old);
    },

    compileBreakStatement(stmt) {
        // [#60] 带标签:跳到 labelMap 登记的对应层 break 目标,并跑跨越的 finalizer
        if (stmt.label) {
            const entry = this.ctx.labelMap ? this.ctx.labelMap.get(stmt.label.name) : undefined;
            if (entry && entry.breakLabel) {
                this.emitPendingIteratorCloses(entry.breakIterCloseLen || 0, false);
                this.emitPendingFinalizers(entry.breakTryLen, false);
                if (this.ctx.tryFrames && this.ctx.tryFrames.length > entry.breakTryLen) {
                    this.emitExcCtxRestore(this.ctx.tryFrames[entry.breakTryLen]);
                }
                this.vm.jmp(entry.breakLabel);
            }
            return;
        }
        if (this.ctx.breakLabel) {
            this.emitPendingIteratorCloses(this.ctx.breakIterCloseLen || 0, false);
            // [#54] break 跨越边界内含 finally 的 try:从内到外先跑各 finalizer
            this.emitPendingFinalizers(this.ctx.breakTryLen, false);
            // [#38] break 跨出 try:恢复链头为循环/switch 边界处深度的 try 的 link
            if (this.ctx.tryFrames && this.ctx.tryFrames.length > this.ctx.breakTryLen) {
                this.emitExcCtxRestore(this.ctx.tryFrames[this.ctx.breakTryLen]);
            }
            this.vm.jmp(this.ctx.breakLabel);
        }
    },

    // 编译 continue 语句
    compileContinueStatement(stmt) {
        // [#60] 带标签:跳到 labelMap 登记的对应层 continue 目标,并跑跨越的 finalizer
        if (stmt.label) {
            const entry = this.ctx.labelMap ? this.ctx.labelMap.get(stmt.label.name) : undefined;
            if (entry && entry.continueLabel) {
                this.emitPendingIteratorCloses(entry.continueIterCloseLen || 0, false);
                this.emitPendingFinalizers(entry.continueTryLen, false);
                if (this.ctx.tryFrames && this.ctx.tryFrames.length > entry.continueTryLen) {
                    this.emitExcCtxRestore(this.ctx.tryFrames[entry.continueTryLen]);
                }
                this.vm.jmp(entry.continueLabel);
            }
            return;
        }
        if (this.ctx.continueLabel) {
            this.emitPendingIteratorCloses(this.ctx.continueIterCloseLen || 0, false);
            // [#54] continue 跨越边界内含 finally 的 try:从内到外先跑各 finalizer
            this.emitPendingFinalizers(this.ctx.continueTryLen, false);
            // [#38] continue 跨出 try:同 break,边界为所属循环入口
            if (this.ctx.tryFrames && this.ctx.tryFrames.length > this.ctx.continueTryLen) {
                this.emitExcCtxRestore(this.ctx.tryFrames[this.ctx.continueTryLen]);
            }
            this.vm.jmp(this.ctx.continueLabel);
        }
    },

    // 编译 switch 语句
    compileSwitchStatement(stmt) {
        const endLabel = this.ctx.newLabel("switch_end");
        const cases = stmt.cases || [];

        // 保存 break 标签
        const savedBreak = this.ctx.breakLabel;
        // [#38] switch 也是 break 边界(不动 continueTryLen:continue 属外层循环)
        const savedBreakTryLen = this.ctx.breakTryLen;
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.breakLabel = endLabel;

        // switch 体内 class 是块级绑定:须 enterScope,否则 allocLocal(类名)落在
        // 函数/_main 帧,`switch { class x {} } x` 外层仍能读到类(scope-lex-class)。
        const switchClassScope = this._switchNeedsClassScope(stmt);
        const savedSwitchScope = switchClassScope ? this.ctx.enterScope() : null;

        this.emitTdzBlockPrologue(stmt); // [批次D TDZ] switch 体共享一个块作用域

        // 编译 discriminant，保存到 callee-saved 寄存器
        this.compileExpression(stmt.discriminant);
        this.vm.mov(VReg.S0, VReg.RET);

        // 生成每个 case 的标签
        const caseLabels = [];
        let defaultLabel = null;

        for (let i = 0; i < cases.length; i++) {
            if (cases[i].test === null) {
                defaultLabel = this.ctx.newLabel("case_default");
                caseLabels.push(defaultLabel);
            } else {
                caseLabels.push(this.ctx.newLabel("case_" + i));
            }
        }

        // 比较并跳转
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            if (c.test !== null) {
                // 一律用**值**相等 _strict_eq,不能用裸寄存器 cmp:
                // - 字符串:运行时构造的串与 case 常量指针不同,指针比较恒不匹配;
                // - 数值:discriminant 是 raw float64 位(2.0=0x4000...),旧的
                //   movImm 整数 + 原始位 cmp 永不相等 → 数值 case 全落 default
                //   (#28 静默错值实锤;旧注释"存的是原始整数值"早已失效)。
                // _strict_eq 做 int 装箱/raw float/堆 Number 的形态归一。
                this.compileExpression(c.test);   // RET = case 值
                this.vm.mov(VReg.A1, VReg.RET);    // A1 = case 值（先取，A0/RET 同 X0）
                this.vm.mov(VReg.A0, VReg.S0);     // A0 = discriminant
                this.vm.call("_strict_eq");         // RET = JS_TRUE/JS_FALSE
                this.vm.movImm64(VReg.V1, 0x7ff9000000000001n); // JS_TRUE
                this.vm.cmp(VReg.RET, VReg.V1);
                this.vm.jeq(caseLabels[i]);
            }
        }

        // 跳转到 default 或结束
        if (defaultLabel) {
            this.vm.jmp(defaultLabel);
        } else {
            this.vm.jmp(endLabel);
        }

        // 生成 case 代码
        for (let i = 0; i < cases.length; i++) {
            this.vm.label(caseLabels[i]);
            for (const s of cases[i].consequent) {
                this.compileStatement(s);
            }
        }

        this.vm.label(endLabel);
        if (switchClassScope) this.ctx.leaveScope(savedSwitchScope);
        this.ctx.breakLabel = savedBreak;
        this.ctx.breakTryLen = savedBreakTryLen;
    },

    // 编译 try 语句
    compileTryStatement(stmt) {
        const endLabel = this.ctx.newLabel("endtry");
        const savedExceptionLabel = this.ctx.exceptionLabel;
        const hasHandler = !!stmt.handler;
        const hasFinalizer = !!stmt.finalizer;

        const catchLabel = hasHandler ? this.ctx.newLabel("catch") : null;
        // finally-on-exception：块/catch 抛出时先跑 finally 再向外重抛
        const finallyExcLabel = hasFinalizer ? this.ctx.newLabel("finally_exc") : null;

        // [#38] 含 try 的函数放弃槽位晋升:unwind 会把 S 寄存器回滚到 try-enter
        // 快照,晋升槽若驻留 S 寄存器,catch 里会读到旧值。直发保证槽位常驻 FP。
        if (this.vm._recN >= 0) this.vm._flushRecordVerbatim();

        // [#38] 在本函数栈帧分配 80B catch 上下文帧(10 槽,allocLocal 偏移递减,
        // 取最后一个为最低偏移基址)。布局:
        // {link@0, catchPC@8, SP@16, FP@24, S0@32, S1@40, S2@48, S3@56, S4@64, S5@72}
        let excFrameOff = 0;
        for (let excFi = 0; excFi < 10; excFi++) {
            excFrameOff = this.ctx.allocLocal(this.ctx.newLabel("__excframe"));
        }
        if (!this.ctx.tryFrames) this.ctx.tryFrames = [];
        this.ctx.tryFrames.push(excFrameOff);

        // [#54] 含 finally 的 try 压入 finallyStack:abrupt(return/break/continue)
        // 跨越本 try 时,emitPendingFinalizers 据此从内到外内联各 finalizer。
        // outerExcLabel = 本 try 之外的 handler(= savedExceptionLabel,finalizer 内
        // 抛出时的去向);tfIndex = 本 try 在 tryFrames 中的下标(= 边界深度判定)。
        if (!this.ctx.finallyStack) this.ctx.finallyStack = [];
        if (hasFinalizer) {
            this.ctx.finallyStack.push({
                finalizer: stmt.finalizer,
                outerExcLabel: savedExceptionLabel,
                frameOff: excFrameOff,
                tfIndex: this.ctx.tryFrames.length - 1,
            });
        }

        // 压帧:link=旧链头,快照 unwind 目标/SP/FP/S0-S5,链头指向本帧
        const unwindTarget = hasHandler ? catchLabel : finallyExcLabel;
        this.vm.lea(VReg.V0, "_exc_ctx_top");
        this.vm.load(VReg.V1, VReg.V0, 0);
        this.vm.store(VReg.FP, excFrameOff + 0, VReg.V1);
        this.vm.lea(VReg.V1, unwindTarget);
        this.vm.store(VReg.FP, excFrameOff + 8, VReg.V1);
        this.vm.mov(VReg.V1, VReg.SP);
        this.vm.store(VReg.FP, excFrameOff + 16, VReg.V1);
        this.vm.store(VReg.FP, excFrameOff + 24, VReg.FP);
        this.vm.store(VReg.FP, excFrameOff + 32, VReg.S0);
        this.vm.store(VReg.FP, excFrameOff + 40, VReg.S1);
        this.vm.store(VReg.FP, excFrameOff + 48, VReg.S2);
        this.vm.store(VReg.FP, excFrameOff + 56, VReg.S3);
        this.vm.store(VReg.FP, excFrameOff + 64, VReg.S4);
        this.vm.mov(VReg.V1, VReg.S5); // x64 S5 是栈槽,经 mov 取出
        this.vm.store(VReg.FP, excFrameOff + 72, VReg.V1);
        this.vm.subImm(VReg.V1, VReg.FP, -excFrameOff); // V1 = 帧地址(偏移为负)
        this.vm.store(VReg.V0, 0, VReg.V1);

        // try 块内异常的去向：有 catch 走 catch；否则有 finally 走 finally 重抛；再否则外层
        this.ctx.exceptionLabel = hasHandler
            ? catchLabel
            : (hasFinalizer ? finallyExcLabel : savedExceptionLabel);

        this.compileStatement(stmt.block);

        // 块正常结束：弹帧,跑 finally，去 end
        this.emitExcCtxRestore(excFrameOff);
        if (hasFinalizer) {
            this.emitDirectFinalizer(stmt.finalizer);
        }
        this.vm.jmp(endLabel);

        if (hasHandler) {
            this.vm.label(catchLabel);
            // [#38] 弹帧:unwind 到达时链头仍指向本帧(须弹,否则 catch 内再抛会
            // 无限回到自己);本地 jmp 到达时幂等
            this.emitExcCtxRestore(excFrameOff);

            // [fix-stack-corrupt] 本地 jmp exceptionLabel 未恢复 SP:
            // try 块内 push 未配 pop 就抛异常(如二元表达式求值) → SP 偏移
            // → 函数返回时读错返回地址 → SIGBUS。从异常帧快照恢复 SP。
            this.vm.load(VReg.V2, VReg.FP, excFrameOff + 16);
            this.vm.mov(VReg.SP, VReg.V2);

            this.vm.lea(VReg.V0, "_exception_pending");
            this.vm.movImm(VReg.V1, 0);
            this.vm.store(VReg.V0, 0, VReg.V1);

            // catch 体内异常：有 finally 先跑 finally 再重抛，否则直接外层。
            // 必须先于 catch 头解构设置:解构本身可抛(catch ([[x]]) { } 捕获 null →
            // TypeError),若仍指向本 catch 的落点 → 跳回本 catch 再抛 → 无限循环
            // (try/dstr ary-ptrn-elem-ary-val-null 族 TIMEOUT 根因)。
            this.ctx.exceptionLabel = hasFinalizer ? finallyExcLabel : savedExceptionLabel;

            if (stmt.handler.param && stmt.handler.param.type === "Identifier") {
                const name = stmt.handler.param.name;
                let offset = this.ctx.getLocal(name);
                if (!offset) {
                    offset = this.ctx.allocLocal(name);
                }
                this.vm.lea(VReg.V0, "_exception_value");
                this.vm.load(VReg.V1, VReg.V0, 0);
                this.vm.store(VReg.FP, offset, VReg.V1);
            } else if (stmt.handler.param &&
                       (stmt.handler.param.type === "ObjectPattern" || stmt.handler.param.type === "ArrayPattern")) {
                // catch 头解构 catch([i,j])/catch({a,b}):异常值落临时槽,复用声明形解构。
                const excSlot = this.ctx.allocLocal(`__catchexc_${this.nextLabelId()}`);
                this.vm.lea(VReg.V0, "_exception_value");
                this.vm.load(VReg.V1, VReg.V0, 0);
                this.vm.store(VReg.FP, excSlot, VReg.V1);
                this.emitDestructurePattern(stmt.handler.param, excSlot, "decl");
            }

            this.compileStatement(stmt.handler.body);

            if (hasFinalizer) {
                this.emitDirectFinalizer(stmt.finalizer);
            }
            this.vm.jmp(endLabel);
        }

        if (hasFinalizer) {
            // 异常在途(_exception_pending=1)：跑 finally 后向外重抛
            this.vm.label(finallyExcLabel);
            // [#38] 弹帧(unwind 到达时链头仍指向本帧;本地 jmp 到达时幂等)
            this.emitExcCtxRestore(excFrameOff);

            // [fix-stack-corrupt] 恢复 SP(同 catchLabel)
            this.vm.load(VReg.V2, VReg.FP, excFrameOff + 16);
            this.vm.mov(VReg.SP, VReg.V2);

            // [#async-finally] 暂存 _exception_pending/exception_value 到 FP 槽并清 pending,
            // 防止 finally 块内的 await 误读残留异常(如 try { await reject() } finally { ... })。
            // finalizer 若以 return/throw 跳出则不回来;正常走完则恢复异常值继续传播。
            const finExcPendingSlot = this.ctx.allocLocal("__fin_exc_pending");
            const finExcValueSlot = this.ctx.allocLocal("__fin_exc_value");
            this.vm.lea(VReg.V0, "_exception_pending");
            this.vm.load(VReg.V1, VReg.V0, 0);
            this.vm.store(VReg.FP, finExcPendingSlot, VReg.V1);
            this.vm.lea(VReg.V0, "_exception_value");
            this.vm.load(VReg.V1, VReg.V0, 0);
            this.vm.store(VReg.FP, finExcValueSlot, VReg.V1);
            // 清 pending:finally 块内 await/throw 观察不到外部异常
            this.vm.lea(VReg.V0, "_exception_pending");
            this.vm.movImm(VReg.V1, 0);
            this.vm.store(VReg.V0, 0, VReg.V1);

            this.ctx.exceptionLabel = savedExceptionLabel;
            this.emitDirectFinalizer(stmt.finalizer);

            // finalizer 正常走完:恢复异常值并传播(returnLabel 路径不会到达这里)
            this.vm.load(VReg.V1, VReg.FP, finExcPendingSlot);
            this.vm.lea(VReg.V0, "_exception_pending");
            this.vm.store(VReg.V0, 0, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, finExcValueSlot);
            this.vm.lea(VReg.V0, "_exception_value");
            this.vm.store(VReg.V0, 0, VReg.V1);

            if (savedExceptionLabel) {
                this.vm.jmp(savedExceptionLabel);
            } else if (this.ctx.inCoroBody && this.ctx.returnLabel) {
                // [gen unwind] 协程体:finally 跑完后不可跨栈重抛(见 emitThrowValue 注)。
                // 跳 returnLabel 完成协程(pending 保留)→ 调用方栈上传播。
                this.vm.jmp(this.ctx.returnLabel);
            } else {
                // [#38] 无本函数外层 try:沿 catch 上下文链跨函数重抛
                this.vm.call("_throw_unwind");
            }
        }

        this.vm.label(endLabel);
        this.ctx.exceptionLabel = savedExceptionLabel;
        if (hasFinalizer) this.ctx.finallyStack.pop(); // [#54] 与 push 平衡
        this.ctx.tryFrames.pop();
    },

    // 编译 throw 语句
    compileThrowStatement(stmt) {
        if (stmt.argument) {
            this.compileExpression(stmt.argument);
        } else {
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
        }
        this.emitThrowValue(VReg.RET);
    },

    // 语句是否为顶层 `super(...)` 调用(派生类构造体字段初始化注入点判别)。
    _isSuperCallStmt(stmt) {
        return !!(stmt && stmt.type === "ExpressionStatement" && stmt.expression &&
            stmt.expression.type === "CallExpression" && stmt.expression.callee &&
            stmt.expression.callee.type === "SuperExpression");
    },

    // 实例计算键 `[k]`(k 非字符串/数字字面量):ClassElementName 须在类定义时求值,
    // 不能在构造器里 compileExpression(field.key)——构造器是嵌套函数,闭包分析
    // 看不到字段 AST 上的 `[x]`,外层 `var x` 未捕获 → ReferenceError。
    // 字面量计算键 `["x"]`/`[10]` 的 key.value 已是名字,走静态 fieldName 路径。
    _isRuntimeComputedFieldKey(field) {
        return !!(field && field.computed && field.key &&
            field.key.type !== "Literal" &&
            field.key.type !== "StringLiteral" &&
            field.key.type !== "NumericLiteral");
    },

    // 静态字段名归一(与 _classMethodKeyName 同构):标识符名 / 字符串字面量(含空串)/
    // 数字字面量 / null / 布尔 → 字符串键。此前站点用 `key.name || key.value`:
    // `[0]`/`[""]`/`[false]` 的键是 falsy → 当无效键**整条字段丢弃**;数字键还以
    // number 传进 addStringConstant(静态字段路径漏 String() → 键错)。
    _classFieldKeyName(field) {
        const k = field && field.key;
        if (!k) return null;
        if (typeof k.name === "string") return k.name;
        if (k.value === null) return "null"; // `[null] = v` → 键 "null"
        const t = typeof k.value;
        if (t === "string") return k.value;
        if (t === "number" || t === "boolean") return String(k.value);
        return null;
    },

    // 私有类成员键:PrivateIdentifier,或解析器 `*` 分支产出的 Identifier{name:"#m"}
    // (与 emitClassMethodTable / getMemberPropertyName 的 W-34 判据一致)。
    _isPrivateClassKey(key) {
        if (!key) return false;
        if (key.type === "PrivateIdentifier") return true;
        const n = key.name || key.value;
        return key.type === "Identifier" && typeof n === "string" && n[0] === "#";
    },

    // RET = 原始键值 → RET = ToPropertyKey(字符串或 symbol 键)。
    // 对齐静态字段:symbol → _js_prop_key,否则 _valueToStr(避免 Symbol 走 ToString 抛 TypeError)。
    emitToPropertyKey() {
        const kraw = this.ctx.allocLocal(`__tpk_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, kraw, VReg.RET);
        const isSym = this.ctx.newLabel("tpk_sym");
        const done = this.ctx.newLabel("tpk_done");
        this.vm.load(VReg.A0, VReg.FP, kraw);
        this.vm.call("_is_symbol");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(isSym);
        this.vm.load(VReg.A0, VReg.FP, kraw);
        this.vm.call("_valueToStr");
        this.vm.jmp(done);
        this.vm.label(isSym);
        this.vm.load(VReg.A0, VReg.FP, kraw);
        this.vm.call("_js_prop_key");
        this.vm.label(done);
    },

    // 类定义时求所有实例计算键,存入 `_cfkeys_<类>__<id>` 全局数组(GC 根,同 _classinfo_)。
    // 须在外层 ctx(类声明作用域)发射,使 `var x`/`var y`/ToPrimitive 对象可见。
    emitInstanceComputedKeys(instanceFields, cfkeysLabel) {
        if (!cfkeysLabel) return;
        let n = 0;
        for (let i = 0; i < instanceFields.length; i++) {
            if (this._isRuntimeComputedFieldKey(instanceFields[i])) n++;
        }
        if (n === 0) return;
        this.vm.push(VReg.S0);
        this.vm.movImm(VReg.A0, n);
        this.vm.call("_array_new_with_size");
        const arrSlot = this.ctx.allocLocal(`__cfkeys_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrSlot, VReg.RET);
        let ki = 0;
        for (let i = 0; i < instanceFields.length; i++) {
            const field = instanceFields[i];
            if (!this._isRuntimeComputedFieldKey(field)) continue;
            this.compileExpression(field.key);
            this.emitToPropertyKey();
            this.vm.mov(VReg.A2, VReg.RET);
            this.vm.load(VReg.A0, VReg.FP, arrSlot);
            this.vm.movImm(VReg.A1, ki);
            this.vm.call("_array_set");
            ki++;
        }
        this.vm.load(VReg.V0, VReg.FP, arrSlot);
        this.vm.lea(VReg.V1, cfkeysLabel);
        this.vm.store(VReg.V1, 0, VReg.V0);
        this.vm.pop(VReg.S0);
    },

    // 实例字段 + 私有字段初始化(基类:构造体前;派生类:super() 后)。this 从 __this
    // 局部重载(字段初值可为破坏 A0/栈的复杂表达式),与原内联实现逐指令一致。
    // 计算键按下标从类定义期填好的 cfkeys 数组取,不再在构造器里求 field.key。
    emitCtorFieldInits(instanceFields, privateFields, className, thisOffset, cfkeysLabel, privateMethods, labelId) {
        let cfKeyIdx = 0;
        for (const field of instanceFields) {
            const cfRuntimeKey = this._isRuntimeComputedFieldKey(field);
            const fieldName = cfRuntimeKey ? null : this._classFieldKeyName(field);
            if (cfRuntimeKey) {
                const thisKeyIdx = cfKeyIdx++;
                this.vm.lea(VReg.A0, cfkeysLabel);
                this.vm.load(VReg.A0, VReg.A0, 0);
                this.vm.movImm(VReg.A1, thisKeyIdx);
                this.vm.call("_array_get");
                const kt = this.ctx.allocLocal(`__cfk_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, kt, VReg.RET);
                if (field.value) {
                    this.compileExpression(field.value);
                    this.vm.mov(VReg.V1, VReg.RET);
                } else {
                    // 无初始化器的计算键字段(`[x]`)须建 own 属性 = undefined
                    this.vm.movImm64(VReg.V1, 0x7ffb000000000000n);
                }
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.load(VReg.A1, VReg.FP, kt);
                this.vm.mov(VReg.A2, VReg.V1);
                this.vm.call("_object_define");
                continue;
            }
            if (fieldName == null) continue;
            // `[10]` 的 key.value 是数字;addString 只接受字符串,否则 length 为空→键 "".
            const staticKey = String(fieldName);
            if (field.value) {
                // 编译字段初始值（可能是 new Map() 等复杂表达式，会破坏 A0 和栈平衡，
                // 故绝不能靠 push/pop A0 保 this——从 __this 局部重新加载，与私有字段一致）
                this.compileExpression(field.value);
                this.vm.mov(VReg.V1, VReg.RET);
                // 设置字段: this[fieldName] = value
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.lea(VReg.A1, this.addStringConstant(staticKey));
                // [A3.5-fix] 键装箱(0x7FFC 驻留)——实例字段键同原型方法键一并转正
                this.vm.call("_tag_str_a1");
                this.vm.mov(VReg.A2, VReg.V1);
                this.vm.call("_object_define");
            } else {
                // [L2-③] 无初始化器的字段须在实例上建 own 属性,值=undefined
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.lea(VReg.A1, this.addStringConstant(staticKey));
                this.vm.call("_tag_str_a1");
                this.vm.movImm64(VReg.A2, 0x7ffb000000000000n);
                this.vm.call("_object_define");
            }
        }

        // 初始化私有字段：键名改写为 "#ClassName#x"（与 getMemberPropertyName 的
        // manglePrivateName 一致——# 非法标识符字符保证不撞用户键，ClassName 前缀
        // 保证跨类同名 #x 隔离）。初始值可能是复杂表达式（破坏 A0 与栈平衡），
        // 与公有字段同法：从 __this 局部槽重新加载，不靠 push/pop 保 this。
        for (let i = 0; i < privateFields.length; i++) {
            const field = privateFields[i];
            const privateName = field.key.name; // 含 # 前缀
            if (field.value) {
                this.compileExpression(field.value);
                this.vm.mov(VReg.V1, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.lea(VReg.A1, this.addStringConstant("#" + className + privateName));
                // [A3.5-fix] 键装箱(0x7FFC 驻留)
                this.vm.call("_tag_str_a1");
                this.vm.mov(VReg.A2, VReg.V1);
                this.vm.call("_object_define");
            } else {
                // 无初始化器的私有字段仍须落 own 槽(品牌 / `this.#x` / `#x in o`),值=undefined
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.lea(VReg.A1, this.addStringConstant("#" + className + privateName));
                this.vm.call("_tag_str_a1");
                this.vm.movImm64(VReg.A2, 0x7ffb000000000000n);
                this.vm.call("_object_define");
            }
        }

        // 实例私有方法(含 *#m / async *#m):装到实例 own 属性,不放 prototype。
        // 规范 InitializeInstanceElements 在 super() 返回后才跑——派生类字段初始化器
        // 里调 this.#m 须 TypeError(此前方法在原型上,super 返回前就能调到)。
        // 标签与 compileClassMethod 一致;函数指针 TAG_FUNCTION,与 emitClassMethodTable 同构。
        if (privateMethods && privateMethods.length > 0) {
            for (let i = 0; i < privateMethods.length; i++) {
                const method = privateMethods[i];
                const methodName = method.key && (method.key.name || method.key.value);
                if (!methodName) continue;
                const methodLabel = `_class_${className}_${methodName}_${labelId}`;
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.lea(VReg.A1, this.addStringConstant("#" + className + methodName));
                this.vm.call("_tag_str_a1");
                this.vm.lea(VReg.A2, methodLabel);
                this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
                this.vm.or(VReg.A2, VReg.A2, VReg.V0);
                this.vm.call("_object_define");
            }
        }
    },

    // 构造器序言:从 S1=classinfo 的 shape@48 捕获数组装入本帧 box 槽。
    // 各 Construct 路径须在 callIndirect 前保持 S1=classinfo(type@0==3)。
    emitInstallClassCtorCaptures(captured) {
        if (!captured || captured.length === 0) return;
        const skip = this.ctx.newLabel("ctor_caps_skip");
        this.vm.cmpImm(VReg.S1, 4095);
        this.vm.jle(skip);
        this.vm.loadByte(VReg.V0, VReg.S1, 0);
        this.vm.cmpImm(VReg.V0, 3);
        this.vm.jne(skip);
        this.vm.load(VReg.S2, VReg.S1, 48);
        this.vm.cmpImm(VReg.S2, 0);
        this.vm.jeq(skip);
        for (let i = 0; i < captured.length; i++) {
            const name = captured[i];
            if (name === "__this") continue;
            const off = this.ctx.allocLocal(name);
            this.vm.load(VReg.V1, VReg.S2, i * 8);
            this.vm.store(VReg.FP, off, VReg.V1);
            if (this.ctx.boxedVars) this.ctx.boxedVars.add(name);
        }
        this.vm.label(skip);
    },

    // 类定义处:把外层捕获的 box 指针写入 classinfo@48。S0=classinfo,须在
    // shape_ptr 初值 0 之后、S0 仍指向本类时调用。
    emitStoreClassCtorCaptures(captured) {
        if (!captured || captured.length === 0) return;
        const vm = this.vm;
        vm.push(VReg.S0);
        vm.push(VReg.S1);
        vm.push(VReg.S2);
        vm.movImm(VReg.A0, captured.length * 8);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        for (let i = 0; i < captured.length; i++) {
            const name = captured[i];
            const offset = this.ctx.getLocal(name);
            if (!offset) {
                vm.movImm(VReg.V1, 0);
                vm.store(VReg.S3, i * 8, VReg.V1);
                continue;
            }
            const isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(name) && name !== "__this";
            if (isBoxed) {
                vm.load(VReg.V1, VReg.FP, offset);
                vm.store(VReg.S3, i * 8, VReg.V1);
            } else {
                vm.load(VReg.V1, VReg.FP, offset);
                vm.push(VReg.V1);
                vm.push(VReg.S3);
                vm.call("_box_alloc");
                vm.pop(VReg.S3);
                vm.pop(VReg.V1);
                vm.store(VReg.RET, 0, VReg.V1);
                vm.store(VReg.S3, i * 8, VReg.RET);
                vm.store(VReg.FP, offset, VReg.RET);
                if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
                this.ctx.boxedVars.add(name);
            }
        }
        vm.pop(VReg.S2);
        vm.pop(VReg.S1);
        vm.pop(VReg.S0);
        vm.store(VReg.S0, 48, VReg.S3);
    },

    // 匿名类表达式 parser 赋合成名 __classexprN;可见 .name 取 NamedEvaluation
    // 盖章(_fnHint / _fnNameHints),否则 ""。内部绑定名仍用合成名。
    _classNameForMeta(stmt, className) {
        if (typeof className !== "string" || className.indexOf("__classexpr") !== 0) {
            return className;
        }
        // ES:已有显式 static name 则 HasOwnProperty("name") 为真,不 SetFunctionName。
        if (stmt && stmt.body && Array.isArray(stmt.body)) {
            for (const m of stmt.body) {
                if (m && m.static && m.key && (m.key.name === "name" || m.key.value === "name")) {
                    return "";
                }
            }
        }
        if (stmt && typeof stmt._fnHint === "string") return stmt._fnHint;
        if (this._fnNameHints) {
            const h = this._fnNameHints.get(stmt);
            if (typeof h === "string") return h;
        }
        return "";
    },

    // 编译类声明
    // JavaScript 类在运行时主要是：
    // 1. 一个构造函数
    // 2. prototype 对象上的方法
    // 3. 静态方法和字段
    compileClassDeclaration(stmt) {
        const className = stmt.id.name;
        const superClass = stmt.superClass;
        // [Cluster 11] extends builtin: builtin constructors don't have classinfo
        // objects.  emitLoadClassInfo returns 0 for known builtins; callers guard
        // against dereferencing null classinfo (skipProtoLink for prototype chain,
        // super_skip for super() calls).  This converts former CRASH/SIGSEGV paths
        // into graceful no-ops — zero false rejection, even if behaviour isn't
        // 100% spec-compliant.
        const labelId = this.nextLabelId();
        // [classinfo 唯一化] 顶层类:getFunctionSymbol 返回稳定唯一符号(模块内类名唯一),
        // 沿用 `_classinfo_<sym>`。嵌套/局部类(函数或块内 `class X{}`)不入 functions 表 →
        // getFunctionSymbol 返回 undefined,旧实现回退裸名 `_classinfo_X` → 不同作用域同名类
        // **共享同一全局槽**,super/静态解析跨污染(runtime 后声明者覆写)。此处按 labelId
        // 赋每个嵌套声明**唯一**槽,并记入 _nestedClassInfoLabels 供本作用域内引用(super/
        // 方法体,均内联在本 compileClassDeclaration 期间编译)解析到正确声明。
        const classInfoLabel = this._classInfoLabelForDecl(className, labelId);

        // 表达式父类 `extends (expr)`(非裸标识符,或裸标识符但非函数表成员——如
        // `var A = class {}; class C extends A`):父类无编译期名字/槽。其 classinfo 指针在
        // 类声明处求值一次并存入本声明专属全局 superInfoLabel;super()/super.m()/super.prop
        // 运行时从该全局解析父类(emitLoadSuperClassInfo)。函数表成员标识符父类
        // superIsExpr=false → 全程走名字快路径,与旧实现逐字节一致(编译器自举的
        // extends Backend 等皆函数表成员,产物不变)。
        const superIsFn = !!(superClass && superClass.type === "Identifier" &&
            this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(superClass.name));
        // 仅当裸标识符是**局部/模块 var**(如 `var A = class {}; class C extends A`)
        // 才改走表达式父类路径。内建名(extends Error 的 Error——ERR_CTOR 闭包非
        // classinfo)与导入名保持旧标识符路径(emitLoadClassInfo 的既有语义),
        // 编译器自举产物逐字节不变。
        const superIsVar = !!(superClass && superClass.type === "Identifier" && !superIsFn &&
            (superClass.name === className || // [I8] 自引用 extends x:TDZ 读,走表达式路径
                (this.ctx.getLocal && this.ctx.getLocal(superClass.name))));
        const superIsExpr = !!(superClass && superClass.type !== "Identifier") || superIsVar;
        const superInfoLabel = superIsExpr ? `_superinfo_${className}__${labelId}` : null;
        if (superInfoLabel) {
            if (!this._addedSuperInfoLabels) this._addedSuperInfoLabels = new Set();
            if (!this._addedSuperInfoLabels.has(superInfoLabel)) {
                this.asm.addDataLabel(superInfoLabel);
                this.asm.addDataQword(0);
                this._addedSuperInfoLabels.add(superInfoLabel);
            }
        }

        // 为类分配局部变量槽位（存储类信息对象地址）
        const classOffset = this.ctx.allocLocal(className);
        // 记本作用域**本地声明**的类名:其槽直存裸 classinfo(见下 classOffset 存储),
        // 区别于顶层类被闭包捕获时槽存 box 指针。compileUserClassNew 据此决定 new 时
        // 是否多解一层 box(见其注释:同名既本地声明又被 boxedVars 标记时 boxedVars 不可靠)。
        if (!this.ctx.localDeclaredClasses) this.ctx.localDeclaredClasses = {};
        this.ctx.localDeclaredClasses[className] = true;

        // [I8 类名 TDZ] extends 表达式里读本类名 → 绑定尚在 TDZ → ReferenceError
        // (class x extends x {} 族)。extends 求值前把类名槽置 TDZ 哨兵、读点标 _tdz
        // (compileIdentifier 读后发守卫退出);无自引用时零发射(编译器自举类全无此形)。
        if (superClass) {
            const selfRefs = [];
            const visitTdz = (node) => {
                if (!node || typeof node !== "object") return;
                if (Array.isArray(node)) { for (let _ci = 0; _ci < node.length; _ci++) visitTdz(node[_ci]); return; }
                if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" ||
                    node.type === "ClassExpression" || node.type === "ClassDeclaration") return;
                if (node.type === "Identifier" && node.name === className) selfRefs.push(node);
                for (const _ck in node) {
                    if (_ck === "type" || _ck === "loc" || _ck === "range" || _ck === "start" || _ck === "end") continue;
                    visitTdz(node[_ck]);
                }
            };
            visitTdz(superClass);
            if (selfRefs.length > 0) {
                this.vm.movImm64(VReg.V1, TDZ_SENTINEL);
                this.vm.store(VReg.FP, classOffset, VReg.V1);
                for (let _ri = 0; _ri < selfRefs.length; _ri++) selfRefs[_ri]._tdz = true;
            }
        }

        // 收集类成员
        let constructor = null;
        const instanceMethods = [];
        const staticMethods = [];
        const instanceFields = [];
        const staticFields = [];
        const privateFields = [];
        const privateMethods = [];
        const staticBlocks = [];

        for (const member of stmt.body) {
            if (member.type === "StaticBlock") {
                staticBlocks.push(member);
            } else if (member.type === "MethodDefinition") {
                if (member.kind === "constructor") {
                    constructor = member;
                } else if (!member.static && !member.computed &&
                    this._isPrivateClassKey(member.key) &&
                    member.kind !== "get" && member.kind !== "set") {
                    // 实例私有方法(含生成器/async 生成器):不进 prototype 表,
                    // 由 emitCtorFieldInits 装到实例 own 槽(品牌 / super 返回后可见)。
                    privateMethods.push(member);
                } else if (member.static) {
                    staticMethods.push(member);
                } else {
                    instanceMethods.push(member);
                }
            } else if (member.type === "PropertyDefinition") {
                const isPrivate = member.key.type === "PrivateIdentifier";
                if (member.static) {
                    // static #x 与公有静态字段同路径发射（键名在发射处按私有改写）
                    staticFields.push(member);
                } else if (isPrivate) {
                    privateFields.push(member);
                } else {
                    instanceFields.push(member);
                }
            }
        }

        // [私有名词法作用域] 私有名按**声明它的类**改写("#类名#x")。嵌套类体里引用外层类的
        // `#x`(inner class 访问 Outer 的私有字段)此前用内层类名改写 → 键不匹配 → 读 undefined /
        // 写成新属性。这里入一层私有作用域(本类声明的私有名集合),manglePrivateName 从内向外
        // 找**声明者**;延迟编译的箭头/函数体在 pendingFunctions 里带走整条链的快照。
        {
            const privNames = new Set();
            for (const member of stmt.body) {
                if (!member || !member.key) continue;
                if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") continue;
                if (!this._isPrivateClassKey(member.key)) continue;
                const pn = member.key.name || member.key.value;
                if (typeof pn === "string") privNames.add(pn);
            }
            if (!this._privateScopes) this._privateScopes = [];
            this._privateScopes.push({ className: className, names: privNames });
        }

        // [任意计算键成员] `[a+b](){}` / `get [x||1](){}`:键是运行期值,方法体 label 无静态
        // 名可用,此前 _classMethodKeyName 返 null → 方法体与表项**一并跳过**(读回 undefined /
        // "not a function")。这里按声明序发一个全局唯一的合成名(编译单元级 labelId,不会与
        // 真实方法名相撞),方法体与表项共用同一节点上的该名字,键仍在运行期求值。
        for (const member of stmt.body) {
            if (member.type !== "MethodDefinition") continue;
            if (!member.computed || member.kind === "constructor") continue;
            if (this._classMethodKeyName(member) !== null) continue;
            if (this._wellKnownSymbolMethodName(member)) continue;
            if (!member.__ckName) member.__ckName = "ck$" + this.nextLabelId();
        }

        // 实例计算键在类定义时求值,结果存 `_cfkeys_<类>__<id>`(数据段 GC 根)。
        // 构造器只按下标取键,不再 compileExpression(field.key)。
        let cfKeyCount = 0;
        for (let i = 0; i < instanceFields.length; i++) {
            if (this._isRuntimeComputedFieldKey(instanceFields[i])) cfKeyCount++;
        }
        const cfkeysLabel = cfKeyCount > 0 ? `_cfkeys_${className}__${labelId}` : null;
        if (cfkeysLabel) {
            if (!this._addedCfkeysLabels) this._addedCfkeysLabels = new Set();
            if (!this._addedCfkeysLabels.has(cfkeysLabel)) {
                this.asm.addDataLabel(cfkeysLabel);
                this.asm.addDataQword(0);
                this._addedCfkeysLabels.add(cfkeysLabel);
            }
        }

        // [支柱②] 发射期回填:把本类 labelId 与方法标签并入预登记表(_devirtPrepass 已建
        // 条目;嵌套/局部类预登记未覆盖,此处新建)。跨模块同名投毒类拒去虚拟化。
        if (!this._devirtClasses) this._devirtClasses = {};
        {
            let dv = this._devirtClasses[className];
            if (!dv) {
                dv = { labelId: null, superName: null, methods: {}, fieldTypes: {}, subClasses: [] };
                this._devirtClasses[className] = dv;
            }
            if (!(this._devirtPoisoned && this._devirtPoisoned[className])) {
                dv.labelId = labelId;
                if (!dv.superName && superClass && superClass.type === "Identifier") {
                    dv.superName = superClass.name;
                }
                for (const m of instanceMethods) {
                    if (m.computed || !m.key || m.key.type === "PrivateIdentifier") continue;
                    if (m.kind && m.kind !== "method") continue;
                    const mn = m.key.name || m.key.value;
                    if (!mn || mn === "constructor") continue;
                    dv.methods[mn] = `_class_${className}_${mn}_${labelId}`;
                }
                if (dv.superName && this._devirtClasses[dv.superName]) {
                    const sc = this._devirtClasses[dv.superName].subClasses;
                    if (!sc.includes(className)) sc.push(className);
                }
            }
        }

        // extends 且未写构造器：合成转发默认构造器 constructor(f0..f4){ super(f0..f4) }
        // —— 对齐 node 隐式 super(...args)（寄存器调用约定上限 5 个实参；参数先落栈
        // 再由 super 路径重装 A1-A5，位级等价于调用方直接调父构造器）。
        // 此前缺失：子类无构造器时父类字段（含私有字段）初始化全不执行。
        // [W-27] 下面可能**合成**一个带 5 个转发形参的默认派生构造器;元数据 arity 必须按
        // 用户**声明**的构造器算(默认构造器规范 length = 0),故先记住是否真有声明。
        const hasDeclaredCtor = !!constructor;
        if (!constructor && superClass) {
            const fwdParams = [];
            for (let fi = 0; fi < 5; fi++) {
                fwdParams.push({ type: "Identifier", name: "__superfwd" + fi });
            }
            constructor = {
                type: "MethodDefinition",
                kind: "constructor",
                static: false,
                computed: false,
                key: { type: "Identifier", name: "constructor" },
                value: {
                    type: "FunctionExpression",
                    params: fwdParams,
                    body: {
                        type: "BlockStatement",
                        body: [{
                            type: "ExpressionStatement",
                            expression: {
                                type: "CallExpression",
                                callee: { type: "SuperExpression" },
                                arguments: fwdParams,
                                optional: false,
                            },
                        }],
                    },
                },
            };
        }

        // 生成标签
        const constructorLabel = `_class_${className}_${labelId}`;
        // 结构标签把 labelId 放在结构标记之前,使末段为非数字("end"/"return"/"proto"),
        // 与方法体 label `_class_<C>_<prefix><name>_<labelId>`(末段恒为数字 labelId)不可能
        // 相等——否则类里名为 `end`/`return` 的方法会与本结构标签重名,调用时跳进构造器尾/
        // 类信息创建代码(bug3:`w.end()` 回跑 main)。
        const constructorEndLabel = `_class_${className}_${labelId}_end`;
        const protoLabel = `_class_${className}_${labelId}_proto`;

        // 构造器/方法/字段对外层词法的捕获(含 for-of let 改名后的绑定)。
        // 类定义时把 box 指针写入 classinfo.shape@48;构造器序言从 S1=classinfo 装入。
        const classCtorCaptured = [];
        {
            const cap = analyzeCapturedVariables(stmt, this.ctx.locals, this.ctx.functions);
            for (let i = 0; i < cap.length; i++) {
                if (cap[i] !== "__this") classCtorCaptured.push(cap[i]);
            }
        }

        // 跳过类代码区域
        this.vm.jmp(constructorEndLabel);

        // ========== 生成构造函数 ==========
        this.vm.label(constructorLabel);
        // [W-27] 构造器入函数元数据侧表(code_ptr=构造器标签):类值经变量/形参传递后
        // `K.name`/`K.length`/gOPD(K,"length") 只能靠运行期反射(编译期静态解析点见
        // members.js _fnNameLength)。名 = 类名(匿名类表达式为 "");arity = 声明的构造器形参(无声明 → 0)。
        const ctorMetaName = this._classNameForMeta(stmt, className);
        this.registerFuncMeta(constructorLabel,
            hasDeclaredCtor ? constructor.value : { type: "FunctionExpression", params: [] },
            ctorMetaName);
        // [P1] 与闭包路径同用 _fnNeedsP1Record;无声明构造器体为空,不录。
        if (hasDeclaredCtor && constructor.value && this._fnNeedsP1Record(constructor.value)) {
            this.vm.beginRecord();
        }
        this.vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        const savedCtx = this.ctx;
        // [label collision] 用 className 作 ctx 名 → labelPrefix=`${className}_`;两个
        // 不同模块的同名类(如 net 与 http 各有 `class Server`)会生成相同的构造器体
        // 局部标签(`Server_endif_2` 等),asm.label() 静默覆盖 → 跨类跳转/崩溃。类声明
        // 唯一的 labelId 掺入 ctx 名使 labelPrefix 唯一(仅改标签名、不改机器码,无冲突时
        // 逐字节等价;函数体走 compileFunction 已用模块符号名故本就唯一)。
        this.ctx = this.ctx.clone(className + "." + labelId);
        this.ctx.locals = new Map();
        this.ctx.localTemps = null;
        this.ctx.localOffset = 0;
        this.ctx.inClass = true;
        this.ctx.className = className;
        this.ctx.classInfoLabel = classInfoLabel; // super()→TA 绑 NewTarget.prototype 用
        // 构造器对外层 let/const 的捕获:合并方法自身共享局部 + 外层已分析的
        // classCtorCaptured(for-of let 每轮独立 box)。S1=classinfo 由各 Construct
        // 路径在 callIndirect 前写入。
        const ctorBoxedVars = (constructor && constructor.value)
            ? analyzeSharedVariables(constructor.value) : new Set();
        if (constructor && constructor.value) {
            for (const _n of analyzeDirectEvalBoxedVars(constructor.value)) ctorBoxedVars.add(_n);
        }
        for (let _ci = 0; _ci < classCtorCaptured.length; _ci++) {
            ctorBoxedVars.add(classCtorCaptured[_ci]);
        }
        this.ctx.boxedVars = ctorBoxedVars;
        // 标识符父类:superClass=父名(名字快路径)。表达式父类:无名字,置本类名(仅使
        // super.prop 的真值守卫通过);实际父类经 superClassExpr/superInfoLabel 从全局解析。
        this.ctx.superClass = superClass ? (superIsExpr ? className : superClass.name) : null;
        this.ctx.superClassExpr = superIsExpr;
        this.ctx.superInfoLabel = superInfoLabel;
        this.ctx.returnLabel = `_class_${className}_${labelId}_return`;
        // 隐式派生 ctor 合成 super(f0..f4):String 等须用真实 new 的 argc,
        // 不能把缺省 undefined 形参当成 super(undefined)。
        this.ctx.syntheticDerivedCtor = !hasDeclaredCtor && !!superClass;

        // [argv] 进入构造器立刻快照溢出实参。emitCtorArgumentsArray 已写但从未
        // 接到序言 → `constructor(){ arguments.length }` 看到空/0
        // (super(...src) 族 actual 0 expected 3/5)。A0=this 须先落槽再建模 arguments。
        const ctorFn = constructor && constructor.value;
        const ctorParams0 = (ctorFn && ctorFn.params) || [];
        const ctorShadowArgs = ctorParams0.some((p) =>
            (p.type === "Identifier" && p.name === "arguments") ||
            (p.type === "AssignmentPattern" && p.left && p.left.name === "arguments") ||
            ((p.type === "SpreadElement" || p.type === "RestElement") &&
                p.argument && p.argument.name === "arguments"));
        const ctorUsesArgs = !!(ctorFn && !ctorShadowArgs && this.functionBodyUsesArguments(ctorFn));
        let ctorNeedFullArgv = ctorUsesArgs;
        if (!ctorNeedFullArgv) {
            for (let ri = 0; ri < ctorParams0.length; ri++) {
                const p = ctorParams0[ri];
                if (p && (p.type === "SpreadElement" || p.type === "RestElement")) {
                    ctorNeedFullArgv = true;
                    break;
                }
            }
        }
        this.emitArgvSpillSnapshot(ctorNeedFullArgv ? 16 : ctorParams0.length);
        // 派生 ctor:进入体立刻快照 _call_argc。其后任何 JS 调用都会写脏全局;
        // String super() 用此槽区分 new S() 与 new S(undefined)。
        if (superClass) {
            const ctorArgcOff = this.ctx.allocLocal("__ctor_argc");
            this.vm.lea(VReg.V5, "_call_argc");
            this.vm.load(VReg.V6, VReg.V5, 0);
            this.vm.store(VReg.FP, ctorArgcOff, VReg.V6);
            this.ctx.ctorArgcOff = ctorArgcOff;
        }

        // 保存 this (A0) 到 __this
        const thisOffset = this.ctx.allocLocal("__this");
        this.vm.store(VReg.FP, thisOffset, VReg.A0);
        if (ctorUsesArgs) this.emitCtorArgumentsArray();
        this.emitInstallClassCtorCaptures(classCtorCaptured);
        // 派生类:跟踪是否已执行 super()。空构造器/未调 super 返回时须抛 ReferenceError
        // (super-must-be-called / NativeError-*-super 族)。
        let superCalledOff = null;
        if (superClass) {
            superCalledOff = this.ctx.allocLocal("__super_called");
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, superCalledOff, VReg.V0);
            this.ctx.superCalledOff = superCalledOff;
        } else {
            this.ctx.superCalledOff = null;
        }

        // 构造函数参数必须在字段初始化【之前】落栈：字段初始化调 _object_define
        // 会冲掉 A1-A3 里尚未保存的实参——修前 `class K { x = 0; constructor(s){ this.s = s; } }`
        // 里 s 读回的是字段初始化最后一次 lea A1 的键字符串常量（读写全线中毒）。
        // 第一阶段全部落栈，第二阶段统一处理默认值（默认值表达式可含调用，
        // 两阶段亦消除「编译前一个默认值冲掉后续未落栈实参」的别名冲击；
        // 顺序与 node 一致：默认值 → 字段初始化 → 构造器体）。
        if (constructor && constructor.value) {
            const ctorParams = constructor.value.params || [];
            const ctorPatternParams = [];
            for (let i = 0; i < ctorParams.length; i++) {
                const param = ctorParams[i];
                // constructor(...rest):parser 发 SpreadElement;此前只认 Identifier →
                // rest 名未落槽 → ReferenceError: params is not defined(species/RAB 子类 ctor)。
                if ((param.type === "SpreadElement" || param.type === "RestElement") &&
                    param.argument && param.argument.type === "Identifier") {
                    this.emitCtorRestParam(param.argument.name, i);
                    continue;
                }
                if (this._isPatternParam(param)) {
                    // [#47] 解构参数 constructor({a,b}){}：实参落临时槽,解构延后。
                    const pat = param.type === "AssignmentPattern" ? param.left : param;
                    const dexpr = param.type === "AssignmentPattern" ? param.right : null;
                    const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                    this.emitArgToSlot(i, pslot, 1);
                    ctorPatternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                    continue;
                }
                const paramName = param.name || (param.left && param.left.name);
                if (paramName) {
                    const paramOffset = this.ctx.allocLocal(paramName);
                    // 构造函数约定: A0 = this, 实参 A1-A5,第 6 个起 _call_argv 快照
                    this.emitArgToSlot(i, paramOffset, 1);
                }
            }
            // [#47] 解构参数:实参已落栈,此处解构到局部(默认值处理内含于 emitParamDestructure)。
            for (let i = 0; i < ctorPatternParams.length; i++) {
                this.emitParamDestructure(ctorPatternParams[i].pat, ctorPatternParams[i].slot, ctorPatternParams[i].dflt);
            }
            for (let i = 0; i < ctorParams.length; i++) {
                const param = ctorParams[i];
                const paramName = param.name || (param.left && param.left.name);
                const defaultExpr = (param.type === "AssignmentPattern") ? param.right : null;
                if (paramName && defaultExpr) {
                    const paramOffset = this.ctx.getLocal(paramName);
                    // 默认参数：实参为 undefined 时取默认值
                    // x64: V1/V2 别名 RCX/RDX = A3/A2；实参虽已落栈，保持 V5/V6
                    // 选择避免平台路径分叉。arm64 保持 V1/V2。
                    const chkReg = this.vm.backend.name === "x64" ? VReg.V5 : VReg.V1;
                    const undReg = this.vm.backend.name === "x64" ? VReg.V6 : VReg.V2;
                    const skip = this.ctx.newLabel("ctor_defparam_skip");
                    this.vm.load(chkReg, VReg.FP, paramOffset);
                    this.vm.movImm64(undReg, 0x7ffb000000000000n); // JS_UNDEFINED
                    this.vm.cmp(chkReg, undReg);
                    this.vm.jne(skip);
                    const _prevEvalParam = this.ctx._evalInParamInit;
                    this.ctx._evalInParamInit = true;
                    this.compileExpression(defaultExpr);
                    this.ctx._evalInParamInit = _prevEvalParam;
                    this.vm.store(VReg.FP, paramOffset, VReg.RET);
                    this.vm.label(skip);
                }
            }
        }

        // 箭头 lexical Super:形参已落槽后再装箱 __super_called(_box_alloc 毁 A*)。
        // `(_ => super())()` 写同一 box,构造器 return 检查才能看见。
        if (superClass && superCalledOff != null && ctorFn && this.functionBodyUsesLexicalSuper(ctorFn)) {
            this.vm.load(VReg.V1, VReg.FP, superCalledOff);
            this.vm.push(VReg.V1);
            this.vm.call("_box_alloc");
            this.vm.pop(VReg.V1);
            this.vm.store(VReg.RET, 0, VReg.V1);
            this.vm.store(VReg.FP, superCalledOff, VReg.RET);
            if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
            this.ctx.boxedVars.add("__super_called");
        }

        // 字段初始化时机(ES 语义):基类(无 super)在构造体执行前初始化;派生类(有 super)
        // 须在 super() 返回后初始化——子类字段初始化器可读父构造器所设 this 状态
        // (`class C extends A{ b = this.a+9 }`,this.a 由 super() 设)。故派生类此处不发,
        // 由下方构造体循环在 super() 语句后注入(emitCtorFieldInits)。
        if (!superClass) {
            this.emitCtorFieldInits(instanceFields, privateFields, className, thisOffset, cfkeysLabel, privateMethods, labelId);
        }

        // 编译构造函数体（参数已在字段初始化前落栈并处理默认值）
        if (constructor && constructor.value) {
            if (constructor.value.body && constructor.value.body.body) {
                let fieldsEmittedAfterSuper = false;
                for (const bodyStmt of constructor.value.body.body) {
                    this.compileStatement(bodyStmt);
                    // 派生类:super() 语句刚编完 → 立即注入字段初始化(node 时序)。
                    if (superClass && !fieldsEmittedAfterSuper && this._isSuperCallStmt(bodyStmt)) {
                        this.emitCtorFieldInits(instanceFields, privateFields, className, thisOffset, cfkeysLabel, privateMethods, labelId);
                        fieldsEmittedAfterSuper = true;
                    }
                }
                // 派生类构造体未见顶层 super() 时**不再**于体末补发字段初始化:
                // 未调 super 的实例 this 未初始化,补发会掩盖 ReferenceError
                // (super-must-be-called);且规范要求字段在 super() 之后。
                // 非常规写法(super 藏在 if 内)靠运行期 __super_called + return 检查兜底。
            }
        }

        // 体末隐式 completion = undefined(显式 return 已把值放进 RET 后跳到 returnLabel)
        this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        // [[Construct]] 返回值解析(9.2.2):
        //   对象 → 用之(派生类即使未 super 亦可 `return {}`);
        //   派生 + 非 undefined 非对象 → TypeError;
        //   派生 + undefined + 未 super → ReferenceError;
        //   否则 → __this。
        this.vm.label(this.ctx.returnLabel);
        {
            const keepRet = this.ctx.newLabel("ctor_keep_ret");
            const useThis = this.ctx.newLabel("ctor_use_this");
            // 对象? 0x7FFD / 0x7FFE / 裸堆(Map/Set/TA/AB)
            this.vm.shrImm(VReg.V1, VReg.RET, 48);
            this.vm.cmpImm(VReg.V1, 0x7ffd);
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 0x7ffe);
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 0x7fff);
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(useThis); // 非裸指针 → 非对象(数字/undefined/…)
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(useThis);
            this.vm.loadByte(VReg.V1, VReg.RET, 0);
            this.vm.cmpImm(VReg.V1, 4); // TYPE_MAP
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 5); // TYPE_SET
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 14); // TYPE_DATA_VIEW
            this.vm.jeq(keepRet);
            this.vm.cmpImm(VReg.V1, 0x40);
            this.vm.jlt(useThis);
            this.vm.cmpImm(VReg.V1, 0x61);
            this.vm.jgt(useThis);
            this.vm.jmp(keepRet);
            // fall through useThis
            this.vm.label(useThis);
            if (superClass && superCalledOff != null) {
                // 派生:非对象返回值且非 undefined → TypeError(return 0 族;
                // 异常在 Construct 层抛,构造体内 catch 捕不到)
                const isUndef = this.ctx.newLabel("ctor_ret_undef");
                this.vm.shrImm(VReg.V1, VReg.RET, 48);
                this.vm.cmpImm(VReg.V1, 0x7ffb);
                this.vm.jeq(isUndef);
                this.vm.lea(VReg.A0, this.asm.addString(
                    "Derived constructors may only return object or undefined"));
                this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                this.vm.and(VReg.A0, VReg.A0, VReg.V1);
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A0, VReg.A0, VReg.V1);
                this.vm.call("_throw_type_error");
                this.vm.label(isUndef);
                // undefined + 未调 super → ReferenceError
                const superOk = this.ctx.newLabel("ctor_super_ok");
                this.emitLoadSuperCalled(VReg.V0);
                this.vm.cmpImm(VReg.V0, 0);
                this.vm.jne(superOk);
                this.vm.lea(VReg.A0, this.asm.addString(
                    "Must call super constructor in derived class before returning from derived constructor"));
                this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                this.vm.and(VReg.A0, VReg.A0, VReg.V1);
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A0, VReg.A0, VReg.V1);
                this.vm.call("_throw_reference_error");
                this.vm.label(superOk);
            }
            this.vm.load(VReg.RET, VReg.FP, thisOffset);
            this.vm.label(keepRet);
        }
        this.vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
        this.vm.endRecord(); // [P1]

        // ========== 生成实例方法 ==========
        for (const method of instanceMethods) {
            this.compileClassMethod(className, method, labelId, false);
        }
        for (const method of privateMethods) {
            this.compileClassMethod(className, method, labelId, false);
        }

        // ========== 生成静态方法 ==========
        for (const method of staticMethods) {
            this.compileClassMethod(className, method, labelId, true);
        }

        // 恢复上下文
        this.ctx = savedCtx;
        // superCalledOff 仅构造器 ctx 有效;恢复后清掉以免方法体误用
        // (savedCtx 可能是外层派生构造器,保留其值)

        // ========== 类代码结束点 ==========
        this.vm.label(constructorEndLabel);

        // ========== 创建类信息对象 ==========
        // 类信息对象采用新对象布局（属性区独立分配、可增长、对象头指针稳定）:
        //   type@0=FUNCTION(3), count@8, __proto__@16, capacity@24, props_ptr@32,
        //   flags_ptr@40, shape_ptr@48（头共 56B,与 OBJECT_HEADER_SIZE 一致）
        // 属性数组前两个槽固定为 __ctor__(idx0)、prototype(idx1)，new 表达式经
        // props_ptr 读取: props=[classinfo+32]; ctor=[props+8]; prototype对象=[props+24]。
        // 二者仍是真正的属性（count 从 2 起），故 X.prototype / _object_get 正常；
        // 静态成员随后经 _object_set 追加，超容量自动增长且保序拷贝 __ctor__/prototype。
        const classStaticCap = 2 + staticMethods.length + staticFields.length + 8;
        // [A1] 对象头 56:type/count/proto/capacity/props_ptr/flags_ptr@40/shape_ptr@48
        this.vm.movImm(VReg.A0, 56);
        this.vm.call("_alloc");
        this.vm.mov(VReg.S0, VReg.RET); // S0 = 类信息对象
        this.vm.movImm(VReg.A0, classStaticCap * 16); // 属性数组
        this.vm.call("_alloc");
        this.vm.mov(VReg.S2, VReg.RET); // S2 = 属性数组指针

        // 设置类型为 FUNCTION (用于 typeof)
        this.vm.movImm(VReg.V0, 3); // TYPE_CLOSURE/FUNCTION = 3
        this.vm.store(VReg.S0, 0, VReg.V0);
        // 属性数量 = 2 (__ctor__, prototype)
        this.vm.movImm(VReg.V0, 2);
        this.vm.store(VReg.S0, 8, VReg.V0);
        // __proto__:无 extends → Function.prototype(ES 普通函数/类构造器默认 [[Prototype]]);
        // 有 extends 时下方 heritage 再覆写为父构造器。alloc 不清零,须显式写。
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.S0, 16, VReg.V0);
        if (!superClass) {
            this.vm.push(VReg.S0);
            this.vm.push(VReg.S1);
            this.vm.push(VReg.S2);
            this.emitFunctionProtoObject(); // RET = boxed Function.prototype
            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            this.vm.and(VReg.V0, VReg.RET, VReg.V1);
            this.vm.pop(VReg.S2);
            this.vm.pop(VReg.S1);
            this.vm.pop(VReg.S0);
            this.vm.store(VReg.S0, 16, VReg.V0);
        }
        // capacity
        this.vm.movImm(VReg.V0, classStaticCap);
        this.vm.store(VReg.S0, 24, VReg.V0);
        // props_ptr
        this.vm.store(VReg.S0, 32, VReg.S2);
        // [#61 P2] flags_ptr@40 = 0(惰性,全默认 attrs)。alloc 不清零,必须显式写。
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.S0, 40, VReg.V0);
        // [A1] shape_ptr@48 = 0(无形状;形状 IC 未启用,占位字段,逐字节等价旧语义)。
        this.vm.store(VReg.S0, 48, VReg.V0);

        // 属性槽 0: __ctor__ -> 构造函数地址
        this.vm.lea(VReg.V0, this.addStringConstant("__ctor__"));
        this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        this.vm.or(VReg.V0, VReg.V0, VReg.V1);
        this.vm.store(VReg.S2, 0, VReg.V0);
        this.vm.lea(VReg.V0, constructorLabel);
        this.vm.store(VReg.S2, 8, VReg.V0);

        // 创建 prototype 对象（新布局，方法经 _object_set 追加、可自动增长）。
        // 类常用 Object.assign(X.prototype, Mixin) 混入大量方法；增长语义已就位，
        // 初始给适度容量即可，超出时自动搬迁到更大的属性数组。
        const protoCap = instanceMethods.length + 16;
        this.vm.movImm(VReg.A0, 24 + 16 * protoCap); // _object_new_sized 以旧头字节数换算容量
        this.vm.call("_object_new_sized");
        this.vm.mov(VReg.S1, VReg.RET); // S1 = prototype 对象

        // 属性槽 1: prototype -> prototype 对象
        this.vm.lea(VReg.V0, this.addStringConstant("prototype"));
        this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        this.vm.or(VReg.V0, VReg.V0, VReg.V1);
        this.vm.store(VReg.S2, 16, VReg.V0);
        this.vm.store(VReg.S2, 24, VReg.S1);
        // classinfo.prototype 描述符 = {writable:false, enumerable:false, configurable:false}
        // (ES:非可配置 → `static set ['prototype']` 的 DefinePropertyOrThrow 抛 TypeError)
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.lea(VReg.A1, this.addStringConstant("prototype"));
        this.vm.call("_tag_str_a1");
        this.vm.movImm(VReg.A2, 0); // 全关
        this.vm.call("_object_set_prop_attr");

        // extends：链接原型链——本 prototype 的 __proto__(@16) 指向父类 prototype 对象。
        // 此前恒置 null，子类实例调用继承自父类的方法时 _object_get 走到 __proto__=null
        // 找不到方法 → 崩溃（如 ARM64Backend extends Backend 调 backend.label()）。
        // 父可为 (a) classinfo(type@0==3) 或 (b) 内建构造器闭包(magic@0==0xc105,如
        // `extends Constructor` 且 Constructor=Int8Array)。(b) 不可按 props_ptr@32 解引用
        // (会把闭包字段当 props → 读到 0 → SIGSEGV@+0x18);改走 _get_ctor_proto。
        if (superClass) {
            if (superIsExpr) {
                // 表达式父类:求值一次 → 去 tag 得 raw 父指针 → 存 superInfoLabel 全局
                // 供 super() 运行时读。S0(classinfo)/S2(props)/S1(proto)在求值中可能被
                // compileExpression 破坏,三者全保护(区别于标识符路径 lea+load 无破坏,仅护 S1)。
                // `extends null`:规范允许 heritage=null(proto 链断),但 super() 时
                // GetSuperConstructor → %FunctionPrototype% 非构造器 → TypeError。
                // 存哨兵 1(非合法堆指针)与「无 classinfo 的 0」区分。
                this.vm.push(VReg.S0);
                this.vm.push(VReg.S1);
                this.vm.push(VReg.S2);
                this.compileExpression(superClass); // RET = 装箱父类信息/构造器
                {
                    const notNullL = this.ctx.newLabel("super_herit_notnull");
                    const storedL = this.ctx.newLabel("super_herit_stored");
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0x7ffa); // null
                    this.vm.jne(notNullL);
                    this.vm.movImm(VReg.V2, 1); // NULL_SUPER sentinel
                    this.vm.jmp(storedL);
                    this.vm.label(notNullL);
                    this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                    this.vm.and(VReg.V2, VReg.RET, VReg.V1); // V2 = raw 父
                    this.vm.label(storedL);
                }
                this.vm.lea(VReg.V1, superInfoLabel);
                this.vm.store(VReg.V1, 0, VReg.V2); // 全局槽 = 父(classinfo/闭包/哨兵)
                this.vm.pop(VReg.S2);
                this.vm.pop(VReg.S1);
                this.vm.pop(VReg.S0);
            } else {
                // emitLoadClassInfo 对部分内建会 compileExpression(物化闭包)→ 冲 S0/S2;
                // 此处 S0=classinfo、S2=props,须全护。
                this.vm.push(VReg.S0);
                this.vm.push(VReg.S1);
                this.vm.push(VReg.S2);
                this.emitLoadClassInfo(superClass.name, VReg.V2); // V2 = 父类信息对象(raw)
                this.vm.pop(VReg.S2);
                this.vm.pop(VReg.S1);
                this.vm.pop(VReg.S0);
                // 内建:emitLoadClassInfo 返 0;物化构造器闭包以便链上 __proto__/prototype。
                // TA 走 emitCtorClosureRef(稳定 type@16);其余(Boolean/Promise/…)经
                // 标识符求值触发 emitXxxCtorObject(与全局 Boolean===Boolean 同身份)。
                if (superClass.type === "Identifier" && BUILTIN_HERITAGE_NAMES[superClass.name]) {
                    const gotBuiltin = this.ctx.newLabel("super_proto_got_builtin");
                    this.vm.cmpImm(VReg.V2, 0);
                    this.vm.jne(gotBuiltin);
                    this.vm.push(VReg.S0);
                    this.vm.push(VReg.S1);
                    this.vm.push(VReg.S2);
                    if (TA_SUPER_TAGS[superClass.name] != null) {
                        this.emitCtorClosureRef(superClass.name, TA_SUPER_TAGS[superClass.name]);
                    } else {
                        this.compileExpression(superClass);
                    }
                    this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                    this.vm.and(VReg.V2, VReg.RET, VReg.V1);
                    this.vm.pop(VReg.S2);
                    this.vm.pop(VReg.S1);
                    this.vm.pop(VReg.S0);
                    this.vm.label(gotBuiltin);
                }
            }
            // 父类信息可能为 0（前向引用/导入模块尚未初始化）——须先判空再解引用，
            // 否则 load [0+48] 在运行时 SIGSEGV（会拖垮 gen1 自身 init）。
            // 判别用「是否 TA/AB 闭包 magic」优先:classinfo 的 type@0==3,但若误用
            // cmpImm(type,3) 未命中会错走 builtin 并 skip 原型链(用户类 extends 全挂)。
            // 非 0xc105 → 一律按 classinfo 链(与改前行为一致)。
            const skipProtoLink = this.ctx.newLabel("skip_proto_link");
            const classinfoLink = this.ctx.newLabel("super_proto_ci");
            this.vm.cmpImm(VReg.V2, 0);
            this.vm.jeq(skipProtoLink);
            // extends null 哨兵:跳过 IsConstructor 与原型链(规范 e:superclass is null)
            this.vm.cmpImm(VReg.V2, 1);
            this.vm.jeq(skipProtoLink);
            // [IsConstructor] ClassHeritage:superclass !== null 且 !IsConstructor → TypeError
            // (heritage-arrow-function / heritage-async-arrow-function / superclass-generator-
            // function)。_is_nonctor_fn 认 kind bit9(箭头/方法/async/generator)。
            {
                const heritageOk = this.ctx.newLabel("heritage_ctor_ok");
                this.vm.push(VReg.S0);
                this.vm.push(VReg.S1);
                this.vm.push(VReg.S2);
                this.vm.push(VReg.V2);
                this.vm.mov(VReg.A0, VReg.V2);
                this.vm.call("_is_nonctor_fn");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jeq(heritageOk);
                this.vm.lea(VReg.A0, this.asm.addString("Class extends value is not a constructor or null"));
                this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                this.vm.and(VReg.A0, VReg.A0, VReg.V1);
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A0, VReg.A0, VReg.V1);
                this.vm.call("_throw_type_error");
                this.vm.label(heritageOk);
                this.vm.pop(VReg.V2);
                this.vm.pop(VReg.S2);
                this.vm.pop(VReg.S1);
                this.vm.pop(VReg.S0);
            }
            this.vm.load(VReg.V0, VReg.V2, 0);
            this.vm.movImm(VReg.V1, 0xc105);
            this.vm.cmp(VReg.V0, VReg.V1);
            this.vm.jne(classinfoLink);
            // 内建/闭包父:classinfo.__proto__ = 父构造器;实例 proto 链走 ctor.prototype。
            this.vm.store(VReg.S0, 16, VReg.V2);
            const parentCloSlot = this.ctx.allocLocal(`__herit_clo_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, parentCloSlot, VReg.V2);
            this.vm.push(VReg.S0);
            this.vm.push(VReg.S1);
            this.vm.push(VReg.S2);
            // TA/AB 蹦床:fnptr@8==_ta_ctor_tramp → type@16 走 _get_ctor_proto。
            // 其它内建(Boolean/Promise/Map…):.prototype 在闭包属性侧表。
            const taProtoL = this.ctx.newLabel("super_proto_ta");
            const protoDoneL = this.ctx.newLabel("super_proto_done");
            this.vm.load(VReg.V0, VReg.V2, 8); // fnptr
            this.vm.lea(VReg.V1, "_ta_ctor_tramp");
            this.vm.cmp(VReg.V0, VReg.V1);
            this.vm.jeq(taProtoL);
            // 通用:Parent.prototype = _closure_prop_get(boxedCtor, "prototype")
            this.vm.movImm64(VReg.V1, 0x7fff000000000000n);
            this.vm.or(VReg.A0, VReg.V2, VReg.V1);
            this.vm.lea(VReg.A1, this.addStringConstant("prototype"));
            this.vm.call("_tag_str_a1");
            this.vm.call("_closure_prop_get");
            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            this.vm.and(VReg.V2, VReg.RET, VReg.V1);
            this.vm.jmp(protoDoneL);
            this.vm.label(taProtoL);
            this.vm.load(VReg.V0, VReg.FP, parentCloSlot);
            this.vm.load(VReg.A0, VReg.V0, 16); // type / AB_PSEUDO@16
            this.vm.call("_get_ctor_proto"); // RET = boxed Parent.prototype
            this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            this.vm.and(VReg.V2, VReg.RET, VReg.V1);
            this.vm.label(protoDoneL);
            this.vm.pop(VReg.S2);
            this.vm.pop(VReg.S1);
            this.vm.pop(VReg.S0);
            this.vm.store(VReg.S1, 16, VReg.V2); // Sub.prototype.__proto__ = Parent.prototype
            this.vm.jmp(skipProtoLink);
            this.vm.label(classinfoLink);
            // [静态继承] 本 classinfo.__proto__(@16) = 父 classinfo(raw)。使
            // `B.staticF()`/`B.staticProp` 经 _object_get 走 classinfo 原型链命中父类静态成员,
            // 且 Object.getPrototypeOf(B) === A(node:子类构造器 __proto__ = 父构造器)。
            // V2 此处仍是父 classinfo,须在下方 props_ptr 覆写 V2 前先存。
            this.vm.store(VReg.S0, 16, VReg.V2); // classinfo.__proto__ = 父 classinfo
            this.vm.load(VReg.V2, VReg.V2, 32); // V2 = 父类信息 props_ptr
            this.vm.load(VReg.V2, VReg.V2, 24); // V2 = 父 prototype 对象(raw) = props[1].val
            this.vm.store(VReg.S1, 16, VReg.V2); // 本 prototype.__proto__ = 父 prototype
            this.vm.label(skipProtoLink);
            // 子类自有 BYTES_PER_ELEMENT(harness `ctor.BYTES_PER_ELEMENT`;
            // 静态继承到内建闭包尚不稳)。
            if (superClass && superClass.type === "Identifier" &&
                Object.prototype.hasOwnProperty.call(TA_SUPER_BPE, superClass.name)) {
                this.vm.push(VReg.S0);
                this.vm.push(VReg.S1);
                this.vm.push(VReg.S2);
                this.vm.mov(VReg.A0, VReg.S0);
                this.vm.lea(VReg.A1, this.addStringConstant("BYTES_PER_ELEMENT"));
                this.vm.call("_tag_str_a1");
                this.vm.movImm(VReg.A2, TA_SUPER_BPE[superClass.name]);
                this.vm.scvtf(0, VReg.A2);
                this.vm.fmovToInt(VReg.A2, 0);
                this.vm.call("_object_set");
                this.vm.pop(VReg.S2);
                this.vm.pop(VReg.S1);
                this.vm.pop(VReg.S0);
            }
        }

        // [shape v2 · T2a] 原型赋形资格:全部实例方法键为静态名(计算键/私有方法 →
        // 不合格 → 不赋形,安全退化 v1 行为)。访问器(get/set)不影响查找资格,仅置
        // 描述符 ACCESSOR_FREE 标志位(预留给后续 getter 检查消除)。
        let protoShapeEligible = instanceMethods.length > 0;
        let classHasAccessors = false;
        for (const m of instanceMethods) {
            if (m.kind === "get" || m.kind === "set") classHasAccessors = true;
            const k = m.key;
            if (m.computed || !k || (k.type !== "Identifier" && k.type !== "Literal" && k.type !== "StringLiteral")) {
                protoShapeEligible = false;
            }
        }

        // 添加实例方法到 prototype（访问器先按键名归组：同名 get/set 合并进
        // 同一个 24B 标记对象 {TYPE_GETTER@0, getter@8, setter@16}）
        this.emitClassMethodTable(instanceMethods, className, labelId, false, VReg.S1);

        // [ES] prototype.constructor 回指类对象:`C.prototype.constructor === C`、
        // `new C().constructor === C` 成立(此前缺该属性 → 恒 false)。类名标识符解析为
        // **裸 classinfo 指针**(见 members.js 顶层/局部类值路径),故 constructor 存裸 S0。
        this.vm.mov(VReg.A0, VReg.S1);
        this.vm.lea(VReg.A1, this.addStringConstant("constructor"));
        // [A3.5-fix] 键装箱(0x7FFC 驻留)——此前裸指针入键,原型键与读侧驻留装箱键
        // 指针比较永不命中(getOwnPropertyNames 打垃圾、原型 IC/指针扫失效)。
        this.vm.call("_tag_str_a1");
        this.vm.mov(VReg.A2, VReg.S0);
        this.vm.call("_object_define");
        // constructor on prototype must be non-enumerable per ES spec (19.1.2.21).
        this.vm.mov(VReg.A0, VReg.S1);
        this.vm.lea(VReg.A1, this.addStringConstant("constructor"));
        this.vm.call("_tag_str_a1");
        this.vm.movImm(VReg.A2, 5); // writable+configurable, not enumerable
        this.vm.call("_object_set_prop_attr");

        // [L2-③] classinfo 上定义 .name / .length 属性。C.prototype.constructor 存的是
        // classinfo(S0),_object_define 存储为裸指针值;其 .name/.length 读经
        // _object_get 查找,若无则 undefined——此前 C.prototype.constructor.name 恒 undefined。
        // 编译期 _fnNameLength 只能解析标识符(如 C.name)的静态路径,成员链
        // C.prototype.constructor.name 不可静态知,故须在 classinfo 上落真实属性。
        // 规范:name/length 均为 {writable:false,enumerable:false,configurable:true}。
        // attr=4:configurable, not writable, not enumerable.
        // [L2-③] 构造器 arity = 首个默认/剩余形参之前的形参个数(与 _fnArity / _fnNameLength 同算法)
        let ctorArity = 0;
        if (constructor && constructor.value) {
            const params = constructor.value.params || [];
            for (let i = 0; i < params.length; i++) {
                const t = params[i] ? params[i].type : null;
                if (t === "AssignmentPattern" || t === "SpreadElement" || t === "RestElement") break;
                ctorArity++;
            }
        }
        // classinfo.name:先装箱类名字符串(_js_box_string 用 A0 入参),再设 _object_define 的 A0/A1。
        // 此前 A0=classinfo 时调 _js_box_string → 把 classinfo 当字符串指针传参 → 产垃圾值。
        // [L2-③] 匿名类表达式 parser 赋合成名 __classexprN;有 NamedEvaluation
        // 盖章则用绑定/属性名,否则 ""。
        const classNameForMeta = this._classNameForMeta(stmt, className);
        this.vm.lea(VReg.A0, this.addStringConstant(classNameForMeta));
        this.vm.call("_js_box_string");         // RET = boxed class name string
        this.vm.mov(VReg.A2, VReg.RET);         // A2 = boxed name (S0 callee-saved, 跨 call 存活)
        this.vm.mov(VReg.A0, VReg.S0);          // A0 = classinfo
        this.vm.lea(VReg.A1, this.addStringConstant("name"));
        this.vm.call("_tag_str_a1");            // A1 = boxed "name" key
        this.vm.call("_object_define");         // define(classinfo, "name", boxed_name)
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.lea(VReg.A1, this.addStringConstant("name"));
        this.vm.call("_tag_str_a1");
        this.vm.movImm(VReg.A2, 4); // configurable, not writable, not enumerable
        this.vm.call("_object_set_prop_attr");
        // classinfo.length
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.lea(VReg.A1, this.addStringConstant("length"));
        this.vm.call("_tag_str_a1");
        this.vm.movImm(VReg.A2, ctorArity);
        this.vm.scvtf(0, VReg.A2);
        this.vm.fmovToInt(VReg.A2, 0); // canonical float64 number
        this.vm.call("_object_define");
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.lea(VReg.A1, this.addStringConstant("length"));
        this.vm.call("_tag_str_a1");
        this.vm.movImm(VReg.A2, 4); // configurable, not writable, not enumerable
        this.vm.call("_object_set_prop_attr");

        // [shape v2 · T2a] 原型赋形:运行时构建带键形状描述符(TYPE_SHAPE_DESC 堆块),
        // 键表 = prototype props 键列快照(运行时序即真序,含 constructor)。描述符根经
        // proto.shape@48 挂住(保守扫描覆盖);引擎 RX 片段无数据段写,安全。此后猴子
        // 补丁加键/删键/改原型经既有形状失效路径置 0,IC 键自验证兜底,安全退化。
        // 静态方法/字段初始化在此之后运行:其用户代码若改 prototype 同样走失效路径。
        if (protoShapeEligible) {
            const pskip = this.ctx.newLabel("proto_shape_skip");
            this.vm.load(VReg.V0, VReg.S1, 8);   // count
            this.vm.cmpImm(VReg.V0, 0);
            this.vm.jeq(pskip);
            this.vm.mov(VReg.S3, VReg.V0);       // S3 = count(跨 _alloc 存)
            // 键数组:count×8B
            this.vm.shlImm(VReg.A0, VReg.S3, 3);
            this.vm.call("_alloc");              // 保 S0–S3
            this.vm.mov(VReg.S2, VReg.RET);      // S2 = keys 基址
            this.vm.load(VReg.V0, VReg.S1, 32);  // props_ptr(源)
            this.vm.mov(VReg.V1, VReg.S2);       // 目的游标
            this.vm.mov(VReg.V2, VReg.S3);       // 剩余数
            const pscp = this.ctx.newLabel("proto_shape_cp");
            const pscd = this.ctx.newLabel("proto_shape_cpd");
            this.vm.label(pscp);
            this.vm.cmpImm(VReg.V2, 0);
            this.vm.jeq(pscd);
            this.vm.load(VReg.V3, VReg.V0, 0);   // key qword
            this.vm.store(VReg.V1, 0, VReg.V3);
            this.vm.addImm(VReg.V0, VReg.V0, 16);
            this.vm.addImm(VReg.V1, VReg.V1, 8);
            this.vm.subImm(VReg.V2, VReg.V2, 1);
            this.vm.jmp(pscp);
            this.vm.label(pscd);
            // 描述符:用户区 16B {@0 count|flags, @8 keys_ptr}
            this.vm.movImm(VReg.A0, 16);
            this.vm.call("_alloc");              // 保 S0–S3(S2=keys, S3=count)
            // 注意:x64 上 V0 与 RET 同物理寄存器——此后至 store(RET,...) 之间
            // 禁用 V0/V1 承载需保留的值(会覆盖 RET=描述符指针),用 V2/V3。
            this.vm.subImm(VReg.V2, VReg.RET, 16); // V2 = block
            this.vm.movImm(VReg.V3, 16);           // TYPE_SHAPE_DESC
            this.vm.storeByte(VReg.V2, 0, VReg.V3);
            this.vm.mov(VReg.V2, VReg.S3);         // V2 = count
            if (!classHasAccessors) {
                this.vm.movImm64(VReg.V3, 0x8000000000000000n); // ACCESSOR_FREE
                this.vm.or(VReg.V2, VReg.V2, VReg.V3);
            }
            this.vm.store(VReg.RET, 0, VReg.V2);   // count|flags
            this.vm.store(VReg.RET, 8, VReg.S2);   // keys_ptr
            this.vm.store(VReg.S1, 48, VReg.RET);  // 戳入 proto.shape@48
            this.vm.label(pskip);
        }

        // 添加静态方法到类对象
        this.emitClassMethodTable(staticMethods, className, labelId, true, VReg.S0);

        // 外层词法捕获盒:挂 classinfo@48(形状描述符对 classinfo 未用)。
        this.emitStoreClassCtorCaptures(classCtorCaptured);

        // [ES2022] 静态字段/块初始化**前**先绑定类名:类对象(S0)存入 classOffset 局部槽 +
        // _classinfo_ 全局。使 `static b = C.a*10`、`static { C.x = ... }` 里对类名 C 的
        // 引用能解析(此前 classOffset 存储在静态字段之后 → C 未绑定 → 引用类名的静态字段崩)。
        // 下方原有的 classOffset 存储/_classinfo_ 写入保留(S0 不变,重存幂等)。
        this.vm.store(VReg.FP, classOffset, VReg.S0);
        {
            const infoLabelEarly = classInfoLabel;
            if (!this._addedClassInfoLabels) this._addedClassInfoLabels = new Set();
            if (!this._addedClassInfoLabels.has(infoLabelEarly)) {
                this.asm.addDataLabel(infoLabelEarly);
                this.asm.addDataQword(0);
                this._addedClassInfoLabels.add(infoLabelEarly);
            }
            this.vm.lea(VReg.V1, infoLabelEarly);
            this.vm.store(VReg.V1, 0, VReg.S0);
        }

        // 初始化静态字段。DefineField 以 receiver=类对象调用 initializer → this===类。
        // 与 static {} 同法临时把 __this 指到类对象(S0),求值后恢复外层 this。
        {
            const savedThisOff = this.ctx.getLocal("__this");
            const thisOff = savedThisOff || this.ctx.allocLocal("__this");
            let savedThisTmpOff = null;
            if (staticFields.length > 0) {
                if (savedThisOff) {
                    savedThisTmpOff = this.ctx.allocLocal(`__sf_savedthis_${this.nextLabelId()}`);
                    this.vm.load(VReg.V0, VReg.FP, savedThisOff);
                    this.vm.store(VReg.FP, savedThisTmpOff, VReg.V0);
                }
                this.vm.store(VReg.FP, thisOff, VReg.S0); // __this = 类对象
            }
        for (const field of staticFields) {
            const sfRuntimeKey = this._isRuntimeComputedFieldKey(field);
            let fieldName = sfRuntimeKey ? null : this._classFieldKeyName(field);
            if (sfRuntimeKey) {
                // 计算键静态字段 `static [k] = v`:类定义时求键(含无 initializer)。
                // symbol → _js_prop_key;非 symbol → _valueToStr。
                this.vm.push(VReg.S0);
                this.compileExpression(field.key);
                this.emitToPropertyKey();
                const skt = this.ctx.allocLocal(`__csfk_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, skt, VReg.RET);
                if (field.value) {
                    this.compileExpression(field.value);
                    this.vm.mov(VReg.V1, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.V1, 0x7ffb000000000000n);
                }
                this.vm.pop(VReg.S0);
                this.vm.mov(VReg.A0, VReg.S0);
                this.vm.load(VReg.A1, VReg.FP, skt);
                this.vm.mov(VReg.A2, VReg.V1);
                this.vm.call("_object_define");
                this.vm.mov(VReg.A0, VReg.S0);
                this.vm.load(VReg.A1, VReg.FP, skt);
                this.vm.movImm(VReg.A2, 7); // CreateDataPropertyOrThrow: w+e+c
                this.vm.call("_object_set_prop_attr");
                continue;
            }
            if (fieldName == null) continue;
            // static #x：键名与实例私有同法改写为 "#ClassName#x"
            if (field.key.type === "PrivateIdentifier") fieldName = "#" + className + fieldName;
            if (field.value) {
                this.vm.push(VReg.S0);
                this.compileExpression(field.value);
                this.vm.mov(VReg.V1, VReg.RET);
                this.vm.pop(VReg.S0);
                this.vm.mov(VReg.A0, VReg.S0);
                this.vm.lea(VReg.A1, this.addStringConstant(fieldName));
                // [A3.5-fix] 键装箱(0x7FFC 驻留)
                this.vm.call("_tag_str_a1");
                this.vm.mov(VReg.A2, VReg.V1);
                this.vm.call("_object_define");
            } else {
                // [L2-③] 无初始化器的静态字段须在类对象上建 own 属性,值=undefined
                this.vm.mov(VReg.A0, VReg.S0);
                this.vm.lea(VReg.A1, this.addStringConstant(fieldName));
                this.vm.call("_tag_str_a1");
                this.vm.movImm64(VReg.A2, 0x7ffb000000000000n);
                this.vm.call("_object_define");
            }
                // flags 已物化时新增槽默认 0;CreateDataPropertyOrThrow 须 w+e+c=7
                this.vm.mov(VReg.A0, VReg.S0);
                this.vm.lea(VReg.A1, this.addStringConstant(fieldName));
                this.vm.call("_tag_str_a1");
                this.vm.movImm(VReg.A2, 7);
                this.vm.call("_object_set_prop_attr");
        }
            if (staticFields.length > 0 && this.ctx.funcName === "main") {
                // 顶层类:字段期占用的 __this 必须回到 globalThis。
                // 编译顶层 function 声明可能在 main.locals 留下未初始化的 __this,
                // 按 savedThisTmpOff 恢复会把栈垃圾当成 this(typeof this → SIGSEGV)。
                this.vm.lea(VReg.V0, "_global_this");
                this.vm.load(VReg.V0, VReg.V0, 0);
                this.vm.call("_box_obj_r");
                this.vm.store(VReg.FP, thisOff, VReg.RET);
            } else if (savedThisTmpOff !== null) {
                this.vm.load(VReg.V0, VReg.FP, savedThisTmpOff);
                this.vm.store(VReg.FP, thisOff, VReg.V0);
            } else if (staticFields.length > 0 && !savedThisOff) {
                // 本作用域原先无 __this(顶层类):恢复为 globalThis,避免污染后续 this
                this.vm.lea(VReg.V0, "_global_this");
                this.vm.load(VReg.V0, VReg.V0, 0);
                this.vm.call("_box_obj_r");
                this.vm.store(VReg.FP, thisOff, VReg.RET);
            }
        }

        // 实例计算键:类定义作用域求值(外层 var x 可见),存 cfkeys 数组供构造器取。
        // 放在静态字段之后:static [throw()] 先于后续实例键求值,对齐 abrupt completion。
        this.emitInstanceComputedKeys(instanceFields, cfkeysLabel);

        // 存储类对象到局部变量
        this.vm.store(VReg.FP, classOffset, VReg.S0);

        // [ES2022] 静态初始化块 static { ... }:类对象已在 classOffset,以 this=类对象
        // 执行块体(块内 this.x=v 直接写类对象)。__this 局部槽临时指向类对象、块后恢复
        // (类可声明于方法内,外层 this 不能被永久改写)。静态字段之后按源码近似顺序执行。
        if (staticBlocks.length > 0) {
            const savedThisOff = this.ctx.getLocal("__this");
            const thisOff = savedThisOff || this.ctx.allocLocal("__this");
            let savedThisTmpOff = null;
            if (savedThisOff) {
                savedThisTmpOff = this.ctx.allocLocal(`__sb_savedthis_${this.nextLabelId()}`);
                this.vm.load(VReg.V0, VReg.FP, savedThisOff);
                this.vm.store(VReg.FP, savedThisTmpOff, VReg.V0);
            }
            // 静态块在构造器 clone 还原之后编译,外层 ctx 从未挂 superClass
            // (`super.x` 被当成 this.x,函数父类上读到本类名)。把构造器同款
            // Super 绑定装回,并标 inStaticMethod(从父类对象而非 prototype 取)。
            const prevInStaticMethod = this.ctx.inStaticMethod;
            const prevSuperClass = this.ctx.superClass;
            const prevSuperExpr = this.ctx.superClassExpr;
            const prevSuperInfo = this.ctx.superInfoLabel;
            this.ctx.inStaticMethod = true;
            this.ctx.superClass = superClass ? (superIsExpr ? className : superClass.name) : null;
            this.ctx.superClassExpr = superIsExpr;
            this.ctx.superInfoLabel = superInfoLabel;
            for (const block of staticBlocks) {
                // 每块独立 varEnv:var 名须 shadow 外层同名槽,否则 `var test262`
                // 复用 _main 槽写穿(static-init-scope-var-*)。
                const savedBlk = this.ctx.enterScope();
                const prevSbVarEnv = this.ctx._staticBlockVarEnv;
                this.ctx._staticBlockVarEnv = true;
                const blkBody = block.body || [];
                const blkVars = {};
                collectVarDeclarations({ type: "BlockStatement", body: blkBody }, blkVars);
                for (const vn in blkVars) {
                    if (blkVars[vn] === true) this.ctx.allocLocal(vn);
                }
                this.emitHoistedVarInits({ type: "BlockStatement", body: blkBody });
                this.emitTdzBlockPrologue(block);
                this.vm.load(VReg.V0, VReg.FP, classOffset);
                this.vm.store(VReg.FP, thisOff, VReg.V0);
                for (const s of blkBody) this.compileStatement(s);
                this.ctx._staticBlockVarEnv = prevSbVarEnv;
                this.ctx.leaveScope(savedBlk);
            }
            this.ctx.inStaticMethod = prevInStaticMethod;
            this.ctx.superClass = prevSuperClass;
            this.ctx.superClassExpr = prevSuperExpr;
            this.ctx.superInfoLabel = prevSuperInfo;
            if (this.ctx.funcName === "main") {
                this.vm.lea(VReg.V0, "_global_this");
                this.vm.load(VReg.V0, VReg.V0, 0);
                this.vm.call("_box_obj_r");
                this.vm.store(VReg.FP, thisOff, VReg.RET);
            } else if (savedThisTmpOff !== null) {
                this.vm.load(VReg.V0, VReg.FP, savedThisTmpOff);
                this.vm.store(VReg.FP, thisOff, VReg.V0);     // 恢复外层 this
            }
        }

        // 类信息对象同时写入专用全局槽 _classinfo_<symbol>，
        // 供函数体内引用顶层类（静态调用 / new）时读取——
        // 函数上下文没有类的局部槽，闭包 stub 又是空实现
        {
            const infoLabel = classInfoLabel;
            if (!this._addedClassInfoLabels) this._addedClassInfoLabels = new Set();
            if (!this._addedClassInfoLabels.has(infoLabel)) {
                this.asm.addDataLabel(infoLabel);
                this.asm.addDataQword(0);
                this._addedClassInfoLabels.add(infoLabel);
            }
            this.vm.lea(VReg.V1, infoLabel);
            this.vm.store(VReg.V1, 0, VReg.S0);
        }

        // 若类被顶层函数捕获（如 fs shim 的具名导出包装函数引用 fs 类），
        // 把类信息对象同步进全局 box，覆盖预填的 _user_<name> 空 stub，
        // 使函数体内的 ClassName.staticMethod() 能拿到真实静态成员
        const classGlobalLabel = this.ctx.getMainCapturedVar
            ? this.ctx.getMainCapturedVar(className)
            : null;
        if (classGlobalLabel) {
            this.vm.lea(VReg.V1, classGlobalLabel);
            this.vm.load(VReg.V1, VReg.V1, 0); // box 指针
            this.vm.store(VReg.V1, 0, VReg.S0); // box 值 = 类信息对象 (raw)
        }
        this.syncModuleExportBinding(className, VReg.S0);
        this._privateScopes.pop(); // 出私有名作用域(与函数开头的 push 配对)
    },

    // 发射类方法表：把方法/访问器写入目标对象（targetReg = S1 prototype 或 S0 类对象）。
    // 访问器按键名归组——同名 get/set 合并为一个 24B 标记对象
    // {TYPE_GETTER@0, getter@8, setter@16}（无 getter/setter 的槽存 0），
    // 存 TEXT 裸函数指针；属性读经 _maybe_getter、写经 _object_set 命中键分支分派。
    // well-known symbol 计算键方法 `[Symbol.X](){}` 的稳定名(用于方法体 label);否则 null。
    // 覆盖 iterator/asyncIterator/hasInstance/toPrimitive/toStringTag。
    _wellKnownSymbolMethodName(method) {
        const k = method.computed && method.key;
        if (k && k.type === "MemberExpression" && k.object &&
            k.object.type === "Identifier" && k.object.name === "Symbol" &&
            k.property && k.property.type === "Identifier") {
            const p = k.property.name;
            if (p === "iterator" || p === "asyncIterator" || p === "hasInstance" ||
                p === "toPrimitive" || p === "toStringTag") {
                return "Symbol_" + p; // 仅作方法体 label 名(无 '.',免汇编器标签解析问题)
            }
        }
        return null;
    },

    // [accessor-name] 类方法静态键归一:标识符名 / 字符串字面量(含空串 "")/ 数字字面量
    // → 字符串键。此前 `key.name || key.value` 把空串键("" 为 falsy)当无效跳过
    // (`get ''(){}`/`get 1e2(){}` 的访问器从不落 prototype → C.prototype[''] 读 undefined,
    // accessor-name 族 12 测试判负);数字键此前以 number 入 label/addString 亦错。
    _classMethodKeyName(method) {
        const k = method && method.key;
        if (!k) return null;
        // Identifier 键(含字符串/数字字面量归一成的 Identifier;空串键 name==="")
        if (typeof k.name === "string") return k.name;
        if (typeof k.value === "string") return k.value; // Literal 键兜底(含空串键)
        if (typeof k.value === "number") return String(k.value);
        // `[null](){}` / `[true](){}`:ToPropertyKey 得 "null"/"true"(字面量键,编译期已知)
        if (k.type === "Literal" && k.value === null) return "null";
        if (typeof k.value === "boolean") return String(k.value);
        return null;
    },

    // 任意计算键类成员的表项发射:键在类定义时求值一次(ToPropertyKey),方法体 label 用
    // compileClassDeclaration 预分配的合成名。访问器经 _accessor_define 合并(同键 get/set
    // 是两个成员,键相同只在运行期可知)。
    emitClassRuntimeKeyMember(method, className, prefix, methodName, labelId, isStatic, targetReg) {
        const isAccessor = method.kind === "get" || method.kind === "set";
        const kindPrefix = method.kind === "get" ? "get_" : (method.kind === "set" ? "set_" : "");
        const memberLabel = `_class_${className}_${prefix}${kindPrefix}${methodName}_${labelId}`;

        this.vm.push(targetReg);
        this.compileExpression(method.key);
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_prop_key"); // ToPropertyKey:数字→字符串键,Symbol 原样
        const kSlot = this.ctx.allocLocal(`__ckk_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, kSlot, VReg.RET);

        if (isAccessor) {
            // 标记对象 {TYPE_GETTER@0, getter@8, setter@16};另半边留 0 由 _accessor_define 保留
            this.vm.movImm(VReg.A0, 24);
            this.vm.call("_alloc");
            this.vm.mov(VReg.V2, VReg.RET);
            this.vm.movImm(VReg.V1, TYPE_GETTER);
            this.vm.store(VReg.V2, 0, VReg.V1);
            this.vm.lea(VReg.V1, memberLabel);
            if (method.kind === "get") {
                this.vm.store(VReg.V2, 8, VReg.V1);
                this.vm.movImm(VReg.V1, 0);
                this.vm.store(VReg.V2, 16, VReg.V1);
            } else {
                this.vm.store(VReg.V2, 16, VReg.V1);
                this.vm.movImm(VReg.V1, 0);
                this.vm.store(VReg.V2, 8, VReg.V1);
            }
            this.vm.pop(VReg.A0);
            this.vm.load(VReg.A1, VReg.FP, kSlot);
            this.vm.mov(VReg.A2, VReg.V2);
            this.vm.call("_accessor_define");
        } else {
            this.vm.lea(VReg.A2, memberLabel);
            this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
            this.vm.or(VReg.A2, VReg.A2, VReg.V0);
            const fnSlot = this.ctx.allocLocal(`__ckfn_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, fnSlot, VReg.A2);
            this.vm.pop(VReg.A0);
            this.vm.load(VReg.A1, VReg.FP, kSlot);
            this.vm.load(VReg.A2, VReg.FP, fnSlot);
            this.vm.call("_object_define");
            this._emitSetFunctionName(fnSlot, kSlot);
        }
        // 方法/访问器按规范不可枚举(实例落 prototype;静态落 classinfo)。
        // classinfo flags 已可安全 materialize(name/length 同路径),静态成员亦须落 attr,
        // 否则去掉 gOPD 强制清 enumerable 后静态方法会误报可枚举。
        this.vm.mov(VReg.A0, targetReg);
        this.vm.load(VReg.A1, VReg.FP, kSlot);
        this.vm.movImm(VReg.A2, 5); // writable+configurable, not enumerable
        this.vm.call("_object_set_prop_attr");
    },

    // 访问器归组键:只有标识符计算键 `get [k]()` 的键是运行期值,须与同名静态键分隔;
    // 计算字面量键 `get ["g"]()` 编译期即知名字,与 `get g()` 同组。
    _classAccessorGroupKey(method, keyName) {
        const runtimeKey = !!(method.computed && method.key &&
            method.key.type === "Identifier");
        return (runtimeKey ? "@c@" : "") + keyName;
    },

    emitClassMethodTable(methods, className, labelId, isStatic, targetReg) {
        const prefix = isStatic ? "static_" : "";
        // 归组（Map 归组，禁止裸 {} 字典判真——node 原型链污染，见 [#32]）
        const accessorGroups = new Map();
        for (const method of methods) {
            if (method.kind !== "get" && method.kind !== "set") continue;
            const mn = this._classMethodKeyName(method);
            if (mn === null) continue;
            // 计算键访问器 `get [k]()`(k 为标识符)与同名静态访问器 `get k()` 归组分隔:
            // 前者键为运行时值,不可与静态字符串键合并。非计算键分组键 === mn(自举字节不变)。
            // 判据须与下方发射处一致(只有**标识符**计算键走运行时键):此前这里按
            // `method.computed` 分组、发射处按 `computed && key 是 Identifier` 查组,
            // 于是 `get ["g"](){}` 这类计算**字面量**键存进 "@c@g" 却按 "g" 查 → 查不到
            // → 整个访问器不发射(C.prototype["g"] 读 undefined)。
            const grpKey = this._classAccessorGroupKey(method, mn);
            let g = accessorGroups.get(grpKey);
            if (!g) {
                g = { getterLabel: null, setterLabel: null, emitted: false,
                      computed: !!method.computed, keyNode: method.key };
                accessorGroups.set(grpKey, g);
            }
            const kp = method.kind === "get" ? "get_" : "set_";
            const lbl = `_class_${className}_${prefix}${kp}${mn}_${labelId}`;
            if (method.kind === "get") g.getterLabel = lbl;
            else g.setterLabel = lbl;
        }

        for (const method of methods) {
            let methodName = this._classMethodKeyName(method);
            let wkName = null;
            let ckName = null;
            if (methodName === null) {
                wkName = this._wellKnownSymbolMethodName(method); // [Symbol.X](){}
                if (!wkName) {
                    // 任意计算键成员:合成名做 label,键运行期 ToPropertyKey 求值
                    ckName = method.__ckName || null;
                    if (!ckName) continue;
                    methodName = ckName;
                } else {
                    methodName = wkName; // 方法体 label 用同名(与 compileClassMethod 一致)
                }
            }
            if (ckName) {
                this.emitClassRuntimeKeyMember(method, className, prefix, methodName,
                    labelId, isStatic, targetReg);
                continue;
            }
            // well-known symbol 计算键方法:运行时求 Symbol.X 值 → _js_prop_key(与 obj[Symbol.X]
            // 读路径一致)→ 以该 symbol 键 define 方法。get/set 型极罕见,不特判(落下方跳过)。
            if (wkName && method.kind !== "get" && method.kind !== "set") {
                const wkLabel = `_class_${className}_${prefix}${methodName}_${labelId}`;
                // [#2] iterator/asyncIterator:存**字符串键** "Symbol.X"(与对象字面量
                // {[Symbol.X](){}} 存储 + for-of/for-await/obj[Symbol.X] 读键一致)。此前一律
                // _js_prop_key(symbol) 存 → 与字符串读键不匹配 → 类的 [Symbol.iterator]/
                // [Symbol.asyncIterator] 迭代协议全查不到("not a function"/静默零迭代)。
                // hasInstance/toPrimitive/toStringTag 读侧走 _symbol_wellknown(symbol 键),
                // 保持 _js_prop_key 存储不变。
                const symProp = method.key.property.name;
                const useStringKey = (symProp === "iterator" || symProp === "asyncIterator");
                this.vm.push(targetReg);
                if (useStringKey) {
                    this.emitBoxedStringKey("Symbol." + symProp, VReg.RET);
                } else {
                    this.compileExpression(method.key); // Symbol.X → well-known symbol 值
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_prop_key");
                }
                const wkt = this.ctx.allocLocal(`__cwk_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, wkt, VReg.RET);
                this.vm.pop(VReg.A0);               // targetReg
                this.vm.load(VReg.A1, VReg.FP, wkt); // 键(字符串 or symbol)
                this.vm.lea(VReg.A2, wkLabel);
                this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
                this.vm.or(VReg.A2, VReg.A2, VReg.V0);
                this.vm.call("_object_define");
                // Prototype/static methods must be non-enumerable per ES spec.
                this.vm.mov(VReg.A0, targetReg);
                this.vm.load(VReg.A1, VReg.FP, wkt);
                this.vm.movImm(VReg.A2, 5); // writable+configurable, not enumerable
                this.vm.call("_object_set_prop_attr");
                continue;
            }
            // 私有方法/访问器：label 保留原名（label 只是内部 Map 键，# 反而保证
            // 不与合法标识符方法名相撞）；prototype/类对象上的属性键按私有改写
            // "#ClassName#m"，与访问端 manglePrivateName 一致。
            // [W-34] 私有**生成器**方法 `*#m(){}` / `async *#m(){}` / `static *#m(){}`:
            // 解析器的 `*` 分支(parseClassMember)先吃掉 `*` 再取键,产出的是普通
            // Identifier{name:"#m"} 而非 PrivateIdentifier(见 lang/parser/classes.js:138)。
            // 只认 PrivateIdentifier 时这些方法以**未改写**键 "#m" 落 prototype/类对象,
            // 而访问端 getMemberPropertyName 对 "#" 起头的 Identifier 一律
            // manglePrivateName → "#ClassName#m" → 查不到 → "not a function"。
            // 判据与访问端一致:名以 "#" 起头即私有(# 非法标识符字符,公有方法撞不上)。
            const isPrivateKey = method.key.type === "PrivateIdentifier" ||
                (!method.computed && method.key.type === "Identifier" &&
                 typeof methodName === "string" && methodName[0] === "#");
            const defineKey = isPrivateKey
                ? "#" + className + methodName
                : methodName;
            // 实例私有方法(非访问器)由 emitCtorFieldInits 装 own 槽,此处跳过以免
            // 再落到 prototype → super() 返回前就能 this.#m()(规范禁止)。
            if (isPrivateKey && !isStatic && method.kind !== "get" && method.kind !== "set") {
                continue;
            }

            if (method.kind === "get" || method.kind === "set") {
                const isComputedAccessor = method.computed && method.key &&
                    method.key.type === "Identifier";
                const grpKey = this._classAccessorGroupKey(method, methodName);
                const group = accessorGroups.get(grpKey);
                if (!group || group.emitted) continue; // 同名第二个访问器已合并
                group.emitted = true;
                // 计算键访问器 `get [k]()`:先求键值→ToPropertyKey,暂存 FP 槽(marker 构造在
                // _alloc/store 间无调用,V2 存活;pop/load 不毁 V2)。非计算键走静态字符串键。
                let ckSlot = null;
                if (isComputedAccessor) {
                    this.vm.push(targetReg);
                    this.compileExpression(method.key);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_prop_key");
                    ckSlot = this.ctx.allocLocal(`__cacck_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, ckSlot, VReg.RET);
                }
                // 标记对象 {TYPE_GETTER@0, getter@8, setter@16}
                this.vm.movImm(VReg.A0, 24);
                this.vm.call("_alloc");
                this.vm.mov(VReg.V2, VReg.RET); // user_ptr
                this.vm.movImm(VReg.V1, TYPE_GETTER);
                this.vm.store(VReg.V2, 0, VReg.V1); // type@value+0（用户区；不碰 block+0 的分配器 size 头，GC sweep 靠它走块）
                if (group.getterLabel) {
                    this.vm.lea(VReg.V1, group.getterLabel);
                } else {
                    this.vm.movImm(VReg.V1, 0);
                }
                this.vm.store(VReg.V2, 8, VReg.V1); // getter@value+8（无则 0）
                if (group.setterLabel) {
                    this.vm.lea(VReg.V1, group.setterLabel);
                } else {
                    this.vm.movImm(VReg.V1, 0);
                }
                this.vm.store(VReg.V2, 16, VReg.V1); // setter@value+16（无则 0）
                if (isComputedAccessor) {
                    this.vm.pop(VReg.A0);                  // targetReg
                    this.vm.load(VReg.A1, VReg.FP, ckSlot); // 运行时键字符串
                } else {
                    this.vm.mov(VReg.A0, targetReg);
                    this.vm.lea(VReg.A1, this.addStringConstant(defineKey));
                    // [A3.5-fix] 键装箱(0x7FFC 驻留),同 constructor/方法键
                    this.vm.call("_tag_str_a1");
                }
                this.vm.mov(VReg.A2, VReg.V2);
                this.vm.call("_object_define");
                // Accessor on prototype/classinfo must be non-enumerable per ES spec.
                this.vm.mov(VReg.A0, targetReg);
                if (isComputedAccessor) {
                    this.vm.load(VReg.A1, VReg.FP, ckSlot);
                } else {
                    this.vm.lea(VReg.A1, this.addStringConstant(defineKey));
                    this.vm.call("_tag_str_a1");
                }
                this.vm.movImm(VReg.A2, 5); // writable+configurable, not enumerable
                this.vm.call("_object_set_prop_attr");
                continue;
            }

            const methodLabel = `_class_${className}_${prefix}${methodName}_${labelId}`;
            // 计算键方法 `[k](){}`(k 为标识符):运行时求键 → _valueToStr → 以该键 define。
            // 方法体 label 仍按 key 标识符名静态生成(与 compileClassMethod 一致,故此前误存
            // 在静态键 "k" 下、`obj[k值]()` 找不到 → undefined)。复杂计算键(`[a+b]()`,
            // 无稳定 label 名)仍随 compileClassMethod 一并跳过。
            const isIdentComputedKey = method.computed && method.key &&
                method.key.type === "Identifier";
            if (isIdentComputedKey) {
                this.vm.push(targetReg);
                this.compileExpression(method.key);      // 求变量 k 的值
                this.vm.mov(VReg.A0, VReg.RET);
                // ToPropertyKey:`class E { [s](){} }`(s 为 Symbol)此前经 _valueToStr
                // 直接抛 "Cannot convert a Symbol value to a string"
                this.vm.call("_js_prop_key");
                const kt = this.ctx.allocLocal(`__cmk_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, kt, VReg.RET);
                this.vm.lea(VReg.A2, methodLabel);
                this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
                this.vm.or(VReg.A2, VReg.A2, VReg.V0);
                const fnSlot = this.ctx.allocLocal(`__cmfn_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, fnSlot, VReg.A2);
                this.vm.pop(VReg.A0);                     // targetReg 值
                this.vm.load(VReg.A1, VReg.FP, kt);       // 运行时键
                this.vm.load(VReg.A2, VReg.FP, fnSlot);
                this.vm.call("_object_define");
                // Prototype/static methods must be non-enumerable per ES spec.
                this.vm.mov(VReg.A0, targetReg);
                this.vm.load(VReg.A1, VReg.FP, kt);
                this.vm.movImm(VReg.A2, 5); // writable+configurable, not enumerable
                this.vm.call("_object_set_prop_attr");
                this._emitSetFunctionName(fnSlot, kt);
                continue;
            }
            this.vm.mov(VReg.A0, targetReg);
            this.vm.lea(VReg.A1, this.addStringConstant(defineKey));
            // [A3.5-fix] 键装箱(0x7FFC 驻留),同 constructor/访问器键
            this.vm.call("_tag_str_a1");
            // 将函数地址标记为 JS 函数值（TAG_FUNCTION = 0x7FFF）
            this.vm.lea(VReg.A2, methodLabel);
            this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
            this.vm.or(VReg.A2, VReg.A2, VReg.V0);
            this.vm.call("_object_define");
            // Prototype/static methods must be non-enumerable per ES spec.
            this.vm.mov(VReg.A0, targetReg);
            this.vm.lea(VReg.A1, this.addStringConstant(defineKey));
            this.vm.call("_tag_str_a1");
            this.vm.movImm(VReg.A2, 5); // writable+configurable, not enumerable
            this.vm.call("_object_set_prop_attr");
        }
    },

    // 编译类方法
    compileClassMethod(className, method, labelId, isStatic) {
        let methodName = this._classMethodKeyName(method);
        if (methodName === null) {
            methodName = this._wellKnownSymbolMethodName(method); // [Symbol.X](){}
            // 任意计算键(`[a+b](){}`):用 compileClassDeclaration 预分配的合成名当 label
            if (!methodName) methodName = method.__ckName || null;
            if (!methodName) return;
        }
        const prefix = isStatic ? "static_" : "";
        const kindPrefix = method.kind === "get" ? "get_" : (method.kind === "set" ? "set_" : "");
        const methodLabel = `_class_${className}_${prefix}${kindPrefix}${methodName}_${labelId}`;
        const returnLabel = `${methodLabel}_return`;

        this.vm.label(methodLabel);
        // [W-27] 方法入函数元数据侧表:`K.prototype.m.name` / `.length` 的接收者是运行期
        // 取出的函数值(原型链读),编译期静态解析点覆盖不到。
        // [L2-③] 扩展覆盖:访问器(get/set)按规范名 "get x"/"set x" 登记,length=0/1;
        // 计算键与 well-known symbol 仍跳过(名非静态)。
        if (method.key &&
            (method.key.type === "Identifier" || method.key.type === "Literal" ||
             method.key.type === "StringLiteral" || method.key.type === "NumericLiteral" ||
             method.key.type === "PrivateIdentifier")) {
            // [L2-③] 覆盖计算键中的字面量键: `["computed"](){}`/`[1](){}` 名称编译期已知
            // (静态字符串/数字键),同样入函数元数据侧表供 `.name`/`.length` 反射。
            // 变量/表达式计算键(名非静态)仍跳过,留运行期侧表路径。
            let metaName = typeof methodName === "number" ? String(methodName) : methodName;
            if (method.kind === "get") metaName = "get " + metaName;
            else if (method.kind === "set") metaName = "set " + metaName;
            if (metaName) {
                // 访问器 length:getter=0,setter=1;普通方法 = fnArity(method.value)
                let metaArityExpr = method.value;
                if (method.kind === "get") {
                    metaArityExpr = { type: "FunctionExpression", params: [] };
                } else if (method.kind === "set") {
                    metaArityExpr = { type: "FunctionExpression", params: [{ type: "Identifier", name: "v" }] };
                }
                this.registerFuncMeta(methodLabel, metaArityExpr, metaName);
            }
        }
        // [批次D] 生成器/async 生成器方法(`*g(){}` / `async *g(){}`)。此前类方法路径**完全
        // 不识别**生成器:方法体被当普通函数直编,体内 yield 直接 `_coroutine_yield` 在主栈上
        // 挂起 → `c.g()`/`C.prototype.g.call(c)` 一律 SIGSEGV。修法与顶层生成器声明
        // (compiler/index.js)、生成器函数表达式(closures.js)同构:方法标签处落生成器 stub
        // (建协程 + 返回 genobj),真体在 _gbody,由 _coroutine_entry 首次 resume 进入。
        // stub 保存 A5=this 到 CORO_THIS,故方法生成器的 this 绑定与直调一致;方法以裸函数
        // 指针存 prototype,提取出来的引用(`var r = C.prototype.g; r.call(c)`)走同一入口。
        const isGenMethod = !!(method.value && (method.value.isGenerator === true || method.value.generator === true));
        const isAsyncGenMethod = isGenMethod && !!(method.value && method.value.isAsync);
        const isAsyncMethod = !!(method.value && method.value.isAsync && !isGenMethod);
        // async 方法:标签处先落 stub(建协程+Promise 返回);真体在 _abody(经 _coroutine_entry
        // 进入,用 async 返回路径 resolve coro+88 的 Promise)。方法以裸函数指针存表,调用点
        // compileMethodCall 不识别 async,故由 stub 自建协程(与 async 函数调用同构)。
        let fdiList = null;
        // [FDI] 匿名 class 表达式(var C = class {…})无 id → _genStubClassMethodParams 扫不到
        // 形参。编译本方法时直传 params,stub 内 _genStubParams 优先读 override。
        const _prevGenParamsOverride = this._genStubParamsOverride;
        this._genStubParamsOverride = (method.value && method.value.params) || [];
        try {
            if (isAsyncMethod) {
                this.emitAsyncMethodStub(methodLabel + "_abody", false);
            } else if (isAsyncGenMethod) {
                fdiList = this.emitAsyncGeneratorStub(methodLabel + "_gbody", false);
            } else if (isGenMethod) {
                fdiList = this.emitGeneratorStub(methodLabel + "_gbody", false);
            }
        } finally {
            this._genStubParamsOverride = _prevGenParamsOverride;
        }
        // [P1] async/生成器禁录;其余与闭包路径同用 _fnNeedsP1Record。
        if (!(method.value && method.value.isAsync) && !isGenMethod &&
            method.value && this._fnNeedsP1Record(method.value)) {
            this.vm.beginRecord();
        }
        this.vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        const savedCtx = this.ctx;
        // [label collision] 掺入类声明唯一 labelId:两个模块同名类的同名方法
        // (`Server.who`)否则生成相同的方法体局部标签而互相覆盖(见 compileClassDeclaration)。
        this.ctx = this.ctx.clone(`${className}.${methodName}.${labelId}`);
        this.ctx.locals = new Map();
        this.ctx.localTemps = null;
        this.ctx.localOffset = 0;
        // 方法体自己的 box-on-capture 分析:被嵌套闭包捕获(且写)的 `let`/`const`
        // 标量须落 box,否则兄弟闭包与方法体各持一份副本、写不回传(class 方法此前
        // 漏做此分析——只继承外层 ctx.boxedVars,不含方法自身局部)。**合并**而非覆写:
        // 保留外层(模块/全局)已 box 的名字(方法体引用它们时需知其为 box 才发 deref,
        // 丢弃会退化成普通槽读到垃圾),再并入方法自身的共享局部。新建 Set 避免改动
        // savedCtx 共享的集合。
        const methodBoxedVars = analyzeSharedVariables(method.value);
        for (const _n of analyzeDirectEvalBoxedVars(method.value)) methodBoxedVars.add(_n);
        if (savedCtx.boxedVars) {
            for (const _n of savedCtx.boxedVars) methodBoxedVars.add(_n);
        }
        this.ctx.boxedVars = methodBoxedVars;
        this.ctx.inClass = true;
        this.ctx.className = className;
        this.ctx.inStaticMethod = !!isStatic; // super.m()/super.prop 在静态方法内走父类对象
        this.ctx.returnLabel = returnLabel;
        // [批次D] 生成器方法体:跑在协程栈上(inCoroBody → 体内无 try 的 throw/finally 重抛
        // 走 returnLabel 完成协程,不跨栈 unwind);async 生成器体内 yield 需先 resolve
        // coro+88 的 next() Promise(inAsyncGenerator,见 emitAsyncYieldValue)。ctx 为本方法
        // 专属 clone,方法末尾整体还原 savedCtx,无需逐字段恢复。
        this.ctx.inCoroBody = isGenMethod;
        this.ctx.inAsyncGenerator = isAsyncGenMethod;
        // async 方法体:未捕获异常 reject 关联 Promise(而非退出),同 async 函数。
        let asyncMethodRejectLabel = null;
        if (isAsyncMethod) {
            this.ctx.inAsyncFunction = true;
            asyncMethodRejectLabel = this.ctx.newLabel("async_method_reject");
            this.ctx.exceptionLabel = asyncMethodRejectLabel;
            this.emitInstallAsyncExcFrame(asyncMethodRejectLabel);
        }

        // 保存 this (A0)
        // 注意：JS 方法调用约定中，this 通过 A5 传递（而不是 A0）
        // 这是 asm.js 的特殊约定，用于区分方法调用和普通函数调用
        const thisOffset = this.ctx.allocLocal("__this");
        this.vm.mov(VReg.V0, VReg.A5); // 从 A5 获取 this
        this.vm.store(VReg.FP, thisOffset, VReg.V0);

        // 处理参数
        const params = method.value.params || [];
        // [#49] 类方法 `arguments`(与 compileFunctionBody 同构)。此前类方法路径不建
        // arguments → `method(x = arguments[2])` 读 globalThis/垃圾 → SIGSEGV
        // (params-dflt-*-ref-arguments / params-dflt-meth-*-args-unmapped)。
        const usesArguments =
            !(params || []).some((p) =>
                (p.type === "Identifier" && p.name === "arguments") ||
                (p.type === "AssignmentPattern" && p.left && p.left.name === "arguments") ||
                (p.type === "SpreadElement" && p.argument && p.argument.name === "arguments")) &&
            this.functionBodyUsesArguments(method.value);
        let methNeedFullArgv = usesArguments;
        if (!methNeedFullArgv) {
            for (let ri = 0; ri < params.length; ri++) {
                if (params[ri] && params[ri].type === "SpreadElement") { methNeedFullArgv = true; break; }
            }
        }
        this.emitArgvSpillSnapshot(methNeedFullArgv ? 16 : params.length);
        if (usesArguments) {
            this.emitArgumentsArray();
        }
        if (this._paramsHaveExpressions(params)) this.emitSeedMainCapturedVars();
        const patternParams = [];
        const methodParamOffsets = []; // 标识符参数 {name,offset},供 box-on-capture
        // [L2-③ TDZ] 类方法默认值自引用/后向引用(直接 Identifier 形态 x = y)。两次单循环
        // + indexOf(嵌套 for 形态在自举产物原生误编):tdzNames 收集形参名,第二遍把
        // 引用「本形参及之后形参」的默认值标 _tdzRefName,compileIdentifier 据此抛
        // ReferenceError。
        const tdzNames = [];
        for (let ti = 0; ti < params.length; ti++) {
            const tp = params[ti];
            if (tp && tp.type === "Identifier") tdzNames.push(tp.name);
            else if (tp && tp.type === "AssignmentPattern" && tp.left && tp.left.type === "Identifier") tdzNames.push(tp.left.name);
        }
        for (let mi = 0; mi < params.length; mi++) {
            const mp = params[mi];
            if (mp && mp.type === "AssignmentPattern" && mp.right && mp.right.type === "Identifier" &&
                tdzNames.indexOf(mp.right.name, mi) >= 0) {
                mp.right._tdzRefName = mp.right.name;
            }
        }
        for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (param.type === "SpreadElement" && param.argument && param.argument.type === "Identifier") {
                // 剩余参数 ...rest（方法：A_pos..A4，A5=this）
                this.emitRestParam(param.argument.name, i);
                continue;
            }
            if (this._isPatternParam(param)) {
                // [#47] 解构参数 method({a,b}){}：实参落临时槽,解构延后(防 A 寄存器互踩)。
                // [FDI eager] 生成器方法 pattern 形参已在调用期(stub)绑定,体内走 transfer
                // 路径(见下),此处不落槽。
                if (isGenMethod && fdiList) continue;
                const pat = param.type === "AssignmentPattern" ? param.left : param;
                const dexpr = param.type === "AssignmentPattern" ? param.right : null;
                const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                this.emitArgToSlot(i, pslot, 0);
                patternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                continue;
            }
            const paramName = param.name || (param.left && param.left.name);
            const defaultExpr = (param.type === "AssignmentPattern") ? param.right : null;
            // [FDI ident] 生成器方法标识符默认值形参已在调用期(stub)求值,经 transfer
            // 数组绑定,此处不落槽/不求默认。
            if (isGenMethod && fdiList && paramName && fdiList.indexOf(paramName) !== -1) continue;
            // [FDI ident] 生成器方法标识符默认值形参已在调用期(stub)求值,经 transfer
            // 数组绑定,此处不落槽/不求默认。
            if (isGenMethod && fdiList && paramName && fdiList.indexOf(paramName) !== -1) continue;
            if (paramName) {
                const paramOffset = this.ctx.allocLocal(paramName);
                methodParamOffsets.push({ name: paramName, offset: paramOffset });
                // 方法约定: A0-A4 实参、A5=this;第 6 个起从 argv 快照装(6 默认参 SIGBUS)
                this.emitArgToSlot(i, paramOffset, 0);
                if (defaultExpr) {
                    // x64: V1/V2 别名 RCX/RDX = A3/A2，会踩掉尚未入槽的后续实参；
                    // 改用 V5/V6(R10/R11)。arm64 保持 V1/V2，产物逐字节不变。
                    const chkReg = this.vm.backend.name === "x64" ? VReg.V5 : VReg.V1;
                    const undReg = this.vm.backend.name === "x64" ? VReg.V6 : VReg.V2;
                    const skip = this.ctx.newLabel("mdefparam_skip");
                    this.vm.load(chkReg, VReg.FP, paramOffset);
                    this.vm.movImm64(undReg, 0x7ffb000000000000n); // JS_UNDEFINED
                    this.vm.cmp(chkReg, undReg);
                    this.vm.jne(skip);
                    const _prevEvalParam = this.ctx._evalInParamInit;
                    this.ctx._evalInParamInit = true;
                    this.compileExpression(defaultExpr);
                    this.ctx._evalInParamInit = _prevEvalParam;
                    this.vm.store(VReg.FP, paramOffset, VReg.RET);
                    this.vm.label(skip);
                }
            }
        }
        // 被嵌套闭包捕获的标识符参数:创建 box、把值搬入(与 compileFunctionBody 一致)。
        // 若漏做,方法体/兄弟闭包读该参数会把普通值当 box 指针解引用 → 读垃圾/崩。
        for (let i = 0; i < methodParamOffsets.length; i++) {
            const p = methodParamOffsets[i];
            if (methodBoxedVars.has(p.name)) {
                this.vm.load(VReg.V1, VReg.FP, p.offset);
                this.vm.push(VReg.V1);
                this.vm.call("_box_alloc");
                this.vm.store(VReg.FP, p.offset, VReg.RET);
                this.vm.pop(VReg.V1);
                this.vm.store(VReg.RET, 0, VReg.V1);
            }
        }

        // [#47] 解构参数:实参已落栈,此处解构到局部。
        // [FDI eager] 生成器方法 pattern 形参已在调用期(stub)绑定:从 coro+168 transfer
        // 数组按绑定序取叶值,跳过重复解构(二重消费自定义迭代器会错值/错计)。
        if (isGenMethod && fdiList) {
            this.emitGenTransferLoads(fdiList);
        } else {
            for (let i = 0; i < patternParams.length; i++) {
                this.emitParamDestructure(patternParams[i].pat, patternParams[i].slot, patternParams[i].dflt);
            }
        }

        // 编译方法体
        this.unbindBodyBindingsAfterParamInit(method.value.body, params);
        if (method.value.body && method.value.body.body) {
            for (const bodyStmt of method.value.body.body) {
                this.compileStatement(bodyStmt);
            }
        }

        // 默认返回 undefined(真正的 0x7FFB,非裸 int 0——与显式 `return;` 一致)
        this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        this.vm.label(returnLabel);
        if (isAsyncMethod) {
            this.emitAsyncResolveAndReturnFromRet();
            this.vm.label(asyncMethodRejectLabel);
            this.emitAsyncRejectFromException();
        } else {
            this.vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
            this.vm.endRecord(); // [P1]
        }

        this.ctx = savedCtx;
    },
};

// asm.js 编译器 - 语句编译
// 编译各类 JavaScript 语句

import { VReg } from "../../vm/index.js";
import { Type, inferType, isCompatible, typeName } from "../core/types.js";
import { analyzeSharedVariables, analyzeDirectEvalBoxedVars } from "../../lang/analysis/closure.js";

// Box 对象布局：存储被捕获变量的包装对象
// +0: 实际值
const BOX_VALUE_OFFSET = 0;
const BOX_SIZE = 8;

// getter 标记对象类型（与 runtime/core/allocator.js TYPE_GETTER 一致）
const TYPE_GETTER = 60;

// [批次D TDZ] 未初始化绑定哨兵值 —— 与 compiler/index.js 的
// UNINITIALIZED_BINDING_SENTINEL 必须保持一致(emitUninitializedBindingGuard 比对它)
const TDZ_SENTINEL = 0x7ff70000deadbeefn;

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
            case "ForOfStatement":
                this.compileForOfStatement(stmt);
                break;
            case "ForInStatement":
                this.compileForInStatement(stmt);
                break;
            case "DoWhileStatement":
                this.compileDoWhileStatement(stmt);
                break;
            case "BlockStatement":
                this.compileBlockStatement(stmt);
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
            let off = this.ctx.getLocal(n);
            if (!off) off = this.ctx.allocLocal(n);
            this.vm.movImm64(VReg.V1, TDZ_SENTINEL);
            this.vm.store(VReg.FP, off, VReg.V1);
        }
    },

    // 编译块语句
    compileBlockStatement(stmt) {
        const saved = this.ctx.enterScope();
        this.emitTdzBlockPrologue(stmt);
        for (const s of stmt.body) {
            this.compileStatement(s);
        }
        this.ctx.leaveScope(saved);
    },

    // with (obj) stmt:求值 obj 存帧槽,压入 ctx.withScopes(body 内标识符先查其属性),
    // 编译 body 后弹出。编译器不含 with → withScopes 恒空 → 标识符解析逐字节不变。
    compileWithStatement(stmt) {
        this.compileExpression(stmt.object);
        const slot = this.ctx.allocLocal(`__with_obj_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, slot, VReg.RET);
        if (!this.ctx.withScopes) this.ctx.withScopes = [];
        this.ctx.withScopes.push(slot);
        this.compileStatement(stmt.body);
        this.ctx.withScopes.pop();
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
                    const gl = this.ctx.getMainCapturedVar(name);
                    if (gl) {
                        this.vm.lea(VReg.V2, gl);
                        this.vm.load(VReg.V2, VReg.V2, 0);
                        this.vm.store(VReg.V2, BOX_VALUE_OFFSET, VReg.V1);
                    }
                    continue;
                }

                // 检查这个变量是否需要装箱（会被闭包捕获）
                const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(name);

                // 检查这个变量是否被顶层函数捕获（需要存储到全局位置）
                const globalLabel = this.ctx.getMainCapturedVar(name);

                // 检测是否为 node builtin 空对象声明（const os = {}）
                // 如果是，立即将堆分配的对象指针存入全局 _builtin_<name>
                // 这样即使变量被 boxed（export），builtin 也能正常工作
                const isBuiltinKnown = ["os", "process", "buffer"].includes(name);
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
                    if (globalLabel) {
                        // 全局捕获变量：复用在 _main 入口处预分配的 box
                        this.vm.lea(VReg.V2, globalLabel);
                        this.vm.load(VReg.RET, VReg.V2, 0);
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

                        // 将值存入 box
                        this.vm.store(VReg.V1, BOX_VALUE_OFFSET, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                    } else {
                        // 初始化为 0
                        this.vm.movImm(VReg.V1, 0);
                        this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                    }
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

                        this.vm.store(VReg.FP, offset, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                    } else {
                        // 未初始化的变量存储 JS_UNDEFINED (0x7FFB000000000000)
                        // 这确保 typeof 和打印操作能正确识别 undefined 值
                        this.vm.movImm64(VReg.V1, 0x7ffb000000000000n); // was lea+load _js const
                        this.vm.store(VReg.FP, offset, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                    }
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
                    this.compileExpression(prop.key);
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
                    this.vm.load(VReg.A0, VReg.FP, srcSlot);
                    this.emitBoxedStringKey(keyName, VReg.A1);
                    this.vm.call("_object_get");
                    // [test262 S1] getter 解包(同计算键路径)
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, srcSlot);
                    this.vm.call("_maybe_getter");
                }
                if (dflt) {
                    // 缺键(_object_get 返 raw 0)或 tagged undefined → 用默认表达式
                    const dfltL = this.ctx.newLabel("odestr_dflt");
                    const doneL = this.ctx.newLabel("odestr_done");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jeq(dfltL);
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0x7FFB);
                    this.vm.jeq(dfltL);
                    this.emitBindTarget(targetNode, mode);
                    this.vm.jmp(doneL);
                    this.vm.label(dfltL);
                    this.compileExpression(dflt);
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
        // 数组(0x7FFE)/字符串(0x7FFC)/数字/bool(高16 非上述)不动,避免非指针值被
        // _array_spread_into 当指针解引崩。非可迭代对象 spread 得空数组(_array_spread_into
        // 函数-tag 守卫,不挂)。
        {
            const iterSpreadL = this.ctx.newLabel("destr_iter_spread");
            const iterSkipL = this.ctx.newLabel("destr_iter_skip");
            this.vm.load(VReg.V0, VReg.FP, srcSlot);
            this.vm.shrImm(VReg.V1, VReg.V0, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFD);
            this.vm.jeq(iterSpreadL);        // 装箱对象 → 展开
            this.vm.cmpImm(VReg.V1, 0);
            this.vm.jne(iterSkipL);          // 非未装箱堆指针 → 不动
            this.vm.movImm64(VReg.V1, this.os === "wasi" ? 0x8000000n : 0x100200000n);
            this.vm.cmp(VReg.V0, VReg.V1);
            this.vm.jlt(iterSkipL);          // 小于堆区下界(小整数/浮点位)→ 不动
            // 未装箱堆指针:类型字节 TYPE_ARRAY(1) 的裸数组(如 Map 展开产的 [k,v] 对)不 spread,
            // 走既有下标路径——否则 `[[k,v]]=map` 内层对裸数组对再 spread → 空/崩。
            this.vm.loadByte(VReg.V1, VReg.V0, 0);
            this.vm.cmpImm(VReg.V1, 1);
            this.vm.jeq(iterSkipL);
            this.vm.label(iterSpreadL);
            this.vm.movImm(VReg.A0, 0);
            this.vm.call("_array_new_with_size");
            this.vm.call("_box_arr_r"); // box->helper
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.load(VReg.A1, VReg.FP, srcSlot);
            this.vm.call("_array_spread_into");
            this.vm.store(VReg.FP, srcSlot, VReg.RET);
            this.vm.label(iterSkipL);
        }
        const els = pattern.elements || [];
        for (let ei = 0; ei < els.length; ei++) {
            const el = els[ei];
            if (!el) continue;
            // [#34] rest:[..., ...rest] → slice(ei) 余下成新数组
            if (el.type === "SpreadElement") {
                const rn = el.argument && el.argument.name;
                if (!el.argument) continue;   // [test262 S1] 允许 pattern rest 目标([...[x]]);emitBindTarget 递归解构
                this.vm.load(VReg.A0, VReg.FP, srcSlot);
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
            this.vm.load(VReg.A0, VReg.FP, srcSlot);
            this.vm.movImm(VReg.A1, ei);
            this.vm.call("_subscript_get");
            if (dflt) {
                const dfltL = this.ctx.newLabel("destr_dflt");
                const doneL = this.ctx.newLabel("destr_done");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jeq(dfltL);
                this.vm.shrImm(VReg.V1, VReg.RET, 48);
                this.vm.cmpImm(VReg.V1, 0x7FFB); // tagged undefined
                this.vm.jeq(dfltL);
                this.emitBindTarget(targetNode, mode);
                this.vm.jmp(doneL);
                this.vm.label(dfltL);
                this.compileExpression(dflt);
                this.emitBindTarget(targetNode, mode);
                this.vm.label(doneL);
            } else {
                this.emitBindTarget(targetNode, mode);
            }
        }
    },

    // [#47/#48] 绑定单个解构目标(约定:当前值已在 RET)。
    // 嵌套 pattern → 先落临时槽再递归;否则按 mode 分派到声明绑定/赋值。
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
            this.compileExpression(defaultExpr);
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
            this.vm.call("_box_alloc");
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
            this.vm.call("_box_alloc");
            this.vm.store(VReg.FP, offset, VReg.RET); // 存储 box 指针
            this.vm.store(VReg.RET, BOX_VALUE_OFFSET, VReg.V1); // 存入函数指针
        } else {
            this.vm.store(VReg.FP, offset, VReg.RET);
        }
    },

    // 判断函数体 AST 内是否引用了标识符 name（用于识别递归自引用）。
    // 递归遍历所有子节点，跳过非计算成员/属性的 key（obj.name 不算对 name 的引用）。
    _functionBodyReferencesName(node, name) {
        if (!node || typeof node !== "object") return false;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                if (this._functionBodyReferencesName(node[i], name)) return true;
            }
            return false;
        }
        if (node.type === "Identifier") {
            return node.name === name;
        }
        // 非计算成员访问：只看 object，property 是字面 key
        if (node.type === "MemberExpression" && !node.computed) {
            return this._functionBodyReferencesName(node.object, name);
        }
        if (node.type === "Property" && !node.computed) {
            return this._functionBodyReferencesName(node.value, name);
        }
        for (const key in node) {
            if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
            if (this._functionBodyReferencesName(node[key], name)) return true;
        }
        return false;
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
        const FUSE_OPS = ["<", "<=", ">", ">=", "===", "!==", "!="];
        let fuse = null;
        if (test && test.type === "BinaryExpression" && FUSE_OPS.includes(test.operator)) {
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
        if (["<", "<=", ">", ">="].indexOf(test.operator) < 0) return null;
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

    // [解箱① P4.1] 子树是否含"会腐蚀 caller-saved FP 或引入嵌套作用域"的节点:
    // 调用/new(clobber d0-d7)、成员访问(_subscript_get/_object_get 是调用)、嵌套函数
    // (可能捕获)、await/yield。任一存在 → 循环体不适合浮点累加器 FP 驻留。
    _subtreeBlocksFpAccum(node) {
        if (!node || typeof node !== "object") return false;
        const t = node.type;
        if (t === "CallExpression" || t === "NewExpression" || t === "MemberExpression" ||
            t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "FunctionDeclaration" ||
            t === "TaggedTemplateExpression" || t === "TemplateLiteral" || t === "AwaitExpression" ||
            t === "YieldExpression") return true;
        for (const k in node) {
            if (k === "type") continue;
            const v = node[k];
            if (v && typeof v === "object") {
                if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (this._subtreeBlocksFpAccum(v[i])) return true; }
                else if (this._subtreeBlocksFpAccum(v)) return true;
            }
        }
        return false;
    },

    // [解箱① P4.1] 检测循环体内可 FP 驻留的浮点标量累加器,返回 [{name,offset}]。
    // 条件:body/test/update 无 call/成员/嵌套函数;累加器 s 是简单局部(非装箱/捕获)、
    // 每次写都是 `s = s <op> E`(s 为左操作数)或 `s <op>= E`(op ∈ +,-,*,/,%),
    // 无 s++ 等其他写形态;E 亦落在同一 call-free 子树内(随体扫描已保证)。
    detectFpAccumVars(stmt) {
        if (this._subtreeBlocksFpAccum(stmt.body)) return [];
        if (stmt.test && this._subtreeBlocksFpAccum(stmt.test)) return [];
        if (stmt.update && this._subtreeBlocksFpAccum(stmt.update)) return [];
        const ok = {};   // name -> true(暂定合格)
        const bad = {};  // name -> true(出现不合规写,永久淘汰)
        const arithOps = ["+", "-", "*", "/", "%"];
        const isAccumForm = (node) => {
            if (node.type === "AssignmentExpression" && node.left && node.left.type === "Identifier") {
                const nm = node.left.name;
                if (node.operator === "=") {
                    // s = s <op> E
                    const r = node.right;
                    if (r && r.type === "BinaryExpression" && arithOps.indexOf(r.operator) >= 0 &&
                        r.left && r.left.type === "Identifier" && r.left.name === nm) {
                        // `+` 可能是字符串拼接:E 推断为 STRING 则淘汰(勿把串累加当浮点丢弃)
                        if (r.operator === "+" && inferType(r.right, this.ctx) === Type.STRING) return "\0" + nm;
                        return nm;
                    }
                    return "\0" + nm; // 对 nm 的非累加写 → 淘汰
                }
                if (["+=", "-=", "*=", "/=", "%="].indexOf(node.operator) >= 0) {
                    // `s += E`:E 为字符串则是拼接,淘汰(见上)
                    if (node.operator === "+=" && inferType(node.right, this.ctx) === Type.STRING) return "\0" + nm;
                    return nm;
                }
                return "\0" + nm; // &&= 等 → 淘汰
            }
            if (node.type === "UpdateExpression" && node.argument && node.argument.type === "Identifier") {
                return "\0" + node.argument.name; // s++/s-- 不按浮点累加处理 → 淘汰
            }
            return null;
        };
        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            const res = isAccumForm(node);
            if (res) {
                if (res.charCodeAt(0) === 0) bad[res.slice(1)] = true;
                else ok[res] = true;
            }
            for (const k in node) {
                if (k === "type") continue;
                const v = node[k];
                if (v && typeof v === "object") {
                    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i]); }
                    else walk(v);
                }
            }
        };
        walk(stmt.body);
        // 外层循环已占用的 FP 寄存器(嵌套时避开,防抢占)
        const used = {};
        for (const enm in this.ctx.fpAccumVars) {
            const rr = this.ctx.fpAccumVars[enm];
            if (typeof rr === "number" && rr > 0) used[rr] = true;
        }
        const out = [];
        let reg = 2; // d2 起(d0/d1 算术 scratch、d7 fmod temp 均避开)
        for (const nm in ok) {
            if (bad[nm]) continue;
            if (this.ctx.getFpAccum(nm) > 0) continue; // 已被外层循环 pin,沿用不重 pin
            // 累加器静态类型为 STRING(如 `let g = ""`)→ 排除:字符串 `+=` 是拼接,
            // 绝不可当浮点累加(否则 FP 驻留把 concat 静默丢弃,g 恒空)。这是主守卫,
            // 覆盖初值即串的常见模式;上面 isAccumForm 的 RHS 串守卫覆盖无初值 `let g` 情形。
            if (this.ctx.getVarType && this.ctx.getVarType(nm) === Type.STRING) continue;
            if (this.ctx.boxedVars && this.ctx.boxedVars.has(nm)) continue;
            const off = this.ctx.getLocal(nm);
            if (!off) continue; // 仅简单局部(有 FP 相对偏移)
            if (this.ctx.isRawIntVar(nm)) continue; // 不与裸 int 驻留重叠
            while (reg <= 6 && used[reg]) reg = reg + 1; // 跳过外层在用寄存器
            if (reg > 6) break; // 保留 d2-d6(d7=fmod);至多 5 个累加器
            out.push({ name: nm, offset: off, reg: reg });
            used[reg] = true;
            reg = reg + 1;
        }
        return out;
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
    storeLoopBinding(varName, varOffset, pattern, patternMode, patternSrcSlot) {
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
        this.ctx.breakTryLen = this.ctx.tryFrames ? this.ctx.tryFrames.length : 0;
        this.ctx.continueTryLen = this.ctx.breakTryLen;
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

        // 计算 iterable，当前快路支持 NaN-boxed Array。
        this.compileExpression(stmt.right);
        // TypedArray(裸指针,非 0x7FFE)静态可知时先转普通数组(元素为数值),复用下面的
        // 数组快路(0x7FFE)。避免落 Symbol.iterator 协议路径(typed array 无该协议 → 空/崩)。
        if (inferType(stmt.right, this.ctx) === Type.TYPED_ARRAY) {
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_ta_to_array");
        }
        this.vm.store(VReg.FP, iterableTempOffset, VReg.RET);

        // Array JSValue tag = 0x7ffe. 非数组走 Symbol.iterator 协议路径。
        this.vm.mov(VReg.V0, VReg.RET);
        this.vm.shrImm(VReg.V0, VReg.V0, 48);
        this.vm.cmpImm(VReg.V0, 0x7ffe);
        this.vm.jne(iteratorStartLabel);

        // 保存 raw array pointer / index / length 到栈槽，避免循环体表达式复用 S 寄存器破坏状态。
        // x64 上 RET 与 V0 同为 RAX，上面的 shrImm(V0,48) 把 RET 也破坏成了 tag 值；
        // arm64 上 RET(X0)/V0(X8) 是不同寄存器互不影响。故 x64 需从已保存的 iterableTemp
        // 重载 RET 才能得到原始数组 JSValue（否则 arrTemp 得到垃圾指针、length 读为 0、
        // 循环 0 次）。用 target 守卫使 arm64 输出逐字节不变。
        if (this.vm.backend.name === "x64") {
            this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
        }
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
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot);

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
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot);
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
        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot);
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
        // buckets_ptr@40）。for-of Map 迭代 [k,v] 条目——调 `_map_entries` 得 [[k,v]...]
        // 真数组(插入序,m.entries() 同路径),脱壳存 arrTemp、idx=0,跳数组快路 loopLabel
        // 复用其 [k,v] 元素迭代 + storeLoopBinding(整体 e 或 [k,v] 解构均由循环体处理)。
        // 此前直接跳 endLabel(空迭代)。
        const notMapLabel = this.ctx.newLabel("forof_notmap");
        this.vm.load(VReg.RET, VReg.FP, iterableTempOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        this.vm.loadByte(VReg.V1, VReg.V0, 0);
        this.vm.cmpImm(VReg.V1, 4);              // TYPE_MAP
        this.vm.jne(notMapLabel);
        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset); // boxed map
        this.vm.call("_map_entries");            // RET = boxed [[k,v]...] 数组
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // 脱壳
        this.vm.store(VReg.FP, arrTempOffset, VReg.V0);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxTempOffset, VReg.V0);
        this.vm.jmp(loopLabel);
        this.vm.label(notMapLabel);

        this.vm.load(VReg.A0, VReg.FP, iterableTempOffset);
        this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
        this.vm.call("_object_get");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(endLabel);

        this.vm.mov(VReg.V6, VReg.RET);
        this.vm.load(VReg.V5, VReg.FP, iterableTempOffset);
        this.compileMethodCall(VReg.V6, VReg.V5, []);
        this.vm.store(VReg.FP, iteratorTempOffset, VReg.RET);
        // [iterator-close] 标记活迭代器:break 提前退出时对其调 return()。
        this.vm.store(VReg.FP, iterCloseOffset, VReg.RET);

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

        this.storeLoopBinding(varName, varOffset, loopPattern, loopPatternMode, loopPatternSrcSlot);

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

        this.vm.label(endLabel);

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
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

        // 分派：数组(0x7ffe)迭代索引；对象(0x7ffd)迭代自有属性键；其他跳过。
        this.vm.mov(VReg.V0, VReg.RET);
        this.vm.shrImm(VReg.V0, VReg.V0, 48);
        this.vm.cmpImm(VReg.V0, 0x7ffe);
        this.vm.jeq(arrPathLabel);
        this.vm.cmpImm(VReg.V0, 0x7ffd);
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
            this.vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION → classinfo
            this.vm.jne(endLabel);
            this.vm.jmp(objPathLabel);
        }

        // 数组：isObj=0
        this.vm.label(arrPathLabel);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, isObjOffset, VReg.V0);
        this.vm.jmp(startLabel);

        // 对象：isObj=1
        this.vm.label(objPathLabel);
        // x64:直达 0x7ffd 分派(非 classinfo 路径)到此时 RET 已被上面 tag 检测的
        // shrImm(V0,48) 破坏成裸 tag 值(V0==RET==RAX),须从暂存槽重载原始装箱对象——
        // 否则下面 store/脱壳把 tag(0x7ffd)当对象指针传给 _object_normalize_order 段错。
        // classinfo 路径已在上方 1698 重载,ptrOffset 仍holds原值,重载幂等。arm64 RET/V0
        // 异寄存器无需处理,target 守卫保持逐字节不变。
        if (this.vm.backend.name === "x64") {
            this.vm.load(VReg.RET, VReg.FP, ptrOffset);
        }
        // [enum-order] for-in 前把对象属性归一到 ES 规范序(整数键升序在前)。RET 此刻为
        // 装箱对象(或 classinfo 裸指针);存槽保活、脱壳传 A0、call 后重载(normalize 保
        // S0-S5 但破坏 RET/V/A)。classinfo(type=3)与非对象经 normalize 内 type 守卫跳过。
        this.vm.store(VReg.FP, ptrOffset, VReg.RET);
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

        // 检查 i < length/count
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

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

        this.vm.label(yieldObjLabel);
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
        const endLabel = this.ctx.newLabel("enddowhile");

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
        this._bindLabelContinue(savedLabels); // [#60]
        this.compileStatement(stmt.body);

        this.compileExpression(stmt.test);
        // do-while：见 compileIfStatement，用 _to_boolean 而非 `& 1`
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(loopLabel);

        this.vm.label(endLabel);

        // 恢复循环标签
        this.ctx.breakLabel = savedBreak;
        this.ctx.continueLabel = savedContinue;
        this.ctx.breakTryLen = savedBreakTryLen;
        this.ctx.continueTryLen = savedContinueTryLen;
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
        const saved = [];
        for (let i = 0; i < pending.length; i++) {
            const name = pending[i];
            const entry = { breakLabel, continueLabel: null, breakTryLen: btl, continueTryLen: ctl };
            saved.push({ name, old: this.ctx.labelMap.get(name), entry });
            this.ctx.labelMap.set(name, entry);
        }
        return saved;
    },

    // [#60] 编译循环体前调用:把当前 ctx.continueLabel 绑到本轮登记的标签。
    _bindLabelContinue(saved) {
        if (!saved) return;
        const cl = this.ctx.continueLabel;
        for (let i = 0; i < saved.length; i++) saved[i].entry.continueLabel = cl;
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
                this.emitPendingFinalizers(entry.breakTryLen, false);
                if (this.ctx.tryFrames && this.ctx.tryFrames.length > entry.breakTryLen) {
                    this.emitExcCtxRestore(this.ctx.tryFrames[entry.breakTryLen]);
                }
                this.vm.jmp(entry.breakLabel);
            }
            return;
        }
        if (this.ctx.breakLabel) {
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
                this.emitPendingFinalizers(entry.continueTryLen, false);
                if (this.ctx.tryFrames && this.ctx.tryFrames.length > entry.continueTryLen) {
                    this.emitExcCtxRestore(this.ctx.tryFrames[entry.continueTryLen]);
                }
                this.vm.jmp(entry.continueLabel);
            }
            return;
        }
        if (this.ctx.continueLabel) {
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

            this.vm.lea(VReg.V0, "_exception_pending");
            this.vm.movImm(VReg.V1, 0);
            this.vm.store(VReg.V0, 0, VReg.V1);

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

            // catch 体内异常：有 finally 先跑 finally 再重抛，否则直接外层
            this.ctx.exceptionLabel = hasFinalizer ? finallyExcLabel : savedExceptionLabel;
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
            this.ctx.exceptionLabel = savedExceptionLabel;
            this.emitDirectFinalizer(stmt.finalizer);
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

    // 实例字段 + 私有字段初始化(基类:构造体前;派生类:super() 后)。this 从 __this
    // 局部重载(字段初值可为破坏 A0/栈的复杂表达式),与原内联实现逐指令一致。
    emitCtorFieldInits(instanceFields, privateFields, className, thisOffset) {
        for (const field of instanceFields) {
            // 计算键 `[k]`(k 为标识符/表达式,非字符串/数字字面量):须运行时求键。
            // 字面量计算键 `["x"]` 的 key.value 已是名字,走下方静态路径。
            const cfRuntimeKey = field.computed && field.key &&
                field.key.type !== "Literal" && field.key.type !== "StringLiteral" && field.key.type !== "NumericLiteral";
            const fieldName = cfRuntimeKey ? null : (field.key && (field.key.name || field.key.value));
            if (cfRuntimeKey || fieldName == null) {
                // 计算键字段 `[k] = v`(变量键,非字面量):运行时求键 → _valueToStr → 定义。
                // 键先算(_valueToStr 会毁寄存器)存临时槽,再算值,最后 _object_define。
                if (cfRuntimeKey && field.value) {
                    this.compileExpression(field.key);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_valueToStr");   // RET = 键字符串(content ptr,同静态键形态)
                    const kt = this.ctx.allocLocal(`__cfk_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, kt, VReg.RET);
                    this.compileExpression(field.value);
                    this.vm.mov(VReg.V1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, thisOffset);
                    this.vm.load(VReg.A1, VReg.FP, kt);
                    this.vm.mov(VReg.A2, VReg.V1);
                    this.vm.call("_object_define");
                }
                continue;
            }
            if (field.value) {
                // 编译字段初始值（可能是 new Map() 等复杂表达式，会破坏 A0 和栈平衡，
                // 故绝不能靠 push/pop A0 保 this——从 __this 局部重新加载，与私有字段一致）
                this.compileExpression(field.value);
                this.vm.mov(VReg.V1, VReg.RET);
                // 设置字段: this[fieldName] = value
                this.vm.load(VReg.A0, VReg.FP, thisOffset);
                this.vm.lea(VReg.A1, this.addStringConstant(fieldName));
                // [A3.5-fix] 键装箱(0x7FFC 驻留)——实例字段键同原型方法键一并转正
                this.vm.call("_tag_str_a1");
                this.vm.mov(VReg.A2, VReg.V1);
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
            }
        }
    },

    // 编译类声明
    // JavaScript 类在运行时主要是：
    // 1. 一个构造函数
    // 2. prototype 对象上的方法
    // 3. 静态方法和字段
    compileClassDeclaration(stmt) {
        const className = stmt.id.name;
        const superClass = stmt.superClass;
        const labelId = this.nextLabelId();
        // [classinfo 唯一化] 顶层类:getFunctionSymbol 返回稳定唯一符号(模块内类名唯一),
        // 沿用 `_classinfo_<sym>`。嵌套/局部类(函数或块内 `class X{}`)不入 functions 表 →
        // getFunctionSymbol 返回 undefined,旧实现回退裸名 `_classinfo_X` → 不同作用域同名类
        // **共享同一全局槽**,super/静态解析跨污染(runtime 后声明者覆写)。此处按 labelId
        // 赋每个嵌套声明**唯一**槽,并记入 _nestedClassInfoLabels 供本作用域内引用(super/
        // 方法体,均内联在本 compileClassDeclaration 期间编译)解析到正确声明。
        const classInfoLabel = this._classInfoLabelForDecl(className, labelId);

        // 表达式父类 `extends (expr)`(非裸标识符):父类无编译期名字。其 classinfo 指针在
        // 类声明处求值一次并存入本声明专属全局 superInfoLabel;super()/super.m()/super.prop
        // 运行时从该全局解析父类(emitLoadSuperClassInfo)。标识符父类 superIsExpr=false →
        // 全程走名字快路径,与旧实现逐字节一致。
        const superIsExpr = !!(superClass && superClass.type !== "Identifier");
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

        // 跳过类代码区域
        this.vm.jmp(constructorEndLabel);

        // ========== 生成构造函数 ==========
        this.vm.label(constructorLabel);
        this.vm.beginRecord(); // [P1]
        this.vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        const savedCtx = this.ctx;
        // [label collision] 用 className 作 ctx 名 → labelPrefix=`${className}_`;两个
        // 不同模块的同名类(如 net 与 http 各有 `class Server`)会生成相同的构造器体
        // 局部标签(`Server_endif_2` 等),asm.label() 静默覆盖 → 跨类跳转/崩溃。类声明
        // 唯一的 labelId 掺入 ctx 名使 labelPrefix 唯一(仅改标签名、不改机器码,无冲突时
        // 逐字节等价;函数体走 compileFunction 已用模块符号名故本就唯一)。
        this.ctx = this.ctx.clone(className + "." + labelId);
        this.ctx.locals = {};
        this.ctx.localOffset = 0;
        this.ctx.inClass = true;
        this.ctx.className = className;
        // 标识符父类:superClass=父名(名字快路径)。表达式父类:无名字,置本类名(仅使
        // super.prop 的真值守卫通过);实际父类经 superClassExpr/superInfoLabel 从全局解析。
        this.ctx.superClass = superClass ? (superIsExpr ? className : superClass.name) : null;
        this.ctx.superClassExpr = superIsExpr;
        this.ctx.superInfoLabel = superInfoLabel;
        this.ctx.returnLabel = `_class_${className}_${labelId}_return`;

        // 保存 this (A0) 到 __this
        const thisOffset = this.ctx.allocLocal("__this");
        this.vm.store(VReg.FP, thisOffset, VReg.A0);

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
                if (this._isPatternParam(param)) {
                    // [#47] 解构参数 constructor({a,b}){}：实参落临时槽,解构延后。
                    const pat = param.type === "AssignmentPattern" ? param.left : param;
                    const dexpr = param.type === "AssignmentPattern" ? param.right : null;
                    const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                    if (i + 1 <= 5) this.vm.store(VReg.FP, pslot, this.vm.getArgReg(i + 1));
                    ctorPatternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                    continue;
                }
                const paramName = param.name || (param.left && param.left.name);
                if (paramName) {
                    const paramOffset = this.ctx.allocLocal(paramName);
                    // 构造函数约定: A0 = this, 参数依次在 A1-A5
                    if (i + 1 <= 5) {
                        this.vm.store(VReg.FP, paramOffset, this.vm.getArgReg(i + 1));
                    }
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
                    this.compileExpression(defaultExpr);
                    this.vm.store(VReg.FP, paramOffset, VReg.RET);
                    this.vm.label(skip);
                }
            }
        }

        // 字段初始化时机(ES 语义):基类(无 super)在构造体执行前初始化;派生类(有 super)
        // 须在 super() 返回后初始化——子类字段初始化器可读父构造器所设 this 状态
        // (`class C extends A{ b = this.a+9 }`,this.a 由 super() 设)。故派生类此处不发,
        // 由下方构造体循环在 super() 语句后注入(emitCtorFieldInits)。
        if (!superClass) {
            this.emitCtorFieldInits(instanceFields, privateFields, className, thisOffset);
        }

        // 编译构造函数体（参数已在字段初始化前落栈并处理默认值）
        if (constructor && constructor.value) {
            if (constructor.value.body && constructor.value.body.body) {
                let fieldsEmittedAfterSuper = false;
                for (const bodyStmt of constructor.value.body.body) {
                    this.compileStatement(bodyStmt);
                    // 派生类:super() 语句刚编完 → 立即注入字段初始化(node 时序)。
                    if (superClass && !fieldsEmittedAfterSuper && this._isSuperCallStmt(bodyStmt)) {
                        this.emitCtorFieldInits(instanceFields, privateFields, className, thisOffset);
                        fieldsEmittedAfterSuper = true;
                    }
                }
                // 防御:派生类构造体未见顶层 super() 语句(非常规写法)→ 体末补发,
                // 保证字段仍被初始化(时序略偏但不丢失)。
                if (superClass && !fieldsEmittedAfterSuper) {
                    this.emitCtorFieldInits(instanceFields, privateFields, className, thisOffset);
                }
            }
        }

        // 返回 this
        this.vm.label(this.ctx.returnLabel);
        this.vm.load(VReg.RET, VReg.FP, thisOffset);
        this.vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
        this.vm.endRecord(); // [P1]

        // ========== 生成实例方法 ==========
        for (const method of instanceMethods) {
            this.compileClassMethod(className, method, labelId, false);
        }

        // ========== 生成静态方法 ==========
        for (const method of staticMethods) {
            this.compileClassMethod(className, method, labelId, true);
        }

        // 恢复上下文
        this.ctx = savedCtx;

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
        // __proto__ = null (alloc 复用内存不清零，必须显式初始化)
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.S0, 16, VReg.V0);
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

        // extends：链接原型链——本 prototype 的 __proto__(@16) 指向父类 prototype 对象。
        // 此前恒置 null，子类实例调用继承自父类的方法时 _object_get 走到 __proto__=null
        // 找不到方法 → 崩溃（如 ARM64Backend extends Backend 调 backend.label()）。
        if (superClass) {
            if (superIsExpr) {
                // 表达式父类:求值一次 → 去 tag 得 raw classinfo → 存 superInfoLabel 全局
                // 供 super() 运行时读。S0(classinfo)/S2(props)/S1(proto)在求值中可能被
                // compileExpression 破坏,三者全保护(区别于标识符路径 lea+load 无破坏,仅护 S1)。
                this.vm.push(VReg.S0);
                this.vm.push(VReg.S1);
                this.vm.push(VReg.S2);
                this.compileExpression(superClass); // RET = 装箱父类信息
                this.vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
                this.vm.and(VReg.V2, VReg.RET, VReg.V1); // V2 = raw 父 classinfo
                this.vm.lea(VReg.V1, superInfoLabel);
                this.vm.store(VReg.V1, 0, VReg.V2); // 全局槽 = 父 classinfo
                this.vm.pop(VReg.S2);
                this.vm.pop(VReg.S1);
                this.vm.pop(VReg.S0);
            } else {
                this.vm.push(VReg.S1); // 保护本 prototype 对象指针
                this.emitLoadClassInfo(superClass.name, VReg.V2); // V2 = 父类信息对象(raw)
                this.vm.pop(VReg.S1);
            }
            // 父类信息可能为 0（前向引用/导入模块尚未初始化）——须先判空再解引用，
            // 否则 load [0+48] 在运行时 SIGSEGV（会拖垮 gen1 自身 init）。
            const skipProtoLink = this.ctx.newLabel("skip_proto_link");
            this.vm.cmpImm(VReg.V2, 0);
            this.vm.jeq(skipProtoLink);
            // [静态继承] 本 classinfo.__proto__(@16) = 父 classinfo(raw)。使
            // `B.staticF()`/`B.staticProp` 经 _object_get 走 classinfo 原型链命中父类静态成员,
            // 且 Object.getPrototypeOf(B) === A(node:子类构造器 __proto__ = 父构造器)。
            // V2 此处仍是父 classinfo,须在下方 props_ptr 覆写 V2 前先存。
            this.vm.store(VReg.S0, 16, VReg.V2); // classinfo.__proto__ = 父 classinfo
            this.vm.load(VReg.V2, VReg.V2, 32); // V2 = 父类信息 props_ptr
            this.vm.load(VReg.V2, VReg.V2, 24); // V2 = 父 prototype 对象(raw) = props[1].val
            this.vm.store(VReg.S1, 16, VReg.V2); // 本 prototype.__proto__ = 父 prototype
            this.vm.label(skipProtoLink);
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

        // 初始化静态字段
        for (const field of staticFields) {
            const sfRuntimeKey = field.computed && field.key &&
                field.key.type !== "Literal" && field.key.type !== "StringLiteral" && field.key.type !== "NumericLiteral";
            let fieldName = sfRuntimeKey ? null : (field.key && (field.key.name || field.key.value));
            if (sfRuntimeKey || fieldName == null) {
                // 计算键静态字段 `static [k] = v`:运行时求键 → 定义到类对象 S0。
                // symbol 键(含 well-known `[Symbol.toStringTag]=v`)走 _js_prop_key(与下标读
                // 路径一致);非 symbol 键仍 _valueToStr(字符串/数值)。
                if (sfRuntimeKey && field.value) {
                    this.vm.push(VReg.S0);
                    this.compileExpression(field.key);
                    const kraw = this.ctx.allocLocal(`__csfkr_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, kraw, VReg.RET);
                    const sfSym = this.ctx.newLabel("sf_symkey");
                    const sfKd = this.ctx.newLabel("sf_keydone");
                    this.vm.load(VReg.A0, VReg.FP, kraw);
                    this.vm.call("_is_symbol");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jne(sfSym);
                    this.vm.load(VReg.A0, VReg.FP, kraw);
                    this.vm.call("_valueToStr");
                    this.vm.jmp(sfKd);
                    this.vm.label(sfSym);
                    this.vm.load(VReg.A0, VReg.FP, kraw);
                    this.vm.call("_js_prop_key");
                    this.vm.label(sfKd);
                    const skt = this.ctx.allocLocal(`__csfk_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, skt, VReg.RET);
                    this.compileExpression(field.value);
                    this.vm.mov(VReg.V1, VReg.RET);
                    this.vm.pop(VReg.S0);
                    this.vm.mov(VReg.A0, VReg.S0);
                    this.vm.load(VReg.A1, VReg.FP, skt);
                    this.vm.mov(VReg.A2, VReg.V1);
                    this.vm.call("_object_define");
                }
                continue;
            }
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
            }
        }

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
            for (const block of staticBlocks) {
                this.vm.load(VReg.V0, VReg.FP, classOffset); // 类对象(块内可能重求值,每块重载)
                this.vm.store(VReg.FP, thisOff, VReg.V0);     // __this = 类对象
                for (const s of block.body) this.compileStatement(s);
            }
            if (savedThisTmpOff !== null) {
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

    emitClassMethodTable(methods, className, labelId, isStatic, targetReg) {
        const prefix = isStatic ? "static_" : "";
        // 归组（Map 归组，禁止裸 {} 字典判真——node 原型链污染，见 [#32]）
        const accessorGroups = new Map();
        for (const method of methods) {
            if (method.kind !== "get" && method.kind !== "set") continue;
            const mn = method.key && (method.key.name || method.key.value);
            if (!mn) continue;
            // 计算键访问器 `get [k]()`(k 为标识符)与同名静态访问器 `get k()` 归组分隔:
            // 前者键为运行时值,不可与静态字符串键合并。非计算键分组键 === mn(自举字节不变)。
            const grpKey = (method.computed ? "@c@" : "") + mn;
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
            let methodName = method.key && (method.key.name || method.key.value);
            let wkName = null;
            if (!methodName) {
                wkName = this._wellKnownSymbolMethodName(method); // [Symbol.X](){}
                if (!wkName) continue; // 其余计算键仍跳过
                methodName = wkName;   // 方法体 label 用同名(与 compileClassMethod 一致)
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
                continue;
            }
            // 私有方法/访问器：label 保留原名（label 只是内部 Map 键，# 反而保证
            // 不与合法标识符方法名相撞）；prototype/类对象上的属性键按私有改写
            // "#ClassName#m"，与访问端 manglePrivateName 一致。
            const defineKey = method.key.type === "PrivateIdentifier"
                ? "#" + className + methodName
                : methodName;

            if (method.kind === "get" || method.kind === "set") {
                const isComputedAccessor = method.computed && method.key &&
                    method.key.type === "Identifier";
                const grpKey = (isComputedAccessor ? "@c@" : "") + methodName;
                const group = accessorGroups.get(grpKey);
                if (!group || group.emitted) continue; // 同名第二个访问器已合并
                group.emitted = true;
                // 计算键访问器 `get [k]()`:先求键值→_valueToStr,暂存 FP 槽(marker 构造在
                // _alloc/store 间无调用,V2 存活;pop/load 不毁 V2)。非计算键走静态字符串键。
                let ckSlot = null;
                if (isComputedAccessor) {
                    this.vm.push(targetReg);
                    this.compileExpression(method.key);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_valueToStr");
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
                this.vm.call("_valueToStr");
                const kt = this.ctx.allocLocal(`__cmk_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, kt, VReg.RET);
                this.vm.pop(VReg.A0);                     // targetReg 值
                this.vm.load(VReg.A1, VReg.FP, kt);       // 运行时键字符串
                this.vm.lea(VReg.A2, methodLabel);
                this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
                this.vm.or(VReg.A2, VReg.A2, VReg.V0);
                this.vm.call("_object_define");
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
        }
    },

    // 编译类方法
    compileClassMethod(className, method, labelId, isStatic) {
        let methodName = method.key && (method.key.name || method.key.value);
        if (!methodName) {
            methodName = this._wellKnownSymbolMethodName(method); // [Symbol.X](){}
            if (!methodName) return; // 其余计算键仍跳过
        }
        const prefix = isStatic ? "static_" : "";
        const kindPrefix = method.kind === "get" ? "get_" : (method.kind === "set" ? "set_" : "");
        const methodLabel = `_class_${className}_${prefix}${kindPrefix}${methodName}_${labelId}`;
        const returnLabel = `${methodLabel}_return`;

        this.vm.label(methodLabel);
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
        if (isAsyncMethod) {
            this.emitAsyncMethodStub(methodLabel + "_abody", false);
        } else if (isAsyncGenMethod) {
            this.emitAsyncGeneratorStub(methodLabel + "_gbody", false);
        } else if (isGenMethod) {
            this.emitGeneratorStub(methodLabel + "_gbody", false);
        }
        // [P1] async 方法禁录(S4 跨协程共享,同 closures.js 注);生成器体同跑协程栈,同理禁录
        if (!(method.value && method.value.isAsync) && !isGenMethod) this.vm.beginRecord();
        this.vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        const savedCtx = this.ctx;
        // [label collision] 掺入类声明唯一 labelId:两个模块同名类的同名方法
        // (`Server.who`)否则生成相同的方法体局部标签而互相覆盖(见 compileClassDeclaration)。
        this.ctx = this.ctx.clone(`${className}.${methodName}.${labelId}`);
        this.ctx.locals = {};
        this.ctx.localOffset = 0;
        // 方法体自己的 box-on-capture 分析:被嵌套闭包捕获(且写)的 `let`/`const`
        // 标量须落 box,否则兄弟闭包与方法体各持一份副本、写不回传(class 方法此前
        // 漏做此分析——只继承外层 ctx.boxedVars,不含方法自身局部)。**合并**而非覆写:
        // 保留外层(模块/全局)已 box 的名字(方法体引用它们时需知其为 box 才发 deref,
        // 丢弃会退化成普通槽读到垃圾),再并入方法自身的共享局部。新建 Set 避免改动
        // savedCtx 共享的集合。
        const methodBoxedVars = analyzeSharedVariables(method.value);
        for (const _n of analyzeDirectEvalBoxedVars(method.value)) methodBoxedVars.add(_n);
        if (this.ctx.boxedVars) {
            for (const _n of this.ctx.boxedVars) methodBoxedVars.add(_n);
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
        }

        // 保存 this (A0)
        // 注意：JS 方法调用约定中，this 通过 A5 传递（而不是 A0）
        // 这是 asm.js 的特殊约定，用于区分方法调用和普通函数调用
        const thisOffset = this.ctx.allocLocal("__this");
        this.vm.mov(VReg.V0, VReg.A5); // 从 A5 获取 this
        this.vm.store(VReg.FP, thisOffset, VReg.V0);

        // 处理参数
        const params = method.value.params || [];
        const patternParams = [];
        const methodParamOffsets = []; // 标识符参数 {name,offset},供 box-on-capture
        for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (param.type === "SpreadElement" && param.argument && param.argument.type === "Identifier") {
                // 剩余参数 ...rest（方法：A_pos..A4，A5=this）
                this.emitRestParam(param.argument.name, i);
                continue;
            }
            if (this._isPatternParam(param)) {
                // [#47] 解构参数 method({a,b}){}：实参落临时槽,解构延后(防 A 寄存器互踩)。
                const pat = param.type === "AssignmentPattern" ? param.left : param;
                const dexpr = param.type === "AssignmentPattern" ? param.right : null;
                const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                if (i < 5) this.vm.store(VReg.FP, pslot, this.vm.getArgReg(i));
                patternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                continue;
            }
            const paramName = param.name || (param.left && param.left.name);
            const defaultExpr = (param.type === "AssignmentPattern") ? param.right : null;
            if (paramName) {
                const paramOffset = this.ctx.allocLocal(paramName);
                methodParamOffsets.push({ name: paramName, offset: paramOffset });
                // 方法调用约定: 参数在 A0-A4，this 在 A5 (见 compileMethodCall)
                if (i < 5) {
                    this.vm.store(VReg.FP, paramOffset, this.vm.getArgReg(i));
                }
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
                    this.compileExpression(defaultExpr);
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
        for (let i = 0; i < patternParams.length; i++) {
            this.emitParamDestructure(patternParams[i].pat, patternParams[i].slot, patternParams[i].dflt);
        }

        // 编译方法体
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

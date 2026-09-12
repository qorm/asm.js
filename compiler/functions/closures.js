// asm.js 编译器 - 闭包编译
// 编译函数表达式、闭包、函数体

import { VReg } from "../../vm/registers.js";
import { analyzeCapturedVariables, analyzeSharedVariables, analyzeDirectEvalBoxedVars, collectLocalDeclarations, collectDirectFunctionDeclNames, collectVarDeclarations, collectLexicalDeclarations, collectLetConstClassNames, collectParamEvalVarNames, collectBodyEvalVarNames, collectPatternNames, outerLocalsGet } from "../../lang/analysis/closure.js";
import { analyzeRawFloatVars } from "../../lang/analysis/rawfloat.js";
import { ASYNC_CLOSURE_MAGIC, isAsyncFunction, isGeneratorFunction } from "../async/index.js";

// 闭包魔数 - 用于区分普通函数指针和闭包对象
const CLOSURE_MAGIC = 0xc105;

// [L2-②] 未初始化绑定哨兵 —— 与 compiler/index.js 的 UNINITIALIZED_BINDING_SENTINEL、
// compiler/functions/statements.js 的 TDZ_SENTINEL 三处必须逐位一致(emitUninitializedBindingGuard
// 比对它;前向引用共享局部预建的 box 初值也用它,使声明前经闭包读到 box 时报 TDZ 而非垃圾)。
const TDZ_SENTINEL = 0x7ff70000deadbeefn;

// 闭包编译方法混入
export const ClosureCompiler = {
    // 形参默认值求值前,把模块顶层共享 box 预装入当前帧局部槽。
    emitSeedMainCapturedVars() {
        const mcv = this.ctx.mainCapturedVars;
        if (!mcv) return;
        const vm = this.vm;
        if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
        for (const mn in mcv) {
            if (typeof mcv[mn] !== "string") continue;
            if (this.ctx.paramEvalVarNames && this.ctx.paramEvalVarNames.has(mn)) continue;
            if (this.ctx.getLocal(mn)) continue;
            const off = this.ctx.allocLocal(mn);
            vm.lea(VReg.V1, mcv[mn]);
            vm.load(VReg.V1, VReg.V1, 0);
            vm.store(VReg.FP, off, VReg.V1);
            this.ctx.boxedVars.add(mn);
        }
    },

    // hasParameterExpressions:默认值闭包已捕获外层同名 box;体 varEnv 须新建槽,
    // 否则 emitHoistedVarInits / var 声明复用 seed 槽,写穿外层(paramsbody-var-open)。
    unbindBodyBindingsAfterParamInit(body, params) {
        if (!body || !this._paramsHaveExpressions || !this._paramsHaveExpressions(params)) return;
        const bodyBinds = {};
        collectLocalDeclarations(body, bodyBinds);
        collectDirectFunctionDeclNames(body, bodyBinds);
        const paramNames = {};
        const list = params || [];
        for (let i = 0; i < list.length; i++) {
            if (list[i]) collectPatternNames(list[i], paramNames);
        }
        for (const nm in bodyBinds) {
            if (bodyBinds[nm] !== true) continue;
            if (paramNames[nm] === true) continue;
            if (!this.ctx.getLocal(nm)) continue;
            this.ctx.locals.delete(nm);
        }
        this.ctx._paramSplitBodyVarEnv = true;
    },

    markParamEvalVarBoxes() {
        if (!this.ctx.paramEvalVarNames) return;
        if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
        for (const nm of this.ctx.paramEvalVarNames) this.ctx.boxedVars.add(nm);
    },

    maybeEmitParamEvalVarSlots(skipWhenFdiTransfer) {
        this.setupParamEvalVarNames(this._pendingParamEvalParams || []);
        if (!this.ctx.paramEvalVarNames) return;
        this.markParamEvalVarBoxes();
        if (!skipWhenFdiTransfer) {
            // Slot materialisation calls _alloc before formal parameters have
            // been copied out of A0-A4. Preserve the incoming argument window;
            // otherwise a function with parameter-eval vars observes the last
            // allocator argument/result instead of undefined/its real actuals,
            // and may skip every default expression.
            const snaps = [];
            for (let i = 0; i < 5; i++) {
                const off = this.ctx.allocLocal(`__pev_argsnap_${this.nextLabelId()}_${i}`);
                this.vm.store(VReg.FP, off, this.vm.getArgReg(i));
                snaps.push(off);
            }
            this.emitParamEvalVarSlots();
            for (let i = 0; i < 5; i++) {
                this.vm.load(this.vm.getArgReg(i), VReg.FP, snaps[i]);
            }
        }
    },

    // 形参默认值 eval('var x') 须在独立 param 环境建 var;闭包共享 box,eval 后更新。
    emitParamEvalVarSlots() {
        const names = this.ctx.paramEvalVarNames;
        if (!names || names.size === 0) return;
        const vm = this.vm;
        const undef = 0x7ffb000000000000n;
        if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
        for (const name of names) {
            if (this.ctx.getLocal(name)) continue;
            const off = this.ctx.allocLocal(name);
            vm.movImm(VReg.A0, 8);
            vm.call("_alloc");
            vm.mov(VReg.A0, VReg.RET); // x64 V0≡RET: keep the box off V0
            const mcv = this.ctx.getMainCapturedVar && this.ctx.getMainCapturedVar(name);
            if (mcv) {
                vm.lea(VReg.V1, mcv);
                vm.load(VReg.V1, VReg.V1, 0);
                vm.load(VReg.V1, VReg.V1, 0);
            } else {
                vm.movImm64(VReg.V1, undef);
            }
            vm.store(VReg.A0, 0, VReg.V1);
            vm.store(VReg.FP, off, VReg.A0);
            this.ctx.boxedVars.add(name);
        }
    },

    setupParamEvalVarNames(params) {
        const obj = collectParamEvalVarNames(params);
        let any = false;
        for (const k in obj) { any = true; break; }
        this.ctx.paramEvalVarNames = any ? new Set(Object.keys(obj)) : null;
        return any;
    },

    // EvalDeclarationInstantiation for a direct eval that runs while default
    // parameters are being initialised: var declarations may not collide with
    // any parameter binding in the separate parameter lexical environment.
    // Literal eval source is known at compile time, so emit the required
    // call-time SyntaxError at the default-expression branch itself. Dynamic
    // source retains the normal runtime eval path.
    emitParamEvalConflictSyntaxError(defaultExpr) {
        if (!defaultExpr) return false;
        const fake = {
            type: "AssignmentPattern",
            left: { type: "Identifier", name: "__param_eval_probe" },
            right: defaultExpr,
        };
        const evalVars = collectParamEvalVarNames([fake]);
        if (this.ctx.paramLexNames) {
            for (const name of this.ctx.paramLexNames) {
                if (evalVars[name] === true) {
                    this.emitThrowSyntaxError("Identifier '" + name + "' has already been declared");
                    return true;
                }
            }
        }
        // EvalDeclarationInstantiation: sloppy direct eval in a default
        // initializer walks lexEnv (parameter env, which holds the
        // arguments object) toward varEnv. `var arguments` hits that
        // binding → SyntaxError. Skipping it lets `var arguments = 'param'`
        // overwrite the arguments object and SIGSEGV.
        if (!this.ctx.inStrictFunction && !this.ctx._isArrowFunction &&
            evalVars["arguments"] === true) {
            this.emitThrowSyntaxError("Identifier 'arguments' has already been declared");
            return true;
        }
        return false;
    },

    // 函数体 eval('var x') 与捕获同名:独立 var 槽(undefined),复合赋值 LHS 仍走 __cap_x。
    emitBodyEvalVarSlots() {
        const names = this.ctx.bodyEvalVarNames;
        if (!names || names.size === 0) return;
        const vm = this.vm;
        const undef = 0x7ffb000000000000n;
        if (!this.ctx.boxedVars) this.ctx.boxedVars = new Set();
        for (const name of names) {
            if (this.ctx.getLocal(name)) continue;
            const off = this.ctx.allocLocal(name);
            vm.movImm(VReg.A0, 8);
            vm.call("_alloc");
            // x64 V0≡RET: movImm64(V0, undef) then store(RET,0,V0) writes
            // to 0x7FFB (JS_UNDEFINED) and SIGSEGVs (eval('var x') body slots).
            vm.movImm64(VReg.V1, undef);
            vm.store(VReg.RET, 0, VReg.V1);
            vm.store(VReg.FP, off, VReg.RET);
            this.ctx.boxedVars.add(name);
        }
    },

    buildParamEvalDirectLayout() {
        const parts = [];
        const pushSlot = (key, off, boxed) => {
            parts.push(key + ":" + off + (boxed ? ":b" : ""));
        };
        const pbn = this.ctx.paramBindingNames;
        if (pbn) {
            for (const nm in pbn) {
                if (pbn[nm] !== true) continue;
                const off = this.ctx.getLocal(nm);
                if (!off) continue;
                const boxed = this.ctx.boxedVars && this.ctx.boxedVars.has(nm);
                pushSlot(nm, off, boxed);
            }
        }
        if (this.ctx.paramEvalVarNames) {
            for (const nm of this.ctx.paramEvalVarNames) {
                const off = this.ctx.getLocal(nm);
                if (off) pushSlot(nm, off, true);
            }
        }
        const mcv = this.ctx.mainCapturedVars;
        if (mcv) {
            for (const mn in mcv) {
                if (typeof mcv[mn] !== "string") continue;
                if (this.ctx.paramEvalVarNames && this.ctx.paramEvalVarNames.has(mn)) continue;
                const off = this.ctx.getLocal(mn);
                if (off) pushSlot(mn, off, true);
            }
        }
        if (this.ctx.paramLexNames) {
            for (const pn of this.ctx.paramLexNames) {
                parts.push("!lex:" + pn);
            }
        }
        return parts.join(",");
    },

    // [L1 var hoist] 进入 VariableEnvironment 时把所有 var 绑定写成 undefined。
    // body: BlockStatement / 表达式体 / Program body 数组之父节点均可。
    // 跳过已有槽的参数/捕获(保留其值);boxed 则预建 box(值=undefined)。
    emitHoistedVarInits(body) {
        if (!body) return;
        const vm = this.vm;
        const vars = {};
        collectVarDeclarations(body, vars);
        if (!this.ctx.preboxedVars) this.ctx.preboxedVars = new Set();
        const undef = 0x7ffb000000000000n; // JS_UNDEFINED
        for (const name in vars) {
            if (vars[name] !== true) continue; // 旗标字典:=== true 避开原型链
            if (name === "__this" || name === "arguments") continue;
            let off = this.ctx.getLocal(name);
            const already = !!off;
            // 参数/捕获已有槽:不覆盖(参数已绑定实参;捕获 box 已就位)。
            // static {}:每块是独立 VariableEnvironment。外层同名 var 已有槽时
            // compileClassDeclaration 先 allocLocal 遮蔽,本函数必须初始化新槽。
            // 跳过的话 compileVariableDeclaration 见 preboxedVars(按名)把未初始化
            // 槽当 box 指针 store → TEXT SIGBUS(static-init-scope-var-open/close)。
            if (already && !this.ctx._staticBlockVarEnv) continue;
            if (!already) off = this.ctx.allocLocal(name);
            const needsBox = this.ctx.boxedVars && this.ctx.boxedVars.has(name);
            if (needsBox) {
                // [L1 box 统一] 模块顶层共享变量的全局 box 由 _main 序言预建(初值=TDZ
                // 哨兵)。顶层 var 提升必须复用同一 box(var 语义:初值置 undefined),
                // 不能另 _box_alloc:否则早建闭包(声明语句之前捕获)拿到这个新 box,
                // 而声明初始化走 compileVariableDeclaration 的 globalLabel 分支复用
                // 全局 box → 双 box 分叉,闭包永远读陈旧值("var f=()=>x; var x=…"
                // 族:closure 读 undefined / 计数不更新)。仅模块顶层(funcName 形如
                // module_N)复用;函数体内同名局部遮蔽时无此语义,仍自建 box。
                // static {} 遮蔽槽必须 _box_alloc,不得复用外层 mainCaptured box。
                const gl = (!this.ctx._staticBlockVarEnv &&
                    this.ctx.shouldReuseMainCapturedBox && this.ctx.shouldReuseMainCapturedBox())
                    ? this.ctx.getMainCapturedVar(name) : null;
                if (gl) {
                    vm.lea(VReg.V1, gl);
                    vm.load(VReg.RET, VReg.V1, 0); // RET = _main 预建的全局 box
                } else {
                    vm.call("_box_alloc");
                }
                vm.movImm64(VReg.V1, undef);
                vm.store(VReg.RET, 0, VReg.V1);
                vm.store(VReg.FP, off, VReg.RET);
                this.ctx.preboxedVars.add(name);
            } else {
                vm.movImm64(VReg.V1, undef);
                vm.store(VReg.FP, off, VReg.V1);
            }
        }
    },

    // 剩余参数 ...rest：A_pos..A4 + _argvSpill[5..] 收到 argc 为止。
    // A5 为 this,不收。长度由实际 argc 决定,不得在 JS_UNDEFINED 处截断:
    // 中间的空洞/`undefined` 是数据(`f(1, undefined, 2)` / `f.apply(null,[1,,2])`)。
    emitRestParam(restName, pos) {
        const vm = this.vm;
        const restOff = this.ctx.allocLocal(restName);
        const argcOff = this.ctx.allocLocal(`__rest_argc_${pos}`);
        vm.lea(VReg.V5, "_call_argc");
        vm.load(VReg.V6, VReg.V5, 0);
        vm.store(VReg.FP, argcOff, VReg.V6);
        const saved = [];
        // Incoming A0–A4 may already have been smashed by
        // emitArgvSpillSnapshot / eval-slot _alloc / earlier param
        // binding. Same rule as emitArgToSlot: read the entry snapshot.
        // V6 (x64 R11) is not an arg register.
        for (let k = pos; k <= 4; k++) {
            const so = this.ctx.allocLocal(`__rest_a_${pos}_${k}`);
            this._loadIncomingArg(k, VReg.V6);
            vm.store(VReg.FP, so, VReg.V6);
            saved.push({ off: so, argIndex: k });
        }
        const spill = this.ctx._argvSpill;
        if (spill) {
            for (let k = 5; k < 16; k++) {
                if (spill[k] === undefined) break;
                if (k < pos) continue;
                saved.push({ off: spill[k], argIndex: k });
            }
        }
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r"); // box->helper
        vm.store(VReg.FP, restOff, VReg.RET);
        const done = this.ctx.newLabel("rest_done");
        for (let k = 0; k < saved.length; k++) {
            vm.load(VReg.V0, VReg.FP, argcOff);
            vm.cmpImm(VReg.V0, saved[k].argIndex);
            vm.jle(done);
            vm.load(VReg.V5, VReg.FP, saved[k].off);
            vm.load(VReg.A0, VReg.FP, restOff);
            vm.mov(VReg.A1, VReg.V5);
            vm.call("_array_push");
            vm.store(VReg.FP, restOff, VReg.RET);
        }
        vm.label(done);
    },

    // 类构造器 rest:...params。约定 A0=this、实参 A1..A5(与方法 emitRestParam 的
    // A0..A4 错位)。pos = rest 在形参表中的 0-based 下标 → 从 getArgReg(pos+1) 起收。
    emitCtorRestParam(restName, pos) {
        const vm = this.vm;
        const restOff = this.ctx.allocLocal(restName);
        const argcOff = this.ctx.allocLocal(`__ctor_rest_argc_${pos}`);
        if (this.ctx.ctorArgcOff != null) {
            vm.load(VReg.V0, VReg.FP, this.ctx.ctorArgcOff);
        } else {
            vm.lea(VReg.V0, "_call_argc");
            vm.load(VReg.V0, VReg.V0, 0);
        }
        vm.store(VReg.FP, argcOff, VReg.V0);
        const saved = [];
        // 形参 i 对应实参寄存器 A(i+1);最多收到 A5。
        // Snapshot, not live A-regs: same class as emitRestParam.
        for (let k = pos + 1; k <= 5; k++) {
            const so = this.ctx.allocLocal(`__ctor_rest_a_${pos}_${k}`);
            this._loadIncomingArg(k, VReg.V6);
            vm.store(VReg.FP, so, VReg.V6);
            saved.push({ off: so, argIndex: k - 1 });
        }
        const spill = this.ctx._argvSpill;
        if (spill) {
            for (let k = 5; k < 16; k++) {
                if (spill[k] === undefined) break;
                if (k < pos + 1) continue;
                saved.push({ off: spill[k], argIndex: k });
            }
        }
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.FP, restOff, VReg.RET);
        const done = this.ctx.newLabel("ctor_rest_done");
        for (let k = 0; k < saved.length; k++) {
            // Rest length is governed by the captured actual argc, not by an
            // undefined sentinel: explicit undefined in the middle is data and
            // must not truncate constructor(...args) forwarding.
            vm.load(VReg.V0, VReg.FP, argcOff);
            vm.cmpImm(VReg.V0, saved[k].argIndex);
            vm.jle(done);
            vm.load(VReg.V0, VReg.FP, saved[k].off);
            vm.load(VReg.A0, VReg.FP, restOff);
            vm.mov(VReg.A1, VReg.V0);
            vm.call("_array_push");
            vm.store(VReg.FP, restOff, VReg.RET);
        }
        vm.label(done);
    },

    // 类构造器入口的 arguments 对象:构造器约定 A0=this、实参 A1..A5(与方法/函数的
    // A0..A4 相反),故不能复用 emitArgumentsArray。语义其余部分一致:先读 _call_argc、
    // 实参落槽、再建数组并标 ARR_IS_ARGUMENTS。
    emitCtorArgumentsArray() {
        const vm = this.vm;
        const argOff = this.ctx.allocLocal("arguments");
        const argcOff = this.ctx.allocLocal("__argc_saved");
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.FP, argcOff, VReg.V0);
        const saved = [];
        for (let k = 1; k <= 5; k++) {
            const so = this.ctx.allocLocal(`__ctor_args_a_${k}`);
            // Rest / _array_push already smashed live A1-A5. Same rule as
            // emitCtorRestParam: read the entry snapshot.
            this._loadIncomingArg(k, VReg.V6);
            vm.store(VReg.FP, so, VReg.V6);
            saved.push(so);
        }
        const spill = this.ctx._argvSpill;
        if (spill) {
            for (let k = 5; k < 16; k++) {
                if (spill[k] === undefined) break;
                saved.push(spill[k]);
            }
        }
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.store(VReg.FP, argOff, VReg.RET);
        const done = this.ctx.newLabel("ctor_args_done");
        for (let k = 0; k < saved.length; k++) {
            vm.load(VReg.V0, VReg.FP, argcOff);
            vm.cmpImm(VReg.V0, k);
            vm.jle(done);
            vm.load(VReg.V0, VReg.FP, saved[k]);
            vm.load(VReg.A0, VReg.FP, argOff);
            vm.mov(VReg.A1, VReg.V0);
            vm.call("_array_push");
            vm.store(VReg.FP, argOff, VReg.RET);
        }
        vm.label(done);
        vm.load(VReg.A0, VReg.FP, argOff);
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V4);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.orImm(VReg.V1, VReg.V1, 32);
        vm.storeByte(VReg.V0, 1, VReg.V1);
        for (let k = 1; k <= 5; k++) {
            vm.load(vm.getArgReg(k), VReg.FP, saved[k - 1]);
        }
    },

    // [D1 L3b] 函数体指令序言是否含 "use strict"(含其它 leading 字符串指令之后)。
    // 与 parser.peekUseStrictDirective 对齐的廉价 AST 版:只看 BlockStatement 体首连续
    // ExpressionStatement(字符串字面量)指令序言。
    _hasUseStrictDirective(expr) {
        if (!expr || !expr.body) return false;
        const stmts = expr.body.type === "BlockStatement" ? expr.body.body : null;
        if (!stmts || stmts.length === 0) return false;
        for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i];
            if (!s || s.type !== "ExpressionStatement") break;
            const e = s.expression;
            if (!e || (e.type !== "Literal" && e.type !== "StringLiteral") || typeof e.value !== "string") break;
            if (e.value === "use strict") return true;
        }
        return false;
    },

    // [D1 L3b] 函数 [[Strict]]:自有指令 / 外层 inStrictFunction / 程序级 _bsStrict / 类体。
    // 结果供 registerFuncMeta 打包进 kind 高字节,以及 compileFunctionBody 继承给嵌套函数。
    _computeFunctionStrict(expr) {
        if (!expr) return false;
        if (expr._fnStrict === true) return true;
        if (this._hasUseStrictDirective(expr)) return true;
        if (this.ctx && this.ctx.inStrictFunction) return true;
        if (this.ctx && this.ctx.inClass) return true;
        if (this._currentModuleAst && this._currentModuleAst._bsStrict) return true;
        return false;
    },

    // 编译函数表达式
    // 检测函数体是否引用 this（决定箭头是否需要捕获外层 this）
    functionBodyUsesThis(expr) {
        const walk = (node) => {
            if (!node || typeof node !== "object") return false;
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) if (walk(node[i])) return true;
                return false;
            }
            const t = node.type;
            if (t === "ThisExpression") return true;
            // Super property/call uses GetThisBinding of the enclosing method.
            // Object-literal super.fromA in an arrow must capture lexical __this
            // (GetPrototypeOf(this)); Super alone is not ThisExpression.
            if (t === "SuperExpression" || t === "Super") return true;
            // 不下钻嵌套的普通函数（它们有自己的 this）；箭头函数继续下钻
            if (t === "FunctionExpression" || t === "FunctionDeclaration") return false;
            if (t === "Identifier" || t === "Literal" || t === "Super" ||
                t === "PrivateIdentifier" || t === "EmptyStatement" || t === "DebuggerStatement" ||
                t === "MetaProperty" || t === "TemplateElement") return false;
            if (t === "MemberExpression") {
                if (walk(node.object)) return true;
                return node.computed ? walk(node.property) : false;
            }
            if (t === "CallExpression" || t === "NewExpression") {
                if (walk(node.callee)) return true;
                const args = node.arguments;
                if (args) for (let i = 0; i < args.length; i++) if (walk(args[i])) return true;
                if (t === "CallExpression" && node.callee && node.callee.type === "Identifier" &&
                    node.callee.name === "eval" && args && args[0] &&
                    (args[0].type === "Literal" || args[0].type === "StringLiteral") &&
                    typeof args[0].value === "string") {
                    try {
                        const prog = this.parse(args[0].value);
                        if (walk(prog)) return true;
                    } catch (_e) { /* invalid eval source: runtime */ }
                }
                return false;
            }
            if (t === "BinaryExpression" || t === "LogicalExpression" || t === "AssignmentExpression") {
                return walk(node.left) || walk(node.right);
            }
            if (t === "UnaryExpression" || t === "UpdateExpression" || t === "AwaitExpression" ||
                t === "YieldExpression" || t === "ThrowStatement" || t === "ReturnStatement" ||
                t === "SpreadElement" || t === "RestElement" || t === "ExpressionStatement") {
                return walk(node.argument || node.expression);
            }
            if (t === "ArrowFunctionExpression") {
                // 箭头共享外层 this:继续下钻 body/params
                if (walk(node.body)) return true;
                const params = node.params;
                if (params) for (let i = 0; i < params.length; i++) if (walk(params[i])) return true;
                return false;
            }
            if (t === "BlockStatement" || t === "Program" || t === "ClassBody") {
                const body = node.body;
                if (body) for (let i = 0; i < body.length; i++) if (walk(body[i])) return true;
                return false;
            }
            if (t === "IfStatement" || t === "ConditionalExpression") {
                return walk(node.test) || walk(node.consequent) || walk(node.alternate);
            }
            if (t === "VariableDeclaration") {
                const decls = node.declarations;
                if (decls) for (let i = 0; i < decls.length; i++) if (walk(decls[i])) return true;
                return false;
            }
            if (t === "VariableDeclarator") {
                return walk(node.id) || walk(node.init);
            }
            if (t === "Property" || t === "PropertyDefinition" || t === "MethodDefinition") {
                if (node.computed && walk(node.key)) return true;
                return walk(node.value);
            }
            if (t === "ArrayExpression" || t === "ArrayPattern") {
                const els = node.elements;
                if (els) for (let i = 0; i < els.length; i++) if (walk(els[i])) return true;
                return false;
            }
            if (t === "ObjectExpression" || t === "ObjectPattern") {
                const prs = node.properties;
                if (prs) for (let i = 0; i < prs.length; i++) if (walk(prs[i])) return true;
                return false;
            }
            if (t === "SequenceExpression" || t === "TemplateLiteral") {
                const xs = node.expressions;
                if (xs) for (let i = 0; i < xs.length; i++) if (walk(xs[i])) return true;
                return false;
            }
            if (t === "ForStatement") {
                return walk(node.init) || walk(node.test) || walk(node.update) || walk(node.body);
            }
            if (t === "ForInStatement" || t === "ForOfStatement" || t === "WhileStatement" ||
                t === "DoWhileStatement") {
                return walk(node.left || node.test) || walk(node.right) || walk(node.body);
            }
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "range") continue;
                if (k.length && k.charCodeAt(0) === 95) continue;
                const v = node[k];
                if (v && typeof v === "object" && walk(v)) return true;
            }
            return false;
        };
        return walk(expr.body);
    },

    // Arrow lexical NewTarget: true if body has `new.target` (not nested function).
    functionBodyUsesNewTarget(expr) {
        const walk = (node) => {
            if (!node || typeof node !== "object") return false;
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) if (walk(node[i])) return true;
                return false;
            }
            const t = node.type;
            if (t === "MetaProperty") {
                return !!(node.meta && node.meta.name === "new" &&
                    node.property && node.property.name === "target");
            }
            if (t === "FunctionExpression" || t === "FunctionDeclaration" ||
                t === "ClassDeclaration" || t === "ClassExpression") return false;
            if (t === "Identifier" || t === "Literal" || t === "ThisExpression" ||
                t === "Super" || t === "PrivateIdentifier" || t === "EmptyStatement" ||
                t === "DebuggerStatement" || t === "TemplateElement") return false;
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "range") continue;
                if (k.length && k.charCodeAt(0) === 95) continue;
                const v = node[k];
                if (v && typeof v === "object" && walk(v)) return true;
            }
            return false;
        };
        return walk(expr && expr.body) || walk(expr && expr.params);
    },

    // Arrow lexical Super / ThisBindingStatus: Super or SuperExpression
    // (not nested function/class). d2bcc0d extracted the call site but
    // missed this helper → class ctor arrows COMPILE_FAIL.
    functionBodyUsesSuper(expr) {
        const walk = (node) => {
            if (!node || typeof node !== "object") return false;
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) if (walk(node[i])) return true;
                return false;
            }
            const t = node.type;
            if (t === "Super" || t === "SuperExpression") return true;
            if (t === "FunctionExpression" || t === "FunctionDeclaration" ||
                t === "ClassDeclaration" || t === "ClassExpression") return false;
            if (t === "Identifier" || t === "Literal" || t === "ThisExpression" ||
                t === "PrivateIdentifier" || t === "EmptyStatement" ||
                t === "DebuggerStatement" || t === "MetaProperty" ||
                t === "TemplateElement") return false;
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "range") continue;
                if (k.length && k.charCodeAt(0) === 95) continue;
                const v = node[k];
                if (v && typeof v === "object" && walk(v)) return true;
            }
            return false;
        };
        return walk(expr && expr.body) || walk(expr && expr.params);
    },

    // 函数体是否把 `arguments` 当值引用(非 obj.arguments 属性/对象字面量键)。
    // 不下钻嵌套普通函数(它们有各自的 arguments);箭头继续下钻(共享外层 arguments)。
    functionBodyUsesArguments(expr) {
        if (!expr) return false;
        const walk = (node) => {
            if (!node || typeof node !== "object") return false;
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) if (walk(node[i])) return true;
                return false;
            }
            const t = node.type;
            if (t === "Identifier") return node.name === "arguments";
            if (t === "FunctionExpression" || t === "FunctionDeclaration") return false;
            if (t === "Literal" || t === "ThisExpression" || t === "Super" ||
                t === "PrivateIdentifier" || t === "EmptyStatement" || t === "DebuggerStatement" ||
                t === "MetaProperty" || t === "TemplateElement") return false;
            if (t === "MemberExpression") {
                if (walk(node.object)) return true;
                // obj.arguments 的属性名不是引用
                return node.computed ? walk(node.property) : false;
            }
            if (t === "CallExpression" || t === "NewExpression") {
                if (walk(node.callee)) return true;
                const args = node.arguments;
                if (args) for (let i = 0; i < args.length; i++) if (walk(args[i])) return true;
                return false;
            }
            if (t === "BinaryExpression" || t === "LogicalExpression" || t === "AssignmentExpression") {
                return walk(node.left) || walk(node.right);
            }
            if (t === "UnaryExpression" || t === "UpdateExpression" || t === "AwaitExpression" ||
                t === "YieldExpression" || t === "ThrowStatement" || t === "ReturnStatement" ||
                t === "SpreadElement" || t === "RestElement" || t === "ExpressionStatement") {
                return walk(node.argument || node.expression);
            }
            if (t === "ArrowFunctionExpression") {
                if (walk(node.body)) return true;
                const params = node.params;
                if (params) for (let i = 0; i < params.length; i++) if (walk(params[i])) return true;
                return false;
            }
            if (t === "BlockStatement" || t === "Program" || t === "ClassBody") {
                const body = node.body;
                if (body) for (let i = 0; i < body.length; i++) if (walk(body[i])) return true;
                return false;
            }
            if (t === "IfStatement" || t === "ConditionalExpression") {
                return walk(node.test) || walk(node.consequent) || walk(node.alternate);
            }
            if (t === "VariableDeclaration") {
                const decls = node.declarations;
                if (decls) for (let i = 0; i < decls.length; i++) if (walk(decls[i])) return true;
                return false;
            }
            if (t === "VariableDeclarator") {
                return walk(node.id) || walk(node.init);
            }
            if (t === "Property" || t === "PropertyDefinition" || t === "MethodDefinition") {
                // {arguments:...} 的键名不是引用
                if (node.computed && walk(node.key)) return true;
                return walk(node.value);
            }
            if (t === "ArrayExpression" || t === "ArrayPattern") {
                const els = node.elements;
                if (els) for (let i = 0; i < els.length; i++) if (walk(els[i])) return true;
                return false;
            }
            if (t === "ObjectExpression" || t === "ObjectPattern") {
                const prs = node.properties;
                if (prs) for (let i = 0; i < prs.length; i++) if (walk(prs[i])) return true;
                return false;
            }
            if (t === "SequenceExpression" || t === "TemplateLiteral") {
                const xs = node.expressions;
                if (xs) for (let i = 0; i < xs.length; i++) if (walk(xs[i])) return true;
                return false;
            }
            if (t === "ForStatement") {
                return walk(node.init) || walk(node.test) || walk(node.update) || walk(node.body);
            }
            if (t === "ForInStatement" || t === "ForOfStatement" || t === "WhileStatement" ||
                t === "DoWhileStatement") {
                return walk(node.left || node.test) || walk(node.right) || walk(node.body);
            }
            if (t === "AssignmentPattern") {
                return walk(node.left) || walk(node.right);
            }
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "range") continue;
                if (k.length && k.charCodeAt(0) === 95) continue;
                const v = node[k];
                if (v && typeof v === "object" && walk(v)) return true;
            }
            return false;
        };
        // [test262 params-dflt-ref-arguments] 默认值表达式里的 arguments 引用
        // (x = arguments[2]) 也要建 arguments 对象(构造先于默认值求值,见
        // compileFunctionBody 顺序)。此前只扫 body → usesArguments=false →
        // arguments[2] 落 globalThis 读 undefined。
        return walk(expr.body) || walk(expr.params);
    },

    // 在函数入口把实参(A0..A4,A5=this 不计入)收集成数组存入局部 `arguments`。
    // [argc ABI] 实参个数由调用点写入 _call_argc 全局,进入体最先读取——真 undefined
    // 实参不再截断计数(旧「填 undefined 即停」约定误把 f(1,undefined,3) 数成 1)。
    // 数组构造会踩 A 寄存器,故先存临时槽再构造,末尾恢复 A0..A4 供后续具名参数绑定。
    emitArgumentsArray() {
        const vm = this.vm;
        const argOff = this.ctx.allocLocal("arguments");
        // 最先读 _call_argc 入 FP 槽(体内 _array_* 等 runtime helper 不改写它,
        // 但一切 JS 调用点都会——必须在任何用户代码执行前落栈)。
        const argcOff = this.ctx.allocLocal("__argc_saved");
        if (!this.ctx._pinnedFpOffs) this.ctx._pinnedFpOffs = [];
        this.ctx._pinnedFpOffs.push(argcOff);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.FP, argcOff, VReg.V0);
        const saved = [];
        const spillRegs = this.ctx._argRegSpill;
        for (let k = 0; k <= 4; k++) {
            // Prefer the entry snapshot (__argreg_*, already pinned). A second
            // copy of live A-regs can be lifted onto x64 V7≡A1 and then smashed
            // by _array_new/_array_push (arguments[1] became 1e-323).
            if (spillRegs && typeof spillRegs[k] === "number") {
                saved.push(spillRegs[k]);
                continue;
            }
            const so = this.ctx.allocLocal(`__args_a_${k}`);
            this.ctx._pinnedFpOffs.push(so);
            vm.store(VReg.FP, so, vm.getArgReg(k));
            saved.push(so);
        }
        // A5=this: helper 调用(_array_new/_array_push)会毁掉 A5。此前只恢复 A0..A4,
        // 序言稍后 __this=A5 写成垃圾 → this+arguments 同函数 SIGSEGV(x64; arm64
        // 同样会被 call 毁掉 A5,只是偶发未爆)。
        let thisSave;
        if (spillRegs && typeof spillRegs[5] === "number") {
            thisSave = spillRegs[5];
        } else {
            thisSave = this.ctx.allocLocal("__args_a5_this");
            this.ctx._pinnedFpOffs.push(thisSave);
            vm.store(VReg.FP, thisSave, VReg.A5);
        }
        // [argv 溢出] 实参 5..15 在 _call_argv:快照槽已由 emitArgvSpillSnapshot 备好
        // (未备则本函数只见前 5 个,同旧行为)。argc 守卫在下方收集循环里统一做。
        const spill = this.ctx._argvSpill;
        if (spill) {
            for (let k = 5; k < 16; k++) {
                if (spill[k] === undefined) break;
                saved.push(spill[k]);
            }
        }
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r"); // box->helper
        vm.store(VReg.FP, argOff, VReg.RET);
        const done = this.ctx.newLabel("args_done");
        for (let k = 0; k < saved.length; k++) {
            // k < argc → 收该实参(即使值为真 undefined);k >= argc → 结束
            vm.load(VReg.V0, VReg.FP, argcOff);
            vm.cmpImm(VReg.V0, k);
            vm.jle(done);
            vm.load(VReg.V0, VReg.FP, saved[k]);
            vm.load(VReg.A0, VReg.FP, argOff);
            vm.mov(VReg.A1, VReg.V0);
            vm.call("_array_push");
            vm.store(VReg.FP, argOff, VReg.RET);
        }
        vm.label(done);
        // 标记 arguments 异质:越界 [[Set]] 不抬 length(ARR_IS_ARGUMENTS=bit5)
        vm.load(VReg.A0, VReg.FP, argOff);
        // x64 V4≡A5: mask 入 V4 会毁掉 this,随后 __this=A5 变成掩码。V5/V6 无 ABI 别名。
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V6, VReg.A0, VReg.V5); // 裸头
        vm.loadByte(VReg.V1, VReg.V6, 1);
        vm.orImm(VReg.V1, VReg.V1, 32);
        vm.storeByte(VReg.V6, 1, VReg.V1);
        // sloppy: arguments.callee = 当前函数。
        // IIFE/方法:入口 S0 是闭包(compileClosureCall)。顶层 function 声明直调
        // 不置 S0 → 用与 compileIdentifier 同一 _funcclosure_<sym> memo 槽。
        if (!this.ctx.inStrictFunction) {
            const calS0 = this.ctx.newLabel("args_callee_s0");
            const calSet = this.ctx.newLabel("args_callee_set");
            const calSkip = this.ctx.newLabel("args_callee_skip");
            const calName = this.ctx.newLabel("args_callee_name");
            vm.shrImm(VReg.V1, VReg.S0, 48);
            vm.cmpImm(VReg.V1, 0x7FFF);
            vm.jeq(calS0);
            vm.cmpImm(VReg.S0, 0);
            vm.jeq(calName);
            // compilePlainFunctionNew 入口 S0=装箱 this(0x7FFD),非裸闭包;对 tag≠0 解引用 → SIGSEGV。
            vm.cmpImm(VReg.V1, 0);
            vm.jne(calName);
            vm.load(VReg.V0, VReg.S0, 0);
            vm.cmpImm(VReg.V0, 0xc105);
            vm.jeq(calS0);
            vm.jmp(calName);
            vm.label(calS0);
            vm.mov(VReg.A2, VReg.S0);
            vm.shrImm(VReg.V1, VReg.S0, 48);
            vm.cmpImm(VReg.V1, 0x7FFF);
            vm.jeq(calSet);
            vm.emitMaskLoad(VReg.V5);
            vm.andMaskReg(VReg.A2, VReg.S0, VReg.V5);
            vm.movImm64(VReg.V1, 0x7fff000000000000n);
            vm.or(VReg.A2, VReg.A2, VReg.V1);
            vm.jmp(calSet);
            vm.label(calName);
            const fnName = this.ctx.currentFnName;
            if (fnName && this.ensureFuncClosureSlot && this.getFunctionLabel) {
                const funcLabel = this.getFunctionLabel(fnName) || (this.getDeclaredFunctionLabel && this.getDeclaredFunctionLabel(fnName));
                if (funcLabel) {
                    const fcSymbol = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(fnName)) || fnName;
                    const slotLabel = this.ensureFuncClosureSlot(fcSymbol);
                    const haveL = this.ctx.newLabel("args_callee_have");
                    vm.lea(VReg.V0, slotLabel);
                    vm.load(VReg.RET, VReg.V0, 0);
                    vm.cmpImm(VReg.RET, 0);
                    vm.jne(haveL);
                    vm.movImm(VReg.A0, 16);
                    vm.call("_alloc");
                    vm.mov(VReg.S1, VReg.RET);
                    vm.movImm(VReg.V1, 0xc105);
                    vm.store(VReg.S1, 0, VReg.V1);
                    vm.lea(VReg.V1, funcLabel);
                    vm.store(VReg.S1, 8, VReg.V1);
                    vm.mov(VReg.A0, VReg.S1);
                    vm.call("_js_box_function");
                    vm.lea(VReg.V1, slotLabel);
                    vm.store(VReg.V1, 0, VReg.RET);
                    vm.label(haveL);
                    vm.mov(VReg.A2, VReg.RET);
                    vm.jmp(calSet);
                }
            }
            vm.jmp(calSkip);
            vm.label(calSet);
            vm.load(VReg.A0, VReg.FP, argOff);
            vm.lea(VReg.A1, vm.asm.addString("callee"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.call("_object_set");
            vm.label(calSkip);
        } else {
            // strict: own callee/caller = %ThrowTypeError% accessors
            vm.load(VReg.A0, VReg.FP, argOff);
            vm.call("_args_install_strict_throwers");
        }
        // own @@iterator = Array.prototype.values (lazy if proto not filled)
        vm.load(VReg.A0, VReg.FP, argOff);
        vm.call("_args_install_iterator");
        for (let k = 0; k <= 4; k++) {
            vm.load(vm.getArgReg(k), VReg.FP, saved[k]);
        }
        vm.load(VReg.A5, VReg.FP, thisSave);
    },

    // [argv 溢出] 寄存器窗口(实参 0-4)之外的实参 5..15 由调用点写 _call_argv 全局。
    // 与 _call_argc 同契约:**进入函数体第一时间**快照进本帧槽,之后任何 JS 调用都会
    // 覆盖该全局。argc <= i 的槽填真 JS_UNDEFINED —— 全局槽残留的是上一次调用的值,
    // 不守卫会把陈旧实参当本次实参。n = 需要覆盖的实参上界(形参个数;体内用
    // `arguments` 时取满 16)。返回 {索引: 帧内偏移} 并挂 ctx._argvSpill。
    // 进入用户函数立刻把 A0-A5 落到 FP。任何后续 helper(含 _alloc /
    // emitInstallAsyncExcFrame / `new`)都会毁掉 A-reg;形参绑定与 `this`
    // 必须从这些槽读。`__argreg_*` 是合成名,allocLocal 不绑 T*。
    emitArgRegSnapshot() {
        const vm = this.vm;
        const sp = [];
        if (!this.ctx._pinnedFpOffs) this.ctx._pinnedFpOffs = [];
        for (let i = 0; i < 6; i++) {
            const off = this.ctx.allocLocal(`__argreg_${i}`);
            vm.store(VReg.FP, off, vm.getArgReg(i));
            sp.push(off);
            // 钉 FP:x64 上 LSRA 若把本槽升到 V1≡A3,第一条 store 变成
            // `mov A3,A0`,A3 还没快照就被冲掉(class ctor / 多形参方法)。
            this.ctx._pinnedFpOffs.push(off);
        }
        this.ctx._argRegSpill = sp;
        return sp;
    },

    _loadIncomingArg(i, dest) {
        const sp = this.ctx._argRegSpill;
        if (sp && typeof sp[i] === "number") {
            this.vm.load(dest, VReg.FP, sp[i]);
            return;
        }
        this.vm.mov(dest, this.vm.getArgReg(i));
    },

    emitArgvSpillSnapshot(n) {
        this.ctx._argvSpill = null;
        if (!n || n <= 5) return null;
        const vm = this.vm;
        const cap = n > 16 ? 16 : n;
        const argcOff = this.ctx.allocLocal(`__argv_argc_${this.nextLabelId()}`);
        vm.lea(VReg.V5, "_call_argc");
        vm.load(VReg.V6, VReg.V5, 0);
        vm.store(VReg.FP, argcOff, VReg.V6);
        const offs = {};
        for (let i = 5; i < cap; i++) {
            const off = this.ctx.allocLocal(`__argv_sp${i}_${this.nextLabelId()}`);
            const done = this.ctx.newLabel("argv_sp_done");
            vm.movImm64(VReg.V0, 0x7ffb000000000000n);
            vm.store(VReg.FP, off, VReg.V0);
            vm.load(VReg.V6, VReg.FP, argcOff);
            vm.cmpImm(VReg.V6, i);
            vm.jle(done);
            vm.lea(VReg.V5, "_call_argv");
            vm.load(VReg.V0, VReg.V5, i * 8);
            vm.store(VReg.FP, off, VReg.V0);
            vm.label(done);
            offs[i] = off;
        }
        this.ctx._argvSpill = offs;
        return offs;
    },

    // 把快照槽写回 _call_argv(转发 super(...)/FDI 求值可能踩脏全局槽)。
    emitRestoreCallArgvFromSpill() {
        const sp = this.ctx._argvSpill;
        if (!sp) return;
        const vm = this.vm;
        for (let i = 5; i < 16; i++) {
            if (sp[i] === undefined) break;
            vm.load(VReg.V6, VReg.FP, sp[i]);
            vm.lea(VReg.V5, "_call_argv");
            vm.store(VReg.V5, i * 8, VReg.V6);
        }
    },

    // 实参 i → 帧内槽 off。i<5 取寄存器(构造器约定 argBase=1,实参在 A1..A5);
    // i>=5 取 emitArgvSpillSnapshot 的快照槽,无快照则 JS_UNDEFINED。
    emitArgToSlot(i, off, argBase) {
        const vm = this.vm;
        const base = argBase || 0;
        if (i < 5) {
            const idx = i + base;
            const sp = this.ctx._argRegSpill;
            if (sp && typeof sp[idx] === "number") {
                vm.load(VReg.V6, VReg.FP, sp[idx]);
                vm.store(VReg.FP, off, VReg.V6);
                return;
            }
            vm.store(VReg.FP, off, vm.getArgReg(idx));
            return;
        }
        const spill = this.ctx._argvSpill;
        if (spill && spill[i] !== undefined) {
            vm.load(VReg.V0, VReg.FP, spill[i]);
            vm.store(VReg.FP, off, VReg.V0);
            return;
        }
        vm.movImm64(VReg.V0, 0x7ffb000000000000n);
        vm.store(VReg.FP, off, VReg.V0);
    },


    // P1 录制:LLVM virtreg — 非空用户函数一律 T* + endRecord 线性扫描。
    // 旧门只录 for/while,无循环的局部全走 FP,热路径会慢一个数量级。
    // 过大由 REC_CAP 白冲。Toolchain 仍 skip:compiler/engine/vm 进 eval
    // 产物会超官方 30s compile。runtime/node 用户热循环仍录。
    _p1SkipCurrent() {
        const p = this.sourcePath;
        if (typeof p !== "string") return false;
        if (p.indexOf("__regexp_shim") !== -1) return true;
        return p.indexOf("compiler/") !== -1 ||
            p.indexOf("lang/") !== -1 ||
            p.indexOf("asm/") !== -1 ||
            p.indexOf("backend/") !== -1 ||
            p.indexOf("/vm/") !== -1 ||
            p.indexOf("engine/") !== -1 ||
            // Runtime generators are imported by the compiler graph and AOT'd
            // into eval/`new Function` binaries. Their for-loops are huge;
            // recording them pushes 4-way windows-x64 compile past 30s.
            // runtime/node/ (user-facing builtins) still records.
            p.indexOf("runtime/core/") !== -1 ||
            p.indexOf("runtime/types/") !== -1 ||
            p.indexOf("runtime/async/") !== -1;
    },

    _fnNeedsP1Record(expr) {
        const body = expr && expr.body;
        if (!body) return false;
        if (body.type === "BlockStatement" && (!body.body || body.body.length === 0)) return false;
        return true;
    },

    _nodeHasLoop(n) {
        if (!n || typeof n !== "object") return false;
        const ty = n.type;
        if (ty === "WhileStatement" || ty === "DoWhileStatement" || ty === "ForStatement") {
            return true;
        }
        // for-in/of 在编译器里极多且晋升收益相对小,不触发录制。
        // 不进入嵌套函数/类
        if (ty === "FunctionExpression" || ty === "ArrowFunctionExpression" ||
            ty === "FunctionDeclaration" || ty === "ClassExpression" || ty === "ClassDeclaration") {
            return false;
        }
        if (ty === "BlockStatement") {
            const list = n.body;
            if (list) {
                for (let i = 0; i < list.length; i++) {
                    if (this._nodeHasLoop(list[i])) return true;
                }
            }
            return false;
        }
        if (ty === "IfStatement") {
            return this._nodeHasLoop(n.consequent) || this._nodeHasLoop(n.alternate);
        }
        if (ty === "TryStatement") {
            if (this._nodeHasLoop(n.block)) return true;
            if (n.handler && this._nodeHasLoop(n.handler.body)) return true;
            return this._nodeHasLoop(n.finalizer);
        }
        if (ty === "SwitchStatement") {
            const cases = n.cases;
            if (cases) {
                for (let i = 0; i < cases.length; i++) {
                    const cons = cases[i].consequent;
                    if (cons) {
                        for (let j = 0; j < cons.length; j++) {
                            if (this._nodeHasLoop(cons[j])) return true;
                        }
                    }
                }
            }
            return false;
        }
        if (ty === "LabeledStatement" || ty === "WithStatement") {
            return this._nodeHasLoop(n.body);
        }
        return false;
    },


    // RET = 装箱函数。挂自有 prototype({w:true,e:false,c:false})。
    // GeneratorFunction 的 prototype 对象不得有 own "constructor"；它从
    // %GeneratorPrototype% / %AsyncGeneratorPrototype% 继承对应的 constructor。
    // 生成器函数值的 gOPD 只扫侧表、不触发惰性建,须在造值时落下。
    emitFnOwnPrototype(isAsyncGenerator = false) {
        const vm = this.vm;
        const fnOff = this.ctx.allocLocal(`__fnown_${this.nextLabelId()}`);
        vm.store(VReg.FP, fnOff, VReg.RET);
        vm.call("_object_new");
        vm.call("_box_obj_r");
        const protoOff = this.ctx.allocLocal(`__fnownp_${this.nextLabelId()}`);
        vm.store(VReg.FP, protoOff, VReg.RET);
        // Generator instances inherit from %GeneratorPrototype% and async
        // generator instances from %AsyncGeneratorPrototype%.
        vm.call(isAsyncGenerator ? "_ensure_asyncgen_proto" : "_ensure_gen_proto");
        vm.mov(VReg.V1, VReg.RET);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V0, VReg.V1, VReg.V2);
        vm.load(VReg.V1, VReg.FP, protoOff);
        vm.andMaskReg(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.V1, 16, VReg.V0);
        vm.load(VReg.A0, VReg.FP, fnOff);
        this.emitBoxedStringKey("prototype", VReg.A1);
        vm.load(VReg.A2, VReg.FP, protoOff);
        vm.call("_closure_prop_set");
        vm.load(VReg.A0, VReg.FP, fnOff);
        this.emitBoxedStringKey("prototype", VReg.A1);
        vm.movImm(VReg.A2, 1);
        vm.call("_closure_prop_set_attr");
        vm.load(VReg.RET, VReg.FP, fnOff);
    },

    compileFunctionExpression(expr) {
        const outerLocals = this.ctx.locals || {};
        const outerBoxedVars = this.ctx.boxedVars || new Set();
        let captured = analyzeCapturedVariables(expr, outerLocals, this.ctx.functions);
        // 纵深防御:普通函数的 arguments 永不从外层捕获(见 analyzeCapturedVariables)。
        if (expr.type !== "ArrowFunctionExpression") {
            const filtered = [];
            for (let i = 0; i < captured.length; i++) {
                if (captured[i] !== "arguments") filtered.push(captured[i]);
            }
            captured = filtered;
        }
        // **仅箭头函数**捕获外层 this（使 () => this.x 访问词法 this）。普通函数表达式/
        // 对象字面量简写方法(`{ m(){ this.x } }`)是普通函数,应取**动态** this(A5 接收者,
        // 序言已置 __this=A5);此前误对所有用 this 的函数表达式捕获 → 函数内创建的对象字面量
        // 方法(如工厂 `function make(v){return {i:v,read(){return this.i}}}`)拿到词法/陈旧
        // this 而非接收者(手写迭代器 `{next(){return this.i}}` 静默错的根因)。
        // 顶层无 __this 槽时仍捕获(存 globalThis),否则 forEach(arrow, thisArg) 会把
        // thisArg 写进 A5 当成箭头 this。
        const capturesThis = expr.type === "ArrowFunctionExpression" &&
            this.functionBodyUsesThis(expr);
        if (capturesThis) {
            let hasThisCap = false;
            for (let i = 0; i < captured.length; i++) {
                if (captured[i] === "__this") { hasThisCap = true; break; }
            }
            if (!hasThisCap) captured = captured.concat(["__this"]);
        }
        // 箭头 lexical NewTarget:捕获外层 __new_target(Call 写 undefined,不能读全局)。
        const capturesNT = expr.type === "ArrowFunctionExpression" &&
            this.functionBodyUsesNewTarget(expr);
        if (capturesNT) {
            let hasNT = false;
            for (let i = 0; i < captured.length; i++) {
                if (captured[i] === "__new_target") { hasNT = true; break; }
            }
            if (!hasNT) captured = captured.concat(["__new_target"]);
        }
        // 箭头 lexical Super / ThisBindingStatus:捕获外层派生构造器的
        // __super_called box。() => this 也须见未初始化 this (GetThisBinding)。
        if (expr.type === "ArrowFunctionExpression" &&
            this.ctx.superCalledOff != null &&
            (this.functionBodyUsesSuper(expr) || this.functionBodyUsesThis(expr))) {
            let hasSC = false;
            for (let i = 0; i < captured.length; i++) {
                if (captured[i] === "__super_called") { hasSC = true; break; }
            }
            if (!hasSC) captured = captured.concat(["__super_called"]);
        }
        // with(obj) 内创建的函数:[[Scope]] 含该对象环境。把当前 with 对象当
        // `__with_N` 捕获进闭包,函数体再装回 withScopes(否则 p1='x1' 写到全局)。
        const withCapSlots = [];
        if (this.ctx.withScopes) {
            for (let wi = 0; wi < this.ctx.withScopes.length; wi++) withCapSlots.push(this.ctx.withScopes[wi]);
        }
        if (this.ctx.outerWithScopes) {
            for (let wi = 0; wi < this.ctx.outerWithScopes.length; wi++) withCapSlots.push(this.ctx.outerWithScopes[wi]);
        }
        if (withCapSlots.length > 0) {
            for (let wi = 0; wi < withCapSlots.length; wi++) {
                const wn = "__with_" + wi;
                let hasW = false;
                for (let i = 0; i < captured.length; i++) {
                    if (captured[i] === wn) { hasW = true; break; }
                }
                if (!hasW) captured = captured.concat([wn]);
            }
            this._pendingWithCapSlots = withCapSlots;
        }

        const funcLabel = this.ctx.newLabel("fn");
        const isAsync = isAsyncFunction(expr);
        // async(含 async generator)闭包一律用普通 CLOSURE_MAGIC:标签处的 async stub
        // (emitAsyncMethodStub / emitAsyncGeneratorStub)建协程+Promise,compileClosureCall
        // 与 compileMethodCall 的普通闭包路径都会调到 stub(方法调用经 A5 传 this)。
        // 不再用 ASYNC_CLOSURE_MAGIC(那条 call-site 内联建协程路径只覆盖 f() 不覆盖 obj.f())。
        const isAsyncClosureMagic = false;

        // [D1 L3b] 定义处即盖章 [[Strict]],供延迟 generatePendingFunctions→registerFuncMeta
        // 读取(届时外层 inStrictFunction 已恢复)。不扩闭包头(captured@16 热路径不变)。
        expr._fnStrict = this._computeFunctionStrict(expr);

        // 总是创建闭包对象，即使没有捕获变量
        // 这样可以统一闭包调用机制，避免区分普通函数指针和闭包对象
        // 闭包对象结构:
        // +0:  magic (0xC105 或 0xA51C for async)
        // +8:  func_ptr
        // +16: captured_var_0 (box 指针)
        // +24: captured_var_1 (box 指针)
        // ...
        const closureSize = 16 + captured.length * 8;

        this.vm.movImm(VReg.A0, closureSize);
        this.vm.call("_alloc");
        const cloH = this._holdExpr(VReg.RET);

        // 写入 magic 标记（区分普通函数和 async 函数；async generator 走普通 magic）
        this.vm.movImm(VReg.V1, isAsyncClosureMagic ? ASYNC_CLOSURE_MAGIC : CLOSURE_MAGIC);
        this.vm.store(VReg.RET, 0, VReg.V1);

        // 写入函数指针
        this.vm.lea(VReg.V1, funcLabel);
        this.vm.store(VReg.RET, 8, VReg.V1);

        // 写入捕获的变量（box 指针）
        // 注意：闭包总是存储 box 指针，无论外部变量是否装箱
        // 因为 compileFunctionBody 总是期望 box 指针并解引用
        for (let i = 0; i < captured.length; i++) {
            const varName = captured[i];
            let offset = outerLocalsGet(outerLocals, varName);
            if (!(typeof offset === "number" && offset) &&
                varName.length >= 7 && varName.charCodeAt(0) === 95 &&
                varName.slice(0, 7) === "__with_") {
                const wi = parseInt(varName.slice(7), 10);
                const wslots = this._pendingWithCapSlots;
                if (wslots && wi >= 0 && wi < wslots.length) {
                    offset = wslots[wi];
                }
            }
            // [#32] 纵深防御:outerLocals 是裸字典,合法偏移恒为负数;typeof 守卫挡
            // 一切沿原型链命中的污染值(closure.js 修复后 captured 必为自有局部)。
            if (typeof offset === "number" && offset) {
                this._loadHeldExpr(cloH, VReg.V3);

                // [#63] 外部变量已经装箱：该 box 就是绑定的唯一真身(可能同时被
                // 顶层函数经 _main_captured_ 全局 box、以及先前创建的其它闭包共享)。
                // 必须把**既有 box 指针**直接存进闭包槽以共享同一 box——绝不能
                // 另 _box_alloc 造新 box 并重指 FP 槽:那会让 FP 槽/新闭包指向新 box,
                // 而全局 label box 与更早创建的闭包仍指向旧 box → 之后对该变量的
                // 重赋值(写 FP 槽的 box)只更新新 box,旧 box 持有者(如顶层函数实参
                // 求值里的副作用)读到陈旧值(#63:obj.m(arg(1),arg(2)) 丢 a1/a2)。
                // __this 不是 box,走下面的新建 box 路径。
                if (outerBoxedVars.has(varName) && varName !== "__this" && varName !== "__new_target") {
                    this.vm.load(VReg.V1, VReg.FP, offset);        // V1 = 既有 box 指针
                    this.vm.store(VReg.V3, 16 + i * 8, VReg.V1);   // 闭包槽 = 共享既有 box
                    continue;
                }

                // 到此仅剩两类：__this(外层直接存值,非 box)、以及尚未装箱的外层变量
                // (首次装箱)。二者都取外层槽的原始值,下面新建 box 包裹。
                this.vm.load(VReg.V1, VReg.FP, offset);  // V1 = 原始值
                const capValH = this._holdExpr(VReg.V1);
                this.vm.call("_box_alloc");  // RET = new box pointer(分配+登记,分代 minor 根)
                this._loadHeldExpr(capValH, VReg.V1);
                this._loadHeldExpr(cloH, VReg.V2);
                this._releaseHeldExpr();
                this.vm.store(VReg.RET, 0, VReg.V1);  // [RET] = value
                this.vm.store(VReg.V2, 16 + i * 8, VReg.RET);  // [V2 + offset] = box
            } else if (varName === "__new_target") {
                // 顶层箭头:无外层 NewTarget → undefined
                this.vm.movImm64(VReg.V1, 0x7ffb000000000000n);
                const ntValH = this._holdExpr(VReg.V1);
                this.vm.call("_box_alloc");
                this._loadHeldExpr(ntValH, VReg.V1);
                this._loadHeldExpr(cloH, VReg.V2);
                this._releaseHeldExpr();
                this.vm.store(VReg.RET, 0, VReg.V1);
                this.vm.store(VReg.V2, 16 + i * 8, VReg.RET);
            } else if (varName === "__this") {
                // 顶层箭头:无外层 __this 槽,词法 this = globalThis。
                this.vm.lea(VReg.V0, "_global_this");
                this.vm.load(VReg.RET, VReg.V0, 0);
                this.vm.call("_box_obj_r");
                const thisValH = this._holdExpr(VReg.RET);
                this.vm.call("_box_alloc");
                this._loadHeldExpr(thisValH, VReg.V1);
                this._loadHeldExpr(cloH, VReg.V2);
                this._releaseHeldExpr();
                this.vm.store(VReg.RET, 0, VReg.V1);
                this.vm.store(VReg.V2, 16 + i * 8, VReg.RET);
            }
        }
        this._pendingWithCapSlots = null;

        this._loadHeldExpr(cloH, VReg.RET);
        this._releaseHeldExpr();

        // 将原始指针装箱为 JSValue 函数
        // JSValue = (ptr & 0x0000ffffffffffff) | 0x7fff000000000000
        this.vm.mov(VReg.V2, VReg.RET);  // V2 = 原始指针副本
        this.vm.emitMaskLoad(VReg.V1);  // V1 = MASK
        this.vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1);  // V2 = V2 & V1 = ptr & MASK
        this.vm.movImm64(VReg.V1, 0x7fff000000000000n);  // V1 = TAG (function)
        this.vm.or(VReg.RET, VReg.V2, VReg.V1);  // RET = (ptr & MASK) | TAG

        // 生成器函数值自有 prototype({w:true,e:false,c:false})。gOPD 不走
        // _cpg_miss 惰性建,须在造值时落下,否则 function*(){} 无该自有属性。
        if (isGeneratorFunction(expr)) this.emitFnOwnPrototype(isAsyncFunction(expr));

        // Runtime-compiled functions live in mmap pages, outside the host
        // executable's immutable func_meta table.  Register their code
        // pointer/kind/name/arity at creation time so OrdinaryCallBindThis,
        // constructor, toStringTag, instanceof and IsConstructor see the
        // same semantics as AOT functions.  Generators/async lack
        // [[Construct]] (kind bit 9).
        if (this.engineNoIC) {
            let dynKind = 0;
            if (isGeneratorFunction(expr)) dynKind = isAsyncFunction(expr) ? 3 : 1;
            else if (isAsyncFunction(expr)) dynKind = 2;
            if (this._computeFunctionStrict(expr)) dynKind |= 0x100;
            if (isGeneratorFunction(expr) || isAsyncFunction(expr)) dynKind |= 0x200;
            let dynArity = 0;
            const dynParams = expr.params || [];
            for (let dpi = 0; dpi < dynParams.length; dpi++) {
                const dp = dynParams[dpi];
                if (!dp || dp.type === "AssignmentPattern" || dp.type === "RestElement" ||
                    dp.type === "SpreadElement") break;
                dynArity = dynArity + 1;
            }
            let dynName = "";
            if (expr.id && expr.id.name) dynName = expr.id.name;
            else if (typeof expr._fnHint === "string") dynName = expr._fnHint;
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.movImm(VReg.A1, dynKind);
            this.vm.movImm(VReg.A2, dynArity);
            this.vm.lea(VReg.A3, this.asm.addString(dynName));
            this.vm.call("_dynamic_fn_meta_add");
        }

        if (!this.pendingFunctions) {
            this.pendingFunctions = [];
        }
        this.pendingFunctions.push({
            label: funcLabel,
            expr: expr,
            captured: captured,
            // 记录定义处的模块上下文：函数体在 generatePendingFunctions 里延迟编译，
            // 那时 this.ctx 已是 main。若不恢复模块的 mainCapturedVars/_currentModuleAst，
            // 对象字面量方法体（如 parser 的 mixin）里的 namespace 标识符（AST）会解析成 0，
            // 导致 new AST.X() 崩。class 方法经 withModuleCompileContext 天然有此上下文。
            moduleAst: this._currentModuleAst,
            mainCapturedVars: this.ctx.mainCapturedVars,
            functionAliases: this.ctx.functionAliases,
            sourcePath: this.sourcePath,
            // 定义处的**类名**:私有名改写 `#x` → "#ClassName#x" 靠它。函数体在
            // generatePendingFunctions 里延迟编译,那时 ctx 已是 main(className 空),
            // 于是方法内箭头/函数表达式里的 `this.#x` 编成键 "##x" → 与实例上的
            // "#C#x" 不匹配 → 读 undefined / 方法调用 "not a function"。
            className: this.ctx.className,
            // 定义处的 super 绑定:箭头体延迟编译时 ctx 已是 main,不恢复则
            // emitLoadSuperClassInfo(undefined)→S1=0→super() skip(count 不加)。
            superClass: this.ctx.superClass,
            superClassExpr: this.ctx.superClassExpr,
            superInfoLabel: this.ctx.superInfoLabel,
            classInfoLabel: this.ctx.classInfoLabel,
            inStaticMethod: this.ctx.inStaticMethod,
            // Arrows inherit the enclosing class-method brand / field-init
            // eval rules; ordinary nested functions do not.
            inClassMethod: expr.type === "ArrowFunctionExpression" ? !!this.ctx.inClassMethod : false,
            inFieldInit: expr.type === "ArrowFunctionExpression" ? !!this.ctx.inFieldInit : false,
            inObjectMethod: !!(expr._isObjectMethod || (expr.type === "ArrowFunctionExpression" && this.ctx.inObjectMethod)),
            // 私有名作用域链快照(词法):嵌套类里的箭头体也须按声明者类名改写
            privateScopes: this._privateScopes ? this._privateScopes.slice() : null,
            // 外层具名函数表达式的不可变绑定,被本闭包捕获时须继续禁写。
            immutableFromParent: (this.ctx.immutableLocals
                ? (() => {
                    const out = [];
                    const im = this.ctx.immutableLocals;
                    for (let i = 0; i < captured.length; i++) {
                        const n = captured[i];
                        if (im.has(n)) out.push(n);
                    }
                    return out;
                })()
                : null),
            classNameFromParent: (this.ctx.classNameBindings
                ? (() => {
                    const out = [];
                    const cn = this.ctx.classNameBindings;
                    for (let i = 0; i < captured.length; i++) {
                        const n = captured[i];
                        if (cn.has(n)) out.push(n);
                    }
                    return out;
                })()
                : null),
        });
    },

    // 生成待处理的函数体
    generatePendingFunctions() {
        if (!this.pendingFunctions || this.pendingFunctions.length === 0) {
            return;
        }
        const _traceClass = typeof process !== "undefined" && process.env && process.env.ASMJS_TRACE_CLASS === "1";
        for (const func of this.pendingFunctions) {
            if (_traceClass) console.log("GPF_BEGIN", func.label);
            // [m121-fix] 恢复逐函数 IC 池隔离。m118 整批共用导致跨函数 shape 毒化,
            // node/gen2 编出的自举产物在大图(cli/index)上 SEGV(把小整数当堆指针)。
            this._resetIcPropMaps();
            this.vm.label(func.label);
            // [函数元数据] func.label 即闭包 func_ptr(见 compileFunctionExpression 存 +8)。
            // 登记函数种类(async/generator),供 Object.prototype.toString 品牌区分。
            this.registerFuncMeta(func.label, func.expr);
            // 恢复定义处的模块上下文,使**stub 与函数体**都能正确解析 namespace/import 标识符。
            // 此前只包住 compileFunctionBody:stub(emitGeneratorStub)里 [L2-②] eager 默认值
            // 探针的安全判定(isUnresolvableIdentifier)需见模块顶层局部(顶层 `var iter`),
            // 否则把已声明的名误判为 unresolvable → 探针求值错抛 ReferenceError。
            // (顶层函数声明走 compileFunction,本就持模块 ctx,不受此影响。)
            const savedModuleAst = this._currentModuleAst;
            const savedMCV = this.ctx.mainCapturedVars;
            const savedFA = this.ctx.functionAliases;
            const savedSP = this.sourcePath;
            const savedClassName = this.ctx.className;
            const savedPrivScopes = this._privateScopes;
            const savedSuperClass = this.ctx.superClass;
            const savedSuperClassExpr = this.ctx.superClassExpr;
            const savedSuperInfoLabel = this.ctx.superInfoLabel;
            const savedClassInfoLabel = this.ctx.classInfoLabel;
            const savedInStaticMethod = this.ctx.inStaticMethod;
            const savedInClassMethod = this.ctx.inClassMethod;
            const savedInFieldInit = this.ctx.inFieldInit;
            const savedInObjectMethod = this.ctx.inObjectMethod;
            if (func.moduleAst) this._currentModuleAst = func.moduleAst;
            if (func.mainCapturedVars) this.ctx.mainCapturedVars = func.mainCapturedVars;
            if (func.functionAliases) this.ctx.functionAliases = func.functionAliases;
            if (func.sourcePath) this.sourcePath = func.sourcePath;
            if (func.className) this.ctx.className = func.className;
            if (func.privateScopes) this._privateScopes = func.privateScopes;
            this.ctx.superClass = func.superClass;
            this.ctx.superClassExpr = func.superClassExpr;
            this.ctx.superInfoLabel = func.superInfoLabel;
            this.ctx.classInfoLabel = func.classInfoLabel;
            this.ctx.inStaticMethod = func.inStaticMethod;
            this.ctx.inClassMethod = !!func.inClassMethod;
            this.ctx.inFieldInit = !!func.inFieldInit;
            this.ctx.inObjectMethod = !!func.inObjectMethod;
            // [批次D] 生成器函数表达式：标签处先落 stub（建协程+生成器对象后即返回），
            // 真正函数体在 <label>_gbody，由 _coroutine_entry 首次 resume 时进入。
            let fdiList = null;
            this._genStubFnExpr = func.expr;
            this.ctx._pendingImmutableFromParent = func.immutableFromParent;
            this.ctx._pendingClassNameFromParent = func.classNameFromParent;
            if (isGeneratorFunction(func.expr) && !isAsyncFunction(func.expr)) {
                if (_traceClass) console.log("GPF_GEN_STUB", func.label);
                fdiList = this.emitGeneratorStub(func.label + "_gbody", true, undefined, func.captured);
            } else if (isGeneratorFunction(func.expr) && isAsyncFunction(func.expr)) {
                // async function*：async 生成器 stub(构造器 _async_generator_new)
                fdiList = this.emitAsyncGeneratorStub(func.label + "_gbody", true, func.captured);
            } else if (isAsyncFunction(func.expr)) {
                // async 函数/方法(表达式):标签处落 async stub(建协程+Promise 返回),真体在
                // _gbody。闭包用 CLOSURE_MAGIC(见下),故 compileClosureCall/compileMethodCall
                // 的普通闭包路径都会调到本 stub(方法调用经 A5 传 this → CORO_THIS),统一。
                this.emitAsyncMethodStub(func.label + "_gbody", true);
            }
            if (_traceClass) console.log("GPF_BODY_BEGIN", func.label);
            this.compileFunctionBody(func.expr, func.captured, fdiList);
            if (_traceClass) console.log("GPF_BODY_DONE", func.label);
            this._genStubFnExpr = null;
            this.ctx._pendingImmutableFromParent = null;
            this.ctx._pendingClassNameFromParent = null;
            this._currentModuleAst = savedModuleAst;
            this.ctx.mainCapturedVars = savedMCV;
            this.ctx.functionAliases = savedFA;
            this.sourcePath = savedSP;
            this.ctx.className = savedClassName;
            this._privateScopes = savedPrivScopes;
            this.ctx.superClass = savedSuperClass;
            this.ctx.superClassExpr = savedSuperClassExpr;
            this.ctx.superInfoLabel = savedSuperInfoLabel;
            this.ctx.classInfoLabel = savedClassInfoLabel;
            this.ctx.inStaticMethod = savedInStaticMethod;
            this.ctx.inClassMethod = savedInClassMethod;
            this.ctx.inFieldInit = savedInFieldInit;
            this.ctx.inObjectMethod = savedInObjectMethod;
            if (_traceClass) console.log("GPF_RESTORE", func.label);
        }

        this.pendingFunctions = [];
        if (_traceClass) console.log("GPF_DONE");
    },

    // 编译函数体
    // [FDI eager] fdiList=生成器 pattern 形参在 stub 已完成绑定的叶名序(非生成器恒 null)。
    compileFunctionBody(expr, captured, fdiList = null) {
        const _traceClass = typeof process !== "undefined" && process.env && process.env.ASMJS_TRACE_CLASS === "1";
        if (_traceClass) console.log("CFB_BEGIN", expr && expr.type);
        const params = expr.params || [];
        const vm = this.vm;

        const isAsync = isAsyncFunction(expr);
        const isGenerator = isGeneratorFunction(expr);

        // 函数入口 - 简化版本
        // [P1] 函数体录制(热槽晋升)。async 禁录:S4 跨协程共享(协程上下文
        // 只存 SP/FP/LR,不含 callee-saved),晋升局部会被其它协程踩。
        // [批次D] 生成器体同 async 跑在协程栈上,同理禁录。
        // (曾对 __regexp_shim 模块禁录规避"x64 晋升错编返回值"——实为 #37
        // 对齐垫 V0=RAX 冲返回值,已根修;#41 相等比较双求值也已根修,解除禁录。)
        // 片段 compileFragment 禁 IC,同样禁 P1 录制:pending 函数体里 lea 字符串标签/
        // prologue 的 savedRegs 数组写入 _recB[](初值为 0 的稠密数字数组)会在 asm.js
        // 自托管编译器上触发「Cannot assign to read only property」(类型槽拒写)。
        // 顶层 Uint8Array 不经 beginRecord,故不受影响;new Function/eval 嵌套函数体才踩中。
        const doP1 = !isAsync && !isGenerator && !this.engineNoIC &&
            !this._p1SkipCurrent() && this._fnNeedsP1Record(expr);
        if (doP1) vm.beginRecord();
        const savedRegs = [VReg.S0, VReg.S1, VReg.S2, VReg.S3];
        // Large compiler methods (notably compileClassDeclaration) allocate
        // more than the historical 8 KiB local area while self-hosting.  Keep
        // enough headroom for this experiment; the frame-size policy will be
        // centralized once the dynamic high-water mark is wired through.
        vm.prologue(16384, savedRegs);
        const prevFnFrameSize = this.ctx._fnFrameSize;
        this.ctx._fnFrameSize = 16384;

        const prevLocals = this.ctx.locals;
        const prevEngineLocalNames = this.ctx._engineLocalNames;
        const prevEngineLocalOffsets = this.ctx._engineLocalOffsets;
        const prevLocalsUndo = this.ctx._localsUndo;
        const prevStackOffset = this.ctx.stackOffset;
        const prevReturnLabel = this.ctx.returnLabel;
        const prevBoxedVars = this.ctx.boxedVars;
        const prevRawFloatVars = this.ctx.rawFloatVars;
        const prevInAsyncFunction = this.ctx.inAsyncFunction;
        const prevInAsyncGenerator = this.ctx.inAsyncGenerator;
        const prevInCoroBody = this.ctx.inCoroBody;
        const prevInStrictFunction = this.ctx.inStrictFunction;
        const prevIsArrowFunction = this.ctx._isArrowFunction;
        const prevPreboundFnDecls = this.ctx._preboundFnDecls;
        const prevImmutableLocals = this.ctx.immutableLocals;
        const prevClassNameBindings = this.ctx.classNameBindings;
        const prevFnExprNameSlot = this.ctx.fnExprNameSlot;
        const prevSuperCalledOff = this.ctx.superCalledOff;
        const prevWithScopes = this.ctx.withScopes;
        const prevOuterWithScopes = this.ctx.outerWithScopes;
        const prevArgRegSpill = this.ctx._argRegSpill;
        const prevPinnedFpOffs = this.ctx._pinnedFpOffs;
        const prevEsPool = this.ctx._esPool;
        const prevEsDepth = this.ctx._esDepth;
        const prevLocalTemps = this.ctx.localTemps;
        const prevObjTmpSlots = this.ctx._objTmpSlots;
        const prevObjTmpDepth = this.ctx._objTmpDepth;
        const prevArrTmpSlots = this.ctx._arrTmpSlots;
        const prevArrTmpDepth = this.ctx._arrTmpDepth;

        this.ctx.locals = new Map();
        if (prevEngineLocalNames && prevEngineLocalOffsets) {
            this.ctx._engineLocalNames = [];
            this.ctx._engineLocalOffsets = [];
        }
        this.ctx.withScopes = [];
        this.ctx.outerWithScopes = [];
        this.ctx.localTemps = null;
        this.ctx._argRegSpill = null;
        this.ctx._pinnedFpOffs = [];
        this.ctx._esPool = null;
        this.ctx._esDepth = 0;
        this.ctx._objTmpSlots = null;
        this.ctx._objTmpDepth = 0;
        this.ctx._arrTmpSlots = null;
        this.ctx._arrTmpDepth = 0;
        this.ctx._localsUndo = [];
        this.ctx._preboundFnDecls = new Set();
        this.ctx.stackOffset = 0;
        this.ctx.inAsyncFunction = isAsync;
        this.ctx.inAsyncGenerator = isAsync && isGenerator;
        this.ctx.inCoroBody = isGenerator; // [gen unwind] 生成器体(含 async gen)跑协程栈
        // [D1 L3b] 本函数 [[Strict]] 继承给体内嵌套函数表达式(OrdinaryCallBindThis)。
        const fnStrict = this._computeFunctionStrict(expr);
        expr._fnStrict = fnStrict;
        this.ctx.inStrictFunction = fnStrict;
        this.ctx._isArrowFunction = expr.type === "ArrowFunctionExpression";
        const prevCurrentFnName = this.ctx.currentFnName;
        this.ctx.currentFnName = (expr.id && expr.id.name) ? expr.id.name : null;

        // 分析函数体中哪些变量会被内部闭包捕获
        const innerBoxedVars = analyzeSharedVariables(expr);
        this._addDirectEvalBoxedVars(expr, innerBoxedVars);
        this.ctx.boxedVars = innerBoxedVars;
        this.ctx.rawFloatVars = analyzeRawFloatVars(expr, innerBoxedVars);
        this.ctx.immutableLocals = new Set(this.ctx._pendingImmutableFromParent || []);
        this.ctx.classNameBindings = new Set(this.ctx._pendingClassNameFromParent || []);
        this.ctx.fnExprNameSlot = 0;
        this.ctx.superCalledOff = null;
        const prevInFunctionBody = this.ctx._inFunctionBody;
        this.ctx._inFunctionBody = true;
        const prevLexLocalNames = this.ctx.lexLocalNames;
        const prevLetConstClassNames = this.ctx.letConstClassNames;
        const prevParamBindingNames = this.ctx.paramBindingNames;
        const prevOwnBindingNames = this.ctx.ownBindingNames;
        const prevBodyEvalVarNames = this.ctx.bodyEvalVarNames;
        const prevTdzCleared = this.ctx._tdzClearedLocals;
        // [m120] 声明点写完后记入:同函数体内后续读免值级哨兵(preboxed const vm=this.vm
        // 曾对每次读空 cmp)。嵌套函数自有 Set,捕获读仍守卫。
        this.ctx._tdzClearedLocals = new Set();
        this.ctx.lexLocalNames = {};
        this.ctx.letConstClassNames = {};
        if (!fnStrict && expr.body) {
            collectLexicalDeclarations(expr.body, this.ctx.lexLocalNames);
        }
        // Prefer pre-rename stamp from _stampAnnexBLexicalNames (source names).
        if (expr._letConstClassNames) {
            this.ctx.letConstClassNames = expr._letConstClassNames;
        } else if (expr.body) {
            collectLetConstClassNames(expr.body, this.ctx.letConstClassNames);
        }
        this.ctx.paramBindingNames = {};
        for (let _pi = 0; _pi < params.length; _pi++) {
            collectPatternNames(params[_pi], this.ctx.paramBindingNames);
        }
        this.ctx.ownBindingNames = {};
        if (expr.body) {
            collectLocalDeclarations(expr.body, this.ctx.ownBindingNames);
            collectDirectFunctionDeclNames(expr.body, this.ctx.ownBindingNames);
        }
        for (const _pn in this.ctx.paramBindingNames) {
            if (this.ctx.paramBindingNames[_pn]) this.ctx.ownBindingNames[_pn] = true;
        }
        if (expr.type === "FunctionExpression" && expr.id && expr.id.name) {
            this.ctx.immutableLocals.add(expr.id.name);
        }

        const returnLabel = this.ctx.newLabel("fn_return");
        this.ctx.returnLabel = returnLabel;

        // async 函数体:未捕获异常拒绝其 Promise(而非退出)。设一个"外层"异常标签,
        // throw/await-reject 在无更内层 try 时跳此 → reject。save/restore 保护外层上下文。
        const prevExceptionLabel = this.ctx.exceptionLabel;
        const prevAsyncExcFrameOff = this.ctx._asyncExcFrameOff;
        const prevAsyncCoroOff = this.ctx._asyncCoroOff;
        const prevAsyncPromiseOff = this.ctx._asyncPromiseOff;
        let asyncRejectLabel = null;
        // A0-A5 must be on the frame before emitInstallAsyncExcFrame / any
        // helper: x64 V2≡A2, so loading coro.promise into V2 otherwise
        // replaces the 3rd actual (`SameValue([object Promise], NaN)`).
        this.emitArgRegSnapshot();
        // async generator 体走协程/生成器返回流(非 Promise resolve),不设 async_reject 落点。
        if (isAsync && !isGenerator) {
            asyncRejectLabel = this.ctx.newLabel("async_reject");
            this.ctx.exceptionLabel = asyncRejectLabel;
            this.emitInstallAsyncExcFrame(asyncRejectLabel);
        }

        // [#49] `arguments` 对象(数组近似):仅普通函数(箭头共享外层 arguments,不建)、
        // 且未被同名参数遮蔽、且函数体确有引用时构造。必须在具名参数绑定前(A 寄存器仍
        // 持实参),emitArgumentsArray 内部会存临时槽并在末尾恢复 A0..A4。
        const usesArguments =
            expr.type !== "ArrowFunctionExpression" &&
            !(params || []).some((p) =>
                (p.type === "Identifier" && p.name === "arguments") ||
                (p.type === "AssignmentPattern" && p.left && p.left.name === "arguments") ||
                (p.type === "SpreadElement" && p.argument && p.argument.name === "arguments")) &&
            this.functionBodyUsesArguments(expr);
        // [argv 溢出] 实参 5.. 的快照须是进入体后**第一件事**(任何 JS 调用都会覆盖
        // _call_argv 全局);emitArgumentsArray / ...rest 也从该快照取第 6 个及以后的实参。
        // rest 形参需要满窗快照(params.length 只计到 rest 自身,不够覆盖 rest 元素)。
        let needFullArgv = usesArguments;
        if (!needFullArgv) {
            for (let ri = 0; ri < params.length; ri++) {
                if (params[ri] && params[ri].type === "SpreadElement") { needFullArgv = true; break; }
            }
        }
        // 尽早落 A5=this:emitArgumentsArray / 默认值求值的 helper call 都会毁掉 A5。
        const thisOffsetEarly = this.ctx.allocLocal("__this");
        vm.store(VReg.FP, thisOffsetEarly, VReg.A5);
        this.emitSnapshotNewTarget();
        this.emitArgvSpillSnapshot(needFullArgv ? 16 : params.length);
        if (usesArguments) {
            this.emitArgumentsArray();
        }
        if (expr.type === "FunctionExpression" && expr.id && expr.id.name) {
            this.emitNamedFunctionExprBinding(expr);
            for (let ai = 0; ai < 6; ai++) this._loadIncomingArg(ai, vm.getArgReg(ai));
        }
        if (this._paramsHaveExpressions(params)) this.emitSeedMainCapturedVars();
        this._pendingParamEvalParams = params;
        this.maybeEmitParamEvalVarSlots(isGenerator && !!fdiList);

        // 处理参数 - 先保存所有参数到栈（因为后续操作可能破坏参数寄存器）
        // 注意：先保存参数，再处理闭包捕获变量，避免寄存器冲突
        // [L2-③ TDZ] 形参默认值自引用/后向引用标点(直接 Identifier 形态;两单循环 + indexOf,
        // 嵌套 for 形态在自举产物原生误编)。compileIdentifier 按 _tdzRefName 抛 ReferenceError。
        {
            const tdzN = [];
            for (let ti = 0; ti < params.length; ti++) {
                const tp = params[ti];
                if (tp && tp.type === "Identifier") tdzN.push(tp.name);
                else if (tp && tp.type === "AssignmentPattern" && tp.left && tp.left.type === "Identifier") tdzN.push(tp.left.name);
            }
            for (let mi = 0; mi < params.length; mi++) {
                const mp = params[mi];
                if (mp && mp.type === "AssignmentPattern" && mp.right && mp.right.type === "Identifier" &&
                    tdzN.indexOf(mp.right.name, mi) >= 0) {
                    mp.right._tdzRefName = mp.right.name;
                }
            }
        }
        const paramOffsets = [];
        const patternParams = [];
        // [L2-③ TDZ] 参数名收集(前序):默认值评估期自引用/后向引用须抛 ReferenceError
        const tdzParamNames = [];
        for (let i = 0; i < params.length && i < 16; i++) {
            const tp = params[i];
            if (tp.type === "Identifier") tdzParamNames.push(tp.name);
            else if (tp.type === "AssignmentPattern" && tp.left && tp.left.type === "Identifier") tdzParamNames.push(tp.left.name);
        }
        this.ctx.paramLexNames = new Set(tdzParamNames);
        for (let i = 0; i < params.length && i < 16; i++) {
            const p = params[i];
            let paramName = null;
            let defaultExpr = null;
            if (p.type === "Identifier") {
                paramName = p.name;
            } else if (p.type === "AssignmentPattern" && p.left && p.left.type === "Identifier") {
                // 默认参数 param = expr：此前 AssignmentPattern 被跳过，参数从不入槽 → 恒读 0
                paramName = p.left.name;
                defaultExpr = p.right;
            } else if (p.type === "SpreadElement" && p.argument && p.argument.type === "Identifier") {
                // 剩余参数 ...rest：收集 A_i..A4 非 undefined 实参为数组（A5=this，不收）
                this.emitRestParam(p.argument.name, i);
                continue;
            } else if (this._isPatternParam(p)) {
                // [#47] 解构参数 ({a,b})=>.. / function({a,b}){}：实参落临时槽,
                // 解构延后到全部实参入栈后(防 A 寄存器互踩)。
                // [FDI eager] 生成器 pattern 形参已在调用期(stub)完成绑定,体内不重复
                // 解构(见下 patternParams 循环的 transfer 路径),此处也不落槽。
                if (isGenerator && fdiList) continue;
                const pat = p.type === "AssignmentPattern" ? p.left : p;
                const dexpr = p.type === "AssignmentPattern" ? p.right : null;
                const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                this.emitArgToSlot(i, pslot);
                patternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                continue;
            }
            if (!paramName) continue;
            // [FDI ident] 生成器标识符默认值形参已在调用期(stub)求值,经 transfer 数组
            // 绑定(见 patternParams 循环的 transfer 路径),此处不落槽/不求默认。
            if (isGenerator && fdiList && fdiList.indexOf(paramName) !== -1) continue;
            // [FDI ident] 生成器标识符默认值形参已在调用期(stub)求值,经 transfer 数组
            // 绑定(见 patternParams 循环的 transfer 路径),此处不落槽/不求默认。
            if (isGenerator && fdiList && fdiList.indexOf(paramName) !== -1) continue;
            const offset = this.ctx.allocLocal(paramName);
            paramOffsets.push({ name: paramName, offset: offset, argReg: i < 5 ? vm.getArgReg(i) : null });
            this.emitArgToSlot(i, offset);
            if (defaultExpr) {
                // [L2-③ TDZ] 默认值表达式求值前,当前及之后所有形参名入 tdzParams
                if (!this.ctx.tdzParams) this.ctx.tdzParams = new Set();
                for (let j = i; j < tdzParamNames.length; j++) this.ctx.tdzParams.add(tdzParamNames[j]);
                // [L2-④] 默认值求值经任意 JS 调用踩 A0-A4;后续形参仍要从实参寄存器
                // 绑定(identifier/pattern/rest 皆然),故先快照、求值后恢复(镜像
                // emitArgumentsArray 的 A 寄存器卫生)。此前不恢复 → 第二及以后默认
                // 形参的实参绑定读垃圾(params-dflt-ref-arguments: y 读成 1e-323)。
                const argSnap = [];
                for (let ai = 0; ai < 5; ai++) {
                    const so = this.ctx.allocLocal(`__argsnap_${this.nextLabelId()}_${ai}`);
                    vm.store(VReg.FP, so, vm.getArgReg(ai));
                    argSnap.push(so);
                }
                // 实参为 undefined 时取默认值（默认表达式可引用前序参数，已入槽）
                // x64: V1/V2 别名 RCX/RDX = A3/A2，会踩掉尚未入槽的后续实参；
                // 改用 V5/V6(R10/R11)。arm64 保持 V1/V2，产物逐字节不变。
                const chkReg = vm.backend.name === "x64" ? VReg.V5 : VReg.V1;
                const undReg = vm.backend.name === "x64" ? VReg.V6 : VReg.V2;
                const skip = this.ctx.newLabel("defparam_skip");
                vm.load(chkReg, VReg.FP, offset);
                vm.movImm64(undReg, 0x7ffb000000000000n); // JS_UNDEFINED
                vm.cmp(chkReg, undReg);
                vm.jne(skip);
                const _prevEvalParam = this.ctx._evalInParamInit;
                this.ctx._evalInParamInit = true;
                if (!this.emitParamEvalConflictSyntaxError(defaultExpr)) {
                    this.compileExpression(defaultExpr);
                }
                this.ctx._evalInParamInit = _prevEvalParam;
                vm.store(VReg.FP, offset, VReg.RET);
                vm.label(skip);
                for (let ai = 0; ai < 5; ai++) {
                    vm.load(vm.getArgReg(ai), VReg.FP, argSnap[ai]);
                }
                // 当前形参默认值评估完毕,从 TDZ 移除
                if (paramName) this.ctx.tdzParams.delete(paramName);
            }
        }
        // [L2-③ TDZ] 全部形参初始化完毕,清空 TDZ 集:无默认值的后续形参(z)在默认值
        // 评估期间被标记、但从未走 delete 分支,残留标记令**函数体**读 z 误抛
        // ReferenceError(params-dflt-ref-arguments / pa4 形态)。规范:TDZ 仅覆盖
        // 默认值评估期,形参全部绑定后全体可用。
        if (this.ctx.tdzParams) this.ctx.tdzParams.clear();
        // [m120] 形参已绑定 → 体读免值级哨兵
        if (this.ctx._tdzClearedLocals) {
            for (const pn in this.ctx.paramBindingNames) {
                if (this.ctx.paramBindingNames[pn] === true) {
                    this.ctx._tdzClearedLocals.add(pn);
                }
            }
        }

        // __this 已在 arguments/默认值求值前落入(见 thisOffsetEarly)。
        // 不可再从 A5 重写:那些路径的 JS/helper 调用已毁掉 A5。

        // 处理闭包捕获变量 - 从闭包对象中加载 box 指针
        // S0 寄存器包含闭包对象指针（由 compileClosureCall 传入）
        // 闭包对象布局: [magic(8), func_ptr(8), box_ptr_0, box_ptr_1, ...]
        const _bodyBinds = {};
        if (expr.body) {
            collectLocalDeclarations(expr.body, _bodyBinds);
            collectDirectFunctionDeclNames(expr.body, _bodyBinds);
        }
        const _bodyEvalVars = collectBodyEvalVarNames(expr.body);
        this.ctx.bodyEvalVarNames = null;
        for (const _ev in _bodyEvalVars) {
            if (_bodyEvalVars[_ev] !== true) continue;
            _bodyBinds[_ev] = true;
            if (!this.ctx.bodyEvalVarNames) this.ctx.bodyEvalVarNames = new Set();
            this.ctx.bodyEvalVarNames.add(_ev);
        }
        if (captured && captured.length > 0) {
            // 将闭包指针保存到 S1，因为 S0 可能在函数体中被覆盖
            vm.mov(VReg.S1, VReg.S0);

            for (let i = 0; i < captured.length; i++) {
                const varName = captured[i];
                const closureOffset = 16 + i * 8; // 跳过 magic 和 func_ptr
                // 体 var/let 与捕获的外层同名:分离 varEnv,不把外层 box 别名进体槽
                // (默认值闭包已在 stub 捕获外层;scope-paramsbody-var-open)。
                if (varName !== "__this" &&
                    _bodyBinds[varName] === true) {
                    // [S11.13.2] eval('var x') 与捕获同名:复合赋值 LHS 仍写捕获 box。
                    if (this.ctx.bodyEvalVarNames && this.ctx.bodyEvalVarNames.has(varName)) {
                        const capOff = this.ctx.allocLocal(`__cap_${varName}`);
                        vm.load(VReg.V1, VReg.S1, closureOffset);
                        vm.store(VReg.FP, capOff, VReg.V1);
                    }
                    continue;
                }
                if (varName === "__this") {
                    // __this：闭包 slot 存的是 box 指针（存储侧统一 box 化），
                    // 解引用得到 this 值，恢复到已有 __this 槽（覆盖 A5 垃圾）
                    vm.load(VReg.V1, VReg.S1, closureOffset); // box 指针
                    vm.load(VReg.V1, VReg.V1, 0);             // this 值
                    const thisOff = this.ctx.getLocal("__this");
                    vm.store(VReg.FP, thisOff, VReg.V1);
                    continue;
                }
                if (varName === "__new_target") {
                    vm.load(VReg.V1, VReg.S1, closureOffset);
                    vm.load(VReg.V1, VReg.V1, 0);
                    const ntOff = this.ctx.getLocal("__new_target");
                    if (ntOff != null) vm.store(VReg.FP, ntOff, VReg.V1);
                    continue;
                }
                if (varName.length >= 7 && varName.slice(0, 7) === "__with_") {
                    // with 对象:闭包槽是 box,解引用得对象值(非 box 指针)再压 withScopes,
                    // 使体内标识符走 Object Environment(_object_has / 赋值 / delete)。
                    const wOff = this.ctx.allocLocal(varName);
                    vm.load(VReg.V1, VReg.S1, closureOffset);
                    vm.load(VReg.V1, VReg.V1, 0);
                    vm.store(VReg.FP, wOff, VReg.V1);
                    this.ctx.outerWithScopes.push(wOff);
                    continue;
                }
                // 从闭包对象加载 box 指针到新的局部变量
                const offset = this.ctx.allocLocal(varName);
                vm.load(VReg.V1, VReg.S1, closureOffset); // 加载 box 指针
                vm.store(VReg.FP, offset, VReg.V1); // 存储 box 指针

                // 标记这个变量为装箱变量（因为它存储的是 box 指针）
                this.ctx.boxedVars.add(varName);
            }
            const scOff = this.ctx.getLocal("__super_called");
            if (scOff && this.ctx.boxedVars.has("__super_called")) {
                this.ctx.superCalledOff = scOff;
            }
        }

        this.emitBodyEvalVarSlots();

        // 为需要装箱的参数创建 box
        for (let i = 0; i < paramOffsets.length; i++) {
            const param = paramOffsets[i];
            if (innerBoxedVars.has(param.name)) {
                // 从栈中加载参数值
                vm.load(VReg.V1, VReg.FP, param.offset);
                const pbH = this._holdExpr(VReg.V1);
                vm.call("_box_alloc"); // 分配+登记(分代 minor 根)
                vm.store(VReg.FP, param.offset, VReg.RET); // 存储 box 指针
                this._loadHeldExpr(pbH, VReg.V1);
                this._releaseHeldExpr();
                vm.store(VReg.RET, 0, VReg.V1); // 存入 box
            }
        }

        // Arguments [[ParameterMap]]:non-strict + 简单形参 + 引用 arguments
        // (与 compiler/index.js 顶层声明同构;函数表达式/IIFE 此前只建数组不装映射
        // → arguments[i]=x 不回写形参,15.2.3.6-4-294-1 等 FAIL)。
        const mappedArgs = usesArguments && !fnStrict && this._isSimpleParamList(params);
        if (mappedArgs && paramOffsets.length > 0) {
            const mappedParamIndex = new Array(paramOffsets.length);
            const mappedParamNames = new Set();
            for (let i = paramOffsets.length - 1; i >= 0; i--) {
                const pn = paramOffsets[i].name;
                mappedParamIndex[i] = !mappedParamNames.has(pn);
                mappedParamNames.add(pn);
            }
            for (let i = 0; i < paramOffsets.length; i++) {
                if (!mappedParamIndex[i]) continue;
                const param = paramOffsets[i];
                if (innerBoxedVars.has(param.name)) continue;
                vm.load(VReg.V1, VReg.FP, param.offset);
                const mapBoxH = this._holdExpr(VReg.V1);
                vm.call("_box_alloc");
                vm.store(VReg.FP, param.offset, VReg.RET);
                this._loadHeldExpr(mapBoxH, VReg.V1);
                this._releaseHeldExpr();
                vm.store(VReg.RET, 0, VReg.V1);
                innerBoxedVars.add(param.name);
                this.ctx.boxedVars.add(param.name);
            }
            const mapOff = this.ctx.allocLocal(`__argmap_${this.nextLabelId()}`);
            vm.movImm(VReg.A0, paramOffsets.length * 8);
            vm.call("_alloc");
            vm.store(VReg.FP, mapOff, VReg.RET);
            for (let i = 0; i < paramOffsets.length; i++) {
                if (mappedParamIndex[i]) vm.load(VReg.V0, VReg.FP, paramOffsets[i].offset);
                else vm.movImm(VReg.V0, 0);
                vm.load(VReg.V1, VReg.FP, mapOff);
                vm.store(VReg.V1, i * 8, VReg.V0);
            }
            const argLocal = this.ctx.getLocal("arguments");
            if (argLocal) {
                vm.load(VReg.A0, VReg.FP, argLocal);
                vm.load(VReg.A1, VReg.FP, mapOff);
                vm.movImm(VReg.A2, paramOffsets.length);
                vm.call("_args_param_map_install");
            }
        }

        // [#47] 解构参数:所有实参已落栈,此处安全解构到局部。
        // [FDI eager] 生成器 pattern 形参已在调用期(stub)绑定:从 coro+168 transfer 数组
        // 按绑定序取叶值,跳过重复解构(二重消费自定义迭代器会错值/错计)。
        if (isGenerator && fdiList) {
            this.emitGenTransferLoads(fdiList);
        } else {
            for (let i = 0; i < patternParams.length; i++) {
                this.emitParamDestructure(patternParams[i].pat, patternParams[i].slot, patternParams[i].dflt);
            }
        }

        this.unbindBodyBindingsAfterParamInit(expr.body, params);
        // [L1 var hoist] 须在共享局部 TDZ 预建之前:var 绑=undefined;随后 prebox
        // 只补 let/const(已有槽的 var 跳过)。
        this.emitHoistedVarInits(expr.body);

        // [L2-②] 前向引用共享局部预绑定:函数体内声明、且被嵌套闭包捕获的局部
        // (analyzeSharedVariables 已并入 innerBoxedVars),若闭包在声明**之前**创建
        // (`const onEvent=()=>onError; const onError=…`,事件发射器 once 包装等),须在
        // 函数入口先把槽分配好并预建 box(初值=TDZ 哨兵),使早期闭包捕获到同一个 box。
        // 此前仅预分配失败 → 闭包捕获不到该名 → 体里读它落 compileIdentifier 兜底 0
        // (自 L2-② 起抛 ReferenceError,直接崩事件回调)。顶层共享变量走 mainCapturedVars
        // 全局 box(_main 序言已预建),不受此影响;这里只补**局部**共享变量的同名缺口。
        this.ctx.preboxedVars = this.ctx.preboxedVars || new Set();
        if (innerBoxedVars && innerBoxedVars.size > 0) {
            const bodyLocals = {};
            collectLocalDeclarations(expr.body, bodyLocals);
            collectDirectFunctionDeclNames(expr.body, bodyLocals);
            for (const nm in bodyLocals) {
                if (bodyLocals[nm] !== true) continue;
                if (!innerBoxedVars.has(nm)) continue;
                if (this.ctx.getLocal(nm)) continue; // 参数/已捕获外层变量 / 已 hoist 的 var
                const off = this.ctx.allocLocal(nm);
                vm.call("_box_alloc");
                vm.movImm64(VReg.V1, TDZ_SENTINEL);
                vm.store(VReg.RET, 0, VReg.V1);
                vm.store(VReg.FP, off, VReg.RET);
                this.ctx.preboxedVars.add(nm);
            }
        }

        // [ES5.1 10.5 / Annex B] 函数体**直接子级** FunctionDeclaration 入口预绑定(hoist):
        // `function f(){ return g(); function g(){...} }`、S13_A19_T2(var 不覆盖 fn 声明)。
        // 声明语句位变 no-op(体循环按 _preboundFnDecls 跳过)。**必须在 prebox 之后**:
        // 被嵌套闭包捕获的 fn 名已预建 box(compileNestedFunctionDeclaration 复用同一
        // box,前向闭包捕获不失效);且 var 初始化(emitHoistedVarInits)见已有槽即跳过。
        // 单循环无嵌套(规避 P1 录制器对嵌套循环发射的重放问题)。
        if (expr.body.type === "BlockStatement") {
            for (let fi = 0; fi < expr.body.body.length; fi++) {
                const fd = expr.body.body[fi];
                if (fd && fd.type === "FunctionDeclaration" && fd.id && fd.id.name) {
                    this.compileNestedFunctionDeclaration(fd);
                    this.ctx._preboundFnDecls.add(fd.id.name);
                }
            }
        }

        // 编译函数体
        let hasImplicitReturn = false;
        if (expr.body.type === "BlockStatement") {
            this.emitTdzBlockPrologue(expr.body);
            for (const stmt of expr.body.body) {
                // [ES5.1 10.5] 入口已预绑定的直接子级函数声明 → 语句 no-op。
                // 嵌套块内的声明不受影响(仍就地绑定,Annex B 块级语义)。
                if (stmt && stmt.type === "FunctionDeclaration" && stmt.id && stmt.id.name &&
                    this.ctx._preboundFnDecls.has(stmt.id.name)) continue;
                this.compileStatement(stmt);
            }
        } else {
            // 箭头函数表达式体 - 隐式返回（concise body 是尾位置）
            this._markTailCalls(expr.body);
            this.compileExpression(expr.body);
            hasImplicitReturn = true;
        }
        if (_traceClass) console.log("CFB_STMTS_DONE", expr && expr.type);

        // 函数体自然落底(无显式 return):返回真正的 undefined(0x7FFB),而非裸 int 0
        // ——与 FunctionDeclaration / 显式 `return;` 对齐。此前 function 表达式落 0,
        // 令 `String({valueOf:function(){},toString:void 0})` 误走 ToPrimitive TypeError
        // (valueOf 成功但 RET=0 被当成「无 valueOf」),以及 o.m()===0 等假值混淆。
        if (!hasImplicitReturn) {
            vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        }
        vm.label(returnLabel);
        if (isAsync && !isGenerator) {
            this.emitAsyncResolveAndReturnFromRet();
            // 未捕获异常落点:reject 关联 Promise(只在 return/resolve 路径 epilogue 之后,
            // 经跳转到达)。
            vm.label(asyncRejectLabel);
            this.emitAsyncRejectFromException();
        } else {
            // 普通函数 / 生成器 / async generator:epilogue 返回。
            // (生成器/async-gen 体经 _coroutine_entry 捕获返回 → _coroutine_return 置 COMPLETED。)
            vm.epilogue(savedRegs, 16384);
        }
        vm.endRecord(this.ctx._pinnedFpOffs);
        if (_traceClass) console.log("CFB_EPILOGUE_DONE", expr && expr.type);

        this.ctx.locals = prevLocals;
        this.ctx._fnFrameSize = prevFnFrameSize;
        this.ctx._engineLocalNames = prevEngineLocalNames;
        this.ctx._engineLocalOffsets = prevEngineLocalOffsets;
        this.ctx._localsUndo = prevLocalsUndo;
        this.ctx.stackOffset = prevStackOffset;
        this.ctx.returnLabel = prevReturnLabel;
        this.ctx.boxedVars = prevBoxedVars;
        this.ctx.rawFloatVars = prevRawFloatVars;
        this.ctx.inAsyncFunction = prevInAsyncFunction;
        this.ctx.inAsyncGenerator = prevInAsyncGenerator;
        this.ctx.inCoroBody = prevInCoroBody;
        this.ctx.inStrictFunction = prevInStrictFunction;
        this.ctx._isArrowFunction = prevIsArrowFunction;
        this.ctx.currentFnName = prevCurrentFnName;
        this.ctx.immutableLocals = prevImmutableLocals;
        this.ctx.classNameBindings = prevClassNameBindings;
        this.ctx.fnExprNameSlot = prevFnExprNameSlot;
        this.ctx.superCalledOff = prevSuperCalledOff;
        this.ctx.withScopes = prevWithScopes;
        this.ctx.outerWithScopes = prevOuterWithScopes;
        this.ctx._inFunctionBody = prevInFunctionBody;
        this.ctx.lexLocalNames = prevLexLocalNames;
        this.ctx.letConstClassNames = prevLetConstClassNames;
        this.ctx.paramBindingNames = prevParamBindingNames;
        this.ctx.ownBindingNames = prevOwnBindingNames;
        this.ctx.bodyEvalVarNames = prevBodyEvalVarNames;
        this.ctx._tdzClearedLocals = prevTdzCleared;
        this.ctx.exceptionLabel = prevExceptionLabel;
        this.ctx._asyncExcFrameOff = prevAsyncExcFrameOff;
        this.ctx._asyncCoroOff = prevAsyncCoroOff;
        this.ctx._asyncPromiseOff = prevAsyncPromiseOff;
        this.ctx._preboundFnDecls = prevPreboundFnDecls;
        this.ctx._argRegSpill = prevArgRegSpill;
        this.ctx._pinnedFpOffs = prevPinnedFpOffs;
        this.ctx._esPool = prevEsPool;
        this.ctx._esDepth = prevEsDepth;
        this.ctx._objTmpSlots = prevObjTmpSlots;
        this.ctx._objTmpDepth = prevObjTmpDepth;
        this.ctx._arrTmpSlots = prevArrTmpSlots;
        this.ctx._arrTmpDepth = prevArrTmpDepth;
        this.ctx.localTemps = prevLocalTemps;
    },

    // 具名函数表达式 BindingIdentifier:CreateImmutableBinding,初值=本闭包(S0)。
    // 形参/var 同名会 allocLocal 覆盖槽,写走新槽;不可变只约束 fnExprNameSlot。
    emitNamedFunctionExprBinding(expr, forceBox) {
        if (!expr || expr.type !== "FunctionExpression" || !expr.id || !expr.id.name) return;
        const nm = expr.id.name;
        const offset = this.ctx.allocLocal(nm);
        this.ctx.fnExprNameSlot = offset;
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.call("_js_box_function");
        const boxIt = forceBox || (this.ctx.boxedVars && this.ctx.boxedVars.has(nm));
        if (boxIt) {
            if (this.ctx.boxedVars) this.ctx.boxedVars.add(nm);
            const nfeH = this._holdExpr(VReg.RET);
            this.vm.call("_box_alloc");
            this._loadHeldExpr(nfeH, VReg.V1);
            this._releaseHeldExpr();
            this.vm.store(VReg.RET, 0, VReg.V1);
            this.vm.store(VReg.FP, offset, VReg.RET);
        } else {
            this.vm.store(VReg.FP, offset, VReg.RET);
        }
    },
};

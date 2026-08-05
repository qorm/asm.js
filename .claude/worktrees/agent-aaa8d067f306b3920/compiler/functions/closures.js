// asm.js 编译器 - 闭包编译
// 编译函数表达式、闭包、函数体

import { VReg } from "../../vm/index.js";
import { analyzeCapturedVariables, analyzeSharedVariables, analyzeDirectEvalBoxedVars } from "../../lang/analysis/closure.js";
import { ASYNC_CLOSURE_MAGIC, isAsyncFunction, isGeneratorFunction } from "../async/index.js";

// 闭包魔数 - 用于区分普通函数指针和闭包对象
const CLOSURE_MAGIC = 0xc105;

// 闭包编译方法混入
export const ClosureCompiler = {
    // 剩余参数 ...rest：把 A_pos..A4 中非 undefined 的实参收集为数组存入 rest 局部。
    // A5 保留给 this（方法约定），故最多收 5 个。遇 undefined 停止（未提供实参已被
    // 调用方填 JS_UNDEFINED）。用于 scratchReg(...regs) 等。
    emitRestParam(restName, pos) {
        const vm = this.vm;
        const restOff = this.ctx.allocLocal(restName);
        const saved = [];
        for (let k = pos; k <= 4; k++) {
            const so = this.ctx.allocLocal(`__rest_a_${pos}_${k}`);
            vm.store(VReg.FP, so, vm.getArgReg(k));
            saved.push(so);
        }
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r"); // box->helper
        vm.store(VReg.FP, restOff, VReg.RET);
        const done = this.ctx.newLabel("rest_done");
        for (let k = 0; k < saved.length; k++) {
            vm.load(VReg.V0, VReg.FP, saved[k]);
            vm.movImm64(VReg.V1, 0x7ffb000000000000n); // JS_UNDEFINED
            vm.cmp(VReg.V0, VReg.V1);
            vm.jeq(done);
            vm.load(VReg.A0, VReg.FP, restOff);
            vm.mov(VReg.A1, VReg.V0);
            vm.call("_array_push");
            vm.store(VReg.FP, restOff, VReg.RET);
        }
        vm.label(done);
    },

    // 编译函数表达式
    // 检测函数体是否引用 this（决定箭头是否需要捕获外层 this）
    functionBodyUsesThis(expr) {
        const seen = new Set();
        const walk = (node) => {
            if (!node || typeof node !== "object") return false;
            if (Array.isArray(node)) { for (const n of node) if (walk(n)) return true; return false; }
            if (node.type === "ThisExpression") return true;
            // 不下钻嵌套的普通函数（它们有自己的 this）；箭头函数继续下钻
            if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return false;
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
                const v = node[k];
                if (v && typeof v === "object") { if (walk(v)) return true; }
            }
            return false;
        };
        return walk(expr.body);
    },

    // 函数体是否把 `arguments` 当值引用(非 obj.arguments 属性/对象字面量键)。
    // 不下钻嵌套普通函数(它们有各自的 arguments);箭头继续下钻(共享外层 arguments)。
    functionBodyUsesArguments(expr) {
        const walk = (node) => {
            if (!node || typeof node !== "object") return false;
            if (Array.isArray(node)) { for (const n of node) if (walk(n)) return true; return false; }
            if (node.type === "Identifier" && node.name === "arguments") return true;
            if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return false;
            for (const k in node) {
                if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
                // obj.arguments 的属性名 / {arguments:...} 的键名不是引用
                if (node.type === "MemberExpression" && k === "property" && !node.computed) continue;
                if (node.type === "Property" && k === "key" && !node.computed) continue;
                const v = node[k];
                if (v && typeof v === "object") { if (walk(v)) return true; }
            }
            return false;
        };
        return walk(expr.body);
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
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.FP, argcOff, VReg.V0);
        const saved = [];
        for (let k = 0; k <= 4; k++) {
            const so = this.ctx.allocLocal(`__args_a_${k}`);
            vm.store(VReg.FP, so, vm.getArgReg(k));
            saved.push(so);
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
        for (let k = 0; k <= 4; k++) {
            vm.load(vm.getArgReg(k), VReg.FP, saved[k]);
        }
    },

    compileFunctionExpression(expr) {
        const outerLocals = this.ctx.locals || {};
        const outerBoxedVars = this.ctx.boxedVars || new Set();
        let captured = analyzeCapturedVariables(expr, outerLocals, this.ctx.functions);
        // **仅箭头函数**捕获外层 this（使 () => this.x 访问词法 this）。普通函数表达式/
        // 对象字面量简写方法(`{ m(){ this.x } }`)是普通函数,应取**动态** this(A5 接收者,
        // 序言已置 __this=A5);此前误对所有用 this 的函数表达式捕获 → 函数内创建的对象字面量
        // 方法(如工厂 `function make(v){return {i:v,read(){return this.i}}}`)拿到词法/陈旧
        // this 而非接收者(手写迭代器 `{next(){return this.i}}` 静默错的根因)。模块级 mixin
        // 方法无外层 __this,本就不捕获,故编译器自身逐字节不变。
        const outerHasThis = !!outerLocals["__this"];
        const capturesThis = outerHasThis && expr.type === "ArrowFunctionExpression" &&
            this.functionBodyUsesThis(expr);
        if (capturesThis && captured.indexOf("__this") === -1) {
            captured = captured.concat(["__this"]);
        }

        const funcLabel = this.ctx.newLabel("fn");
        const isAsync = isAsyncFunction(expr);
        // async(含 async generator)闭包一律用普通 CLOSURE_MAGIC:标签处的 async stub
        // (emitAsyncMethodStub / emitAsyncGeneratorStub)建协程+Promise,compileClosureCall
        // 与 compileMethodCall 的普通闭包路径都会调到 stub(方法调用经 A5 传 this)。
        // 不再用 ASYNC_CLOSURE_MAGIC(那条 call-site 内联建协程路径只覆盖 f() 不覆盖 obj.f())。
        const isAsyncClosureMagic = false;

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
        this.vm.push(VReg.RET);

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
            const offset = outerLocals[varName];
            if (offset) {
                // 闭包指针在栈顶，弹出保存到 V3（因为 _alloc 会 clobber V1, V2）
                this.vm.pop(VReg.V3);  // V3 = closure pointer

                // [#63] 外部变量已经装箱：该 box 就是绑定的唯一真身(可能同时被
                // 顶层函数经 _main_captured_ 全局 box、以及先前创建的其它闭包共享)。
                // 必须把**既有 box 指针**直接存进闭包槽以共享同一 box——绝不能
                // 另 _box_alloc 造新 box 并重指 FP 槽:那会让 FP 槽/新闭包指向新 box,
                // 而全局 label box 与更早创建的闭包仍指向旧 box → 之后对该变量的
                // 重赋值(写 FP 槽的 box)只更新新 box,旧 box 持有者(如顶层函数实参
                // 求值里的副作用)读到陈旧值(#63:obj.m(arg(1),arg(2)) 丢 a1/a2)。
                // __this 不是 box,走下面的新建 box 路径。
                if (outerBoxedVars.has(varName) && varName !== "__this") {
                    this.vm.load(VReg.V1, VReg.FP, offset);        // V1 = 既有 box 指针
                    this.vm.store(VReg.V3, 16 + i * 8, VReg.V1);   // 闭包槽 = 共享既有 box
                    this.vm.push(VReg.V3);                         // 闭包指针压回,供下轮/后续
                    continue;
                }

                // 到此仅剩两类：__this(外层直接存值,非 box)、以及尚未装箱的外层变量
                // (首次装箱)。二者都取外层槽的原始值,下面新建 box 包裹。
                this.vm.load(VReg.V1, VReg.FP, offset);  // V1 = 原始值

                // 保存值和闭包指针到栈上（_alloc 会 clobber V0, V1, V2）
                this.vm.push(VReg.V1);  // 保存值
                this.vm.push(VReg.V3);  // 保存闭包指针

                // 创建新 box
                this.vm.call("_box_alloc");  // RET = new box pointer(分配+登记,分代 minor 根)

                // 恢复闭包指针和值（逆序弹出）
                this.vm.pop(VReg.V2);  // V2 = 闭包指针
                this.vm.pop(VReg.V1);  // V1 = 值

                // 将值存入新 box (V1 = value, RET = box pointer)
                this.vm.store(VReg.RET, 0, VReg.V1);  // [RET] = value

                // 将 box 指针存入闭包 (V2 = closure, RET = box)
                this.vm.store(VReg.V2, 16 + i * 8, VReg.RET);  // [V2 + offset] = box

                // 将闭包指针重新压栈（供下次迭代或后续使用）
                this.vm.push(VReg.V2);
            }
        }

        this.vm.pop(VReg.RET);

        // 将原始指针装箱为 JSValue 函数
        // JSValue = (ptr & 0x0000ffffffffffff) | 0x7fff000000000000
        this.vm.mov(VReg.V2, VReg.RET);  // V2 = 原始指针副本
        this.vm.emitMaskLoad(VReg.V1);  // V1 = MASK
        this.vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1);  // V2 = V2 & V1 = ptr & MASK
        this.vm.movImm64(VReg.V1, 0x7fff000000000000n);  // V1 = TAG (function)
        this.vm.or(VReg.RET, VReg.V2, VReg.V1);  // RET = (ptr & MASK) | TAG

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
        });
    },

    // 生成待处理的函数体
    generatePendingFunctions() {
        if (!this.pendingFunctions || this.pendingFunctions.length === 0) {
            return;
        }

        for (const func of this.pendingFunctions) {
            this.vm.label(func.label);
            // [函数元数据] func.label 即闭包 func_ptr(见 compileFunctionExpression 存 +8)。
            // 登记函数种类(async/generator),供 Object.prototype.toString 品牌区分。
            this.registerFuncMeta(func.label, func.expr);
            // [批次D] 生成器函数表达式：标签处先落 stub（建协程+生成器对象后即返回），
            // 真正函数体在 <label>_gbody，由 _coroutine_entry 首次 resume 时进入。
            if (isGeneratorFunction(func.expr) && !isAsyncFunction(func.expr)) {
                this.emitGeneratorStub(func.label + "_gbody", true);
            } else if (isGeneratorFunction(func.expr) && isAsyncFunction(func.expr)) {
                // async function*：async 生成器 stub(构造器 _async_generator_new)
                this.emitAsyncGeneratorStub(func.label + "_gbody", true);
            } else if (isAsyncFunction(func.expr)) {
                // async 函数/方法(表达式):标签处落 async stub(建协程+Promise 返回),真体在
                // _gbody。闭包用 CLOSURE_MAGIC(见下),故 compileClosureCall/compileMethodCall
                // 的普通闭包路径都会调到本 stub(方法调用经 A5 传 this → CORO_THIS),统一。
                this.emitAsyncMethodStub(func.label + "_gbody", true);
            }
            // 恢复定义处的模块上下文，使函数体内 namespace/import 标识符正确解析
            const savedModuleAst = this._currentModuleAst;
            const savedMCV = this.ctx.mainCapturedVars;
            const savedFA = this.ctx.functionAliases;
            const savedSP = this.sourcePath;
            if (func.moduleAst) this._currentModuleAst = func.moduleAst;
            if (func.mainCapturedVars) this.ctx.mainCapturedVars = func.mainCapturedVars;
            if (func.functionAliases) this.ctx.functionAliases = func.functionAliases;
            if (func.sourcePath) this.sourcePath = func.sourcePath;
            this.compileFunctionBody(func.expr, func.captured);
            this._currentModuleAst = savedModuleAst;
            this.ctx.mainCapturedVars = savedMCV;
            this.ctx.functionAliases = savedFA;
            this.sourcePath = savedSP;
        }

        this.pendingFunctions = [];
    },

    // 编译函数体
    compileFunctionBody(expr, captured) {
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
        if (!isAsync && !isGenerator) vm.beginRecord();
        vm.prologue(8192, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        const prevLocals = this.ctx.locals;
        const prevStackOffset = this.ctx.stackOffset;
        const prevReturnLabel = this.ctx.returnLabel;
        const prevBoxedVars = this.ctx.boxedVars;
        const prevInAsyncFunction = this.ctx.inAsyncFunction;
        const prevInAsyncGenerator = this.ctx.inAsyncGenerator;
        const prevInCoroBody = this.ctx.inCoroBody;

        this.ctx.locals = {};
        this.ctx.stackOffset = 0;
        this.ctx.inAsyncFunction = isAsync;
        this.ctx.inAsyncGenerator = isAsync && isGenerator;
        this.ctx.inCoroBody = isGenerator; // [gen unwind] 生成器体(含 async gen)跑协程栈

        // 分析函数体中哪些变量会被内部闭包捕获
        const innerBoxedVars = analyzeSharedVariables(expr);
        // [引擎库·直接 eval 逃逸捕获] 含直接 eval 的(嵌套)函数:全部局部升级为 box。
        for (const _n of analyzeDirectEvalBoxedVars(expr)) innerBoxedVars.add(_n);
        this.ctx.boxedVars = innerBoxedVars;

        const returnLabel = this.ctx.newLabel("fn_return");
        this.ctx.returnLabel = returnLabel;

        // async 函数体:未捕获异常拒绝其 Promise(而非退出)。设一个"外层"异常标签,
        // throw/await-reject 在无更内层 try 时跳此 → reject。save/restore 保护外层上下文。
        const prevExceptionLabel = this.ctx.exceptionLabel;
        let asyncRejectLabel = null;
        // async generator 体走协程/生成器返回流(非 Promise resolve),不设 async_reject 落点。
        if (isAsync && !isGenerator) {
            asyncRejectLabel = this.ctx.newLabel("async_reject");
            this.ctx.exceptionLabel = asyncRejectLabel;
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
        if (usesArguments) {
            this.emitArgumentsArray();
        }

        // 处理参数 - 先保存所有参数到栈（因为后续操作可能破坏参数寄存器）
        // 注意：先保存参数，再处理闭包捕获变量，避免寄存器冲突
        const paramOffsets = [];
        const patternParams = [];
        for (let i = 0; i < params.length && i < 6; i++) {
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
                const pat = p.type === "AssignmentPattern" ? p.left : p;
                const dexpr = p.type === "AssignmentPattern" ? p.right : null;
                const pslot = this.ctx.allocLocal(`__parampat_${this.nextLabelId()}`);
                vm.store(VReg.FP, pslot, vm.getArgReg(i));
                patternParams.push({ pat: pat, slot: pslot, dflt: dexpr });
                continue;
            }
            if (!paramName) continue;
            const offset = this.ctx.allocLocal(paramName);
            paramOffsets.push({ name: paramName, offset: offset, argReg: vm.getArgReg(i) });
            vm.store(VReg.FP, offset, vm.getArgReg(i));
            if (defaultExpr) {
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
                this.compileExpression(defaultExpr);
                vm.store(VReg.FP, offset, VReg.RET);
                vm.label(skip);
            }
        }

        // 保存 this 指针（通过 A5 传入的隐藏参数）到 __this 局部变量
        const thisOffset = this.ctx.allocLocal("__this");
        vm.store(VReg.FP, thisOffset, VReg.A5);

        // 处理闭包捕获变量 - 从闭包对象中加载 box 指针
        // S0 寄存器包含闭包对象指针（由 compileClosureCall 传入）
        // 闭包对象布局: [magic(8), func_ptr(8), box_ptr_0, box_ptr_1, ...]
        if (captured && captured.length > 0) {
            // 将闭包指针保存到 S1，因为 S0 可能在函数体中被覆盖
            vm.mov(VReg.S1, VReg.S0);

            for (let i = 0; i < captured.length; i++) {
                const varName = captured[i];
                const closureOffset = 16 + i * 8; // 跳过 magic 和 func_ptr
                if (varName === "__this") {
                    // __this：闭包 slot 存的是 box 指针（存储侧统一 box 化），
                    // 解引用得到 this 值，恢复到已有 __this 槽（覆盖 A5 垃圾）
                    vm.load(VReg.V1, VReg.S1, closureOffset); // box 指针
                    vm.load(VReg.V1, VReg.V1, 0);             // this 值
                    const thisOff = this.ctx.getLocal("__this");
                    vm.store(VReg.FP, thisOff, VReg.V1);
                    continue;
                }
                // 从闭包对象加载 box 指针到新的局部变量
                const offset = this.ctx.allocLocal(varName);
                vm.load(VReg.V1, VReg.S1, closureOffset); // 加载 box 指针
                vm.store(VReg.FP, offset, VReg.V1); // 存储 box 指针

                // 标记这个变量为装箱变量（因为它存储的是 box 指针）
                this.ctx.boxedVars.add(varName);
            }
        }

        // 为需要装箱的参数创建 box
        for (let i = 0; i < paramOffsets.length; i++) {
            const param = paramOffsets[i];
            if (innerBoxedVars.has(param.name)) {
                // 从栈中加载参数值
                vm.load(VReg.V1, VReg.FP, param.offset);
                vm.push(VReg.V1); // 保存参数值

                // 创建 box
                vm.call("_box_alloc"); // 分配+登记(分代 minor 根)
                vm.store(VReg.FP, param.offset, VReg.RET); // 存储 box 指针

                vm.pop(VReg.V1); // 恢复参数值
                vm.store(VReg.RET, 0, VReg.V1); // 存入 box
            }
        }

        // [#47] 解构参数:所有实参已落栈,此处安全解构到局部。
        for (let i = 0; i < patternParams.length; i++) {
            this.emitParamDestructure(patternParams[i].pat, patternParams[i].slot, patternParams[i].dflt);
        }

        // 编译函数体
        let hasImplicitReturn = false;
        if (expr.body.type === "BlockStatement") {
            for (const stmt of expr.body.body) {
                this.compileStatement(stmt);
            }
        } else {
            // 箭头函数表达式体 - 隐式返回
            this.compileExpression(expr.body);
            hasImplicitReturn = true;
        }

        // 默认返回 0（只有没有隐式返回时）
        if (!hasImplicitReturn) {
            vm.movImm(VReg.RET, 0);
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
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
        vm.endRecord(); // [P1]
        }

        this.ctx.locals = prevLocals;
        this.ctx.stackOffset = prevStackOffset;
        this.ctx.returnLabel = prevReturnLabel;
        this.ctx.boxedVars = prevBoxedVars;
        this.ctx.inAsyncFunction = prevInAsyncFunction;
        this.ctx.inAsyncGenerator = prevInAsyncGenerator;
        this.ctx.inCoroBody = prevInCoroBody;
        this.ctx.exceptionLabel = prevExceptionLabel;
    },
};

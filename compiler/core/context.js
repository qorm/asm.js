// asm.js 编译上下文
// 管理变量、标签、作用域和函数

import { Type } from "./types.js";

// 用户函数 prologue 统一保存 S0-S3 两对寄存器，占用 [FP-32, FP)。
// 局部变量必须从该保存区下方开始分配，否则会覆盖保存的 callee-saved
// 寄存器，导致调用者的 S0-S3 在函数返回后被腐蚀。
// 48 = 6 寄存器槽:缺省只压 S0-S3(32B,高 16B 为无害填充);P1 槽位提升的
// 函数把保存列表扩为 [S0..S4, 对齐垫],恰好填满 —— 局部区偏移全局不变。
// 对齐垫按 arch 选:arm64 用 V0(X8,与 RET 独立);x64 用 V5(R10)——
// x64 V0==RAX==RET,若作垫会在 epilogue 把返回值冲掉(#37 根因)。
export const CALLEE_SAVED_AREA = 48;

// gen1 下 `new Map(iterable)` 经 Get(Map.prototype,"set") 取 adder——原型方法属性
// 加载常得 undefined → "Map.prototype.set is not a function"。空 new Map + for-of set 安全。
export function copyMap(src) {
    const out = new Map();
    if (src) {
        for (const e of src) out.set(e[0], e[1]);
    }
    return out;
}

export class CompileContext {
    constructor(funcName) {
        this.funcName = funcName || "main";
        this.locals = new Map(); // 动态键 O(1);{} 在 gen1 走线性 _object_get
        this.varTypes = {}; // 小字典;Map 常数开销在 gen1 上更贵(实测)
        // [解箱①] 循环内被证明为裸 int 驻留的 induction 变量:slot 存裸 int(非
        // float64 位/0x7FF8),读写走整数路径免 _to_int32/fmov;仅在安全 for 循环
        // 体内有效,循环出口物化回 float64。见 unboxing-int-residency-design 记忆。
        this.rawIntVars = {}; // 变量名 -> true
        // [P3.1] 函数级证明恒持 raw float64 的非参数非装箱局部。Identifier 作
        // 算术操作数时跳过恒等 coerce。与 boxedVars 同位分析,见 lang/analysis/rawfloat.js。
        this.rawFloatVars = {}; // 变量名 -> true
        // [解箱① P4.1] 循环内浮点累加器驻留 caller-saved FP 寄存器(d2+)的变量:
        // 仅在 call-free 循环体内有效(caller-saved FP 跨迭代存活、body 无 call 不被腐蚀);
        // 名 -> FP 寄存器号;`s=s<op>E` 直发 f<op> d_reg,d_reg,d_tmp,免 slot 往返/coerce
        // 守卫/操作数压栈。循环出口物化回 slot。见 unboxing-int-residency-design 记忆。
        this.fpAccumVars = {}; // 变量名 -> FP 寄存器号(>0)
        this.varInitExprs = {}; // 变量名 -> 初始化表达式 AST（用于类型推断）
        this.stackOffset = 0; // 当前栈偏移
        this.labelCounter = 0; // 标签计数器
        this.returnLabel = ""; // 当前函数的返回标签
        this.functions = {}; // 函数声明: 符号名 -> AST 节点(Map 在 gen1 上常数税更重,实测慢于 {})
        this.functionAliases = {}; // 当前编译单元中的函数别名: 本地名 -> 符号名
        this.isAsync = false; // 是否是异步函数
        // User-function local frame size (bytes) allocated by prologue().
        // emitAsyncResolve/Reject must restore the same amount; compileFunction
        // uses 32768 while compileFunctionBody uses 16384.
        this._fnFrameSize = 0;

        // 使用函数名作为标签前缀，避免跨函数标签冲突
        this.labelPrefix = this.funcName + "_";

        // 全局变量支持
        this.globals = {}; // 全局变量名 -> 数据段标签名
        this.globalOffset = 0; // 下一个全局变量的偏移

        // 主程序被捕获的变量（被顶层函数访问）
        // 变量名 -> 全局标签名（存储 box 指针的位置）
        this.mainCapturedVars = {};

        // 共享变量支持 (闭包)
        this.sharedVars = null; // 共享变量 -> 环境对象偏移
        this.envOffset = null; // 环境对象在栈上的偏移
        this.envPtrOffset = null; // 闭包中环境指针的偏移

        // 作用域深度
        this.scopeDepth = 0;

        // 循环控制
        this.breakLabel = null; // break 目标标签
        this.continueLabel = null; // continue 目标标签

        // [#38] 异常上下文帧:tryFrames = 当前词法活动 try 的帧基址(FP 偏移)栈;
        // breakTryLen/continueTryLen = break/continue 目标边界处的 tryFrames 深度,
        // 跳转跨出 try 时按此恢复 _exc_ctx_top(见 emitExcCtxRestore)
        this.tryFrames = null;
        this.breakTryLen = 0;
        this.continueTryLen = 0;
        // [iterator-close] 协议 for-of 活迭代器栈;break/continue 目标处的栈深快照
        this.iterCloseStack = null;
        this.breakIterCloseLen = 0;
        this.continueIterCloseLen = 0;

        // [#60] 标签语句支持:
        // labelMap = Map<labelName, {breakLabel, continueLabel, breakTryLen, continueTryLen}>
        //   —— 用 Map 而非 {} 以规避用户标签名(如 __proto__/constructor)污染原型链([#32])。
        // pendingLabels = 紧邻其后语句待登记的标签名数组(compileLabeledStatement 压入,
        //   随后的循环/块消费)。
        this.labelMap = null;
        this.pendingLabels = null;

        // 用户函数 LSRA:局部名 → T*(与 spill home 同槽)。raVm 在 beginRecord 期间挂上。
        this.raVm = null;
        this.localTemps = null;
        // 表达式左值暂存栈:嵌套 `a+(b+c)` 按深度复用,不每算子 allocLocal。
        this._esPool = null;
        this._esDepth = 0;
        // Per-function object/array literal FP temps. Offsets are frame-local;
        // leaking them across compileFunction / compileFunctionBody reuses the
        // previous function's slot (second `{ get x(){} }` SIGSEGV).
        this._objTmpSlots = null;
        this._objTmpDepth = 0;
        this._arrTmpSlots = null;
        this._arrTmpDepth = 0;
        // Engine fragments run inside the self-hosted x64 compiler. Its compact
        // Map can lose equal string keys, so fragments opt into a tiny
        // content-based side table for local bindings. Normal AOT contexts keep
        // this disabled (null) and retain the O(1) Map-only path.
        this._engineLocalNames = null;
        this._engineLocalOffsets = null;
    }

    // 兼容旧接口
    get name() {
        return this.funcName;
    }

    // 设置标签前缀
    setLabelPrefix(prefix) {
        this.labelPrefix = prefix;
    }

    // 生成唯一标签
    newLabel(prefix) {
        this.labelCounter = this.labelCounter + 1;
        return this.labelPrefix + prefix + "_" + this.labelCounter;
    }

    // 分配全局变量（存储在数据段）
    allocGlobal(name) {
        let label = "_global_" + name;
        this.globals[name] = label;
        return label;
    }

    // 获取全局变量标签
    // [#32] 双语义守卫:合法标签恒为字符串(见 getLocal 注释)
    getGlobal(name) {
        const g = this.globals[name];
        if (g && typeof g !== "string") return undefined;
        return g;
    }

    // 注册主程序被捕获变量的全局存储位置
    allocMainCapturedVar(name) {
        let label = "_main_captured_" + name;
        this.mainCapturedVars[name] = label;
        return label;
    }

    // 获取主程序被捕获变量的全局标签
    getMainCapturedVar(name) {
        // [#32] locals/mainCapturedVars 是普通 {} 字典:node 语义下用户标识符
        // constructor/toString/valueOf 等会命中 Object.prototype(truthy 的函数),
        // asm.js 语义只查自有属性返回 falsy —— 二者分歧曾让 gen1 跳过槽位分配,
        // 错编 compileClassDeclaration(gen1/gen2 全部 2.6MB 差异的单点根因)。
        // 守卫:合法值恒为字符串/数值,非常规类型一律视为未定义。
        const mcv = this.mainCapturedVars[name];
        if (mcv && typeof mcv !== "string") return undefined;
        return mcv;
    }

    // 模块顶层 var 提升必须复用 _main 预建的全局 box。否则早建闭包
    // (`var f=()=>n; var n=0`)捕获 hoist 新建的局部 box,而声明初始化
    // 走 compileVariableDeclaration 的 globalLabel 切到全局 box → 双 box
    // 分叉(闭包读创建时快照,外层读声明值)。仅模块主帧可复用:嵌套函数体
    // 与用户函数 ctx 若复用,内层同名 var 会误别名到模块捕获槽。
    shouldReuseMainCapturedBox() {
        return this._isModuleMain === true && this._inFunctionBody !== true;
    }

    // 分配局部变量（带类型）
    allocLocal(name, type = Type.UNKNOWN) {
        this.stackOffset = this.stackOffset + 8;
        const off = -CALLEE_SAVED_AREA - this.stackOffset;
        if (this._localsUndo && this._localsUndo.length > 0) {
            const frame = this._localsUndo[this._localsUndo.length - 1];
            // 每名每层只记一次:首次写入的旧值(或 undefined=新增)
            let seen = false;
            for (let i = 0; i < frame.length; i++) {
                if (frame[i][0] === name) { seen = true; break; }
            }
            if (!seen) {
                // Map.get miss ≡ undefined，免再 has
                frame.push([name, this.locals.get(name)]);
            }
        }
        this.locals.set(name, off);
        if (this._engineLocalNames && this._engineLocalOffsets) {
            this._engineLocalNames.push(name);
            this._engineLocalOffsets.push(off);
        }
        this.varTypes[name] = type;
        // 录制中 / 在线 RA 为普通局部绑 T*(跳过 __ 合成名);装箱/裸 int 读路径仍走 FP,忽略 T*。
        // 形参同样绑 T*:LSRA 用 mention∪CFG 活区间,跨 call 着 callee-saved S,
        // call-free 着 caller-saved V(与 LLVM virtreg 一致)。关:RA_NO_TEMP=1
        if (!(typeof process !== "undefined" && process.env && process.env.RA_NO_TEMP) &&
            this.raVm && (this.raVm._raOnline || this.raVm._recN >= 0) && name &&
            !(name.length >= 2 && name.charCodeAt(0) === 95 && name.charCodeAt(1) === 95)) {
            const t = this.raVm.newTemp(off);
            if (t) {
                if (!this.localTemps) this.localTemps = new Map();
                this.localTemps.set(name, t);
            }
        }
        return off;
    }

    // 匿名表达式暂存:录制期绑 T*(只经 mov,flush 走 _emitTempMov,不漏进 backend)。
    // 与局部同 spill home;LSRA 跨 call 着 S,call-free 着 V。
    allocScratchSlot() {
        this.stackOffset = this.stackOffset + 8;
        const off = -CALLEE_SAVED_AREA - this.stackOffset;
        let tmp = null;
        if (!(typeof process !== "undefined" && process.env && process.env.RA_NO_TEMP) &&
            this.raVm && (this.raVm._raOnline || this.raVm._recN >= 0)) {
            tmp = this.raVm.newTemp(off) || null;
        }
        return { off: off, tmp: tmp };
    }

    pushExprScratch() {
        if (!this._esPool) this._esPool = [];
        const i = this._esDepth;
        this._esDepth = i + 1;
        if (i >= this._esPool.length) {
            this._esPool.push(this.allocScratchSlot());
            return this._esPool[i];
        }
        const s = this._esPool[i];
        // Pool objects outlive beginRecord/endRecord. A leftover T* has no
        // home after the previous recording and must not reach the backend.
        if (this.raVm && this.raVm._recN >= 0) {
            if (!s.tmp || !this.raVm._tempHomes || this.raVm._tempHomes[s.tmp] === undefined) {
                s.tmp = this.raVm.newTemp(s.off) || null;
            }
        } else {
            s.tmp = null;
        }
        return s;
    }

    popExprScratch() {
        if (this._esDepth > 0) this._esDepth = this._esDepth - 1;
    }

    // 获取局部变量偏移
    // [#32] 双语义守卫:合法偏移恒为数值(负数)。Map miss 为 undefined。
    getLocal(name) {
        const v = this.locals.get(name);
        if (v && typeof v !== "number") return 0;
        // Valid local offsets are strictly negative; a self-hosted Map miss can
        // surface as numeric zero, which must still reach the fallback table.
        if (typeof v === "number" && v < 0) return v;
        // Self-hosted fragment fallback: compare string contents, not object
        // identity, and search backwards to preserve shadowing semantics.
        const names = this._engineLocalNames;
        const offs = this._engineLocalOffsets;
        if (names && offs && typeof name === "string") {
            for (let i = names.length - 1; i >= 0; i--) {
                const a = names[i];
                if (typeof a !== "string" || a.length !== name.length) continue;
                let same = true;
                for (let j = 0; j < name.length; j++) {
                    if (a.charCodeAt(j) !== name.charCodeAt(j)) { same = false; break; }
                }
                if (same) return offs[i];
            }
        }
        return v;
    }

    // 设置变量类型
    setVarType(name, type) {
        this.varTypes[name] = type;
    }

    // 获取变量类型
    // [#32] 双语义守卫:合法类型恒为字符串(见 getLocal 注释)
    getVarType(name) {
        const t = this.varTypes[name];
        if (t && typeof t !== "string") return Type.UNKNOWN;
        return t || Type.UNKNOWN;
    }

    // 检查变量是否是整数类型
    isIntVar(name) {
        const type = this.varTypes[name];
        // Int8-64, Uint8-64 都是整数类型
        // [#32] typeof 守卫:node 下原型链污染值(Function)无 startsWith
        return type && typeof type === "string" && (type.startsWith("int") || type.startsWith("uint"));
    }

    // [解箱①] 是否是裸 int 驻留变量(slot 存裸 int)。守卫同 isIntVar:恒为布尔标记。
    isRawIntVar(name) {
        return this.rawIntVars[name] === true;
    }

    // [P3.1] 槽内恒为 raw float64 位(合法 JS number 形态)。守卫:恒为布尔标记。
    isRawFloatVar(name) {
        const t = this.rawFloatVars;
        return !!(t && t[name] === true);
    }

    // [解箱① P4.1] 返回浮点累加器的 FP 寄存器号(未驻留返 0)。守卫:恒为正整数。
    getFpAccum(name) {
        const r = this.fpAccumVars[name];
        return (typeof r === "number" && r > 0) ? r : 0;
    }

    // 检查变量是否存在（局部或全局）
    // [#32] 经守卫后的访问器,不裸查字典(见 getLocal 注释)
    hasVariable(name) {
        return this.getLocal(name) || this.getGlobal(name);
    }

    // 进入新作用域(O(1)):不拷贝 Map;allocLocal 记 undo,leave 时回滚本层写入。
    enterScope() {
        if (!this._localsUndo) this._localsUndo = [];
        this._localsUndo.push([]);
        this.scopeDepth = (this.scopeDepth || 0) + 1;
        return {
            stackOffset: this.stackOffset,
            scopeDepth: this.scopeDepth - 1,
            breakLabel: this.breakLabel,
            continueLabel: this.continueLabel,
            engineLocalLength: this._engineLocalNames ? this._engineLocalNames.length : 0,
        };
    }

    // 离开作用域:按 undo 回滚本层对 locals 的 set/新增。
    leaveScope(saved) {
        const frame = this._localsUndo && this._localsUndo.length
            ? this._localsUndo.pop()
            : null;
        if (frame) {
            for (let i = frame.length - 1; i >= 0; i--) {
                const e = frame[i];
                if (e[1] === undefined) this.locals.delete(e[0]);
                else this.locals.set(e[0], e[1]);
            }
        }
        this.stackOffset = saved.stackOffset;
        // Scratch / object-literal / array-literal homes are FP slots.
        // Rolling stackOffset back without dropping those pools lets the
        // next push reuse a home that allocLocal just handed to a new
        // binding. `_esPool` used to clobber class-expr method tables;
        // `_objTmpSlots` did the same to shape_ptr@48 (boxed 0x7FFD stored
        // as a raw pointer → Function()/compileFragment SIGSEGV).
        const water = -CALLEE_SAVED_AREA - saved.stackOffset;
        if (this._esDepth === 0) {
            this._esPool = null;
        } else if (this._esPool) {
            let n = 0;
            for (let i = 0; i < this._esPool.length; i = i + 1) {
                const s = this._esPool[i];
                if (s && s.off >= water) {
                    this._esPool[n] = s;
                    n = n + 1;
                }
            }
            this._esPool.length = n;
        }
        this._dropStaleLiteralTemps(water);
        this.scopeDepth = saved.scopeDepth;
        this.breakLabel = saved.breakLabel;
        this.continueLabel = saved.continueLabel;
        if (this._engineLocalNames && this._engineLocalOffsets && saved.engineLocalLength != null) {
            this._engineLocalNames.length = saved.engineLocalLength;
            this._engineLocalOffsets.length = saved.engineLocalLength;
        }
    }

    // 检查当前是否在嵌套作用域中（非顶层）
    isInNestedScope() {
        return (this.scopeDepth || 0) > 0;
    }

    // 设置循环标签
    setLoopLabels(breakLabel, continueLabel) {
        this.breakLabel = breakLabel;
        this.continueLabel = continueLabel;
    }

    // Drop object/array literal FP temps that sit below the live frame.
    // `off >= water` is still in-frame (same rule as `_esPool`).
    _dropStaleLiteralTemps(water) {
        if (this._objTmpDepth === 0) {
            this._objTmpSlots = null;
        } else if (this._objTmpSlots) {
            let n = 0;
            for (let i = 0; i < this._objTmpSlots.length; i = i + 1) {
                const off = this._objTmpSlots[i];
                if (typeof off === "number" && off >= water) {
                    this._objTmpSlots[n] = off;
                    n = n + 1;
                }
            }
            this._objTmpSlots.length = n;
            if (this._objTmpDepth > n) this._objTmpDepth = n;
        }
        if (this._arrTmpDepth === 0) {
            this._arrTmpSlots = null;
        } else if (this._arrTmpSlots) {
            let n = 0;
            for (let i = 0; i < this._arrTmpSlots.length; i = i + 1) {
                const off = this._arrTmpSlots[i];
                if (typeof off === "number" && off >= water) {
                    this._arrTmpSlots[n] = off;
                    n = n + 1;
                }
            }
            this._arrTmpSlots.length = n;
            if (this._arrTmpDepth > n) this._arrTmpDepth = n;
        }
    }

    fpOffLive(off) {
        if (typeof off !== "number") return false;
        return off >= (-CALLEE_SAVED_AREA - this.stackOffset);
    }

    // 注册函数声明
    registerFunction(symbol, node, alias = null) {
        this.functions[symbol] = node;
        if (alias) {
            this.functionAliases[alias] = symbol;
        }
    }

    // 获取函数声明
    getFunction(name) {
        const symbol = this.getFunctionSymbol(name);
        return symbol ? this.functions[symbol] : undefined;
    }

    // 检查是否是已注册的函数
    hasFunction(name) {
        const result = !!this.getFunction(name);
        // 如果同时存在同名捕获变量（可能是 namespace import），则不视为函数
        // 这样可以防止 AST 这种 namespace import 被误认为是函数声明
        if (result && this.mainCapturedVars && this.mainCapturedVars[name]) {
            // 检查该变量是否在 boxedVars 中（如果存在的话）
            // namespace import 不应该被视为函数
            // 简化处理：如果名称与捕获变量同名，更倾向于捕获变量
            // 注意：不能写 `this.boxedVars.has && ...` 去做存在性守卫——boxedVars 是 Set，
            // 读它的 `.has` 属性(非调用)会走通用 _object_get 把 Set 链表当对象读→ props_ptr@32
            // 落相邻垃圾崩(自举招牌 0x280100 根因)。方法调用形 `.has(name)` 走 tag 分派正常。
            if (this.boxedVars && this.boxedVars.has(name)) {
                return false;
            }
            // 也检查是否有同名导出
            if (this.functionAliases && this.functionAliases[name] &&
                this.functions[this.functionAliases[name]] &&
                this.mainCapturedVars[name]) {
                // 如果既是函数别名又同时被主程序捕获，那很可能是 namespace import 冲突
                // 这种情况下，对于特定名称我们选择不视为函数
                if (name === "AST" || name === "NodeType" || name === "Precedence") {
                    // 调试：输出发生了什么
                    return false;
                }
            }
        }
        return result;
    }

    getFunctionSymbol(name) {
        // [#32] 双语义守卫:别名恒为字符串、声明恒为 AST 节点(有 .type),
        // 挡 node 原型链污染(constructor/toString 等,见 getLocal 注释)
        const fa = this.functionAliases[name];
        if (fa && typeof fa === "string") {
            return fa;
        }
        const fn = this.functions[name];
        if (fn && fn.type) {
            return name;
        }
        return undefined;
    }

    // 克隆上下文（用于编译嵌套函数 / 模块帧）
    // opts.skipAliases: 调用方将立即覆盖 functionAliases(省一次 for-in 拷贝)
    // opts.skipMainCaptured: 同上,覆盖 mainCapturedVars
    clone(newFuncName, opts) {
        opts = opts || {};
        let newCtx = new CompileContext(newFuncName);
        // functions/globals 在 collectFunctions 之后基本只读:共享引用,避免每函数/
        // 每模块 for-in 深拷贝(gen1 上自编译 functions.js 曾占数秒~数十秒)。
        // 别名/mainCaptured 仍按帧拷贝(模块/owner 会覆盖时可 skip)。
        newCtx.functions = this.functions;
        newCtx.globals = this.globals;
        if (!opts.skipAliases) {
            for (let key in this.functionAliases) {
                newCtx.functionAliases[key] = this.functionAliases[key];
            }
        }
        if (!opts.skipMainCaptured) {
            for (let key in this.mainCapturedVars) {
                newCtx.mainCapturedVars[key] = this.mainCapturedVars[key];
            }
        }
        // 复制类上下文（super 调用需要在方法/构造器帧内可见）
        newCtx.inClass = this.inClass;
        newCtx.className = this.className;
        newCtx.superClass = this.superClass;
        // [D1 L3b] 严格模式继承(嵌套函数 [[Strict]])
        newCtx.inStrictFunction = this.inStrictFunction;
        // 表达式父类(`extends (expr)`):父类无编译期名字,其 classinfo 指针在类声明处
        // 求值一次并存入 superInfoLabel 全局;super()/super.m() 经该全局解析(见
        // emitLoadSuperClassInfo)。标识符父类 superClassExpr 恒 undefined → 名字快路径不变。
        newCtx.superClassExpr = this.superClassExpr;
        newCtx.superInfoLabel = this.superInfoLabel;
        newCtx.inStaticMethod = this.inStaticMethod; // 静态方法内 super.m() 走父类对象(非 prototype)
        // inClassMethod / inFieldInit are per-function: nested function
        // expressions must not inherit the enclosing method's brand/`eval`
        // initializer rules. Arrows share the parent ctx until their
        // pending-function record snapshots the flags.
        newCtx._fnFrameSize = this._fnFrameSize;
        // [支柱②] 去虚拟化局部 new 跟踪(函数作用域):浅拷贝——方法见外层类型,
        // 方法内自有赋值不回写外层(语义按函数作用域隔离)。
        // 避免 `{...}` 展开(gen1 上更贵);空表不分配。
        newCtx.devirtVarTypes = null;
        if (this.devirtVarTypes) {
            const src = this.devirtVarTypes;
            const dst = {};
            let n = 0;
            for (const k in src) {
                dst[k] = src[k];
                n = n + 1;
            }
            if (n) newCtx.devirtVarTypes = dst;
        }
        // LSRA:子帧共享同一 VM,录制期 allocLocal 可绑 T*
        newCtx.raVm = this.raVm;
        if (this._engineLocalNames && this._engineLocalOffsets) {
            newCtx._engineLocalNames = [];
            newCtx._engineLocalOffsets = [];
        }
        return newCtx;
    }
}

// 编译选项
export class CompileOptions {
    constructor() {
        this.outputType = "executable"; // executable, shared, object
        this.debug = false; // 生成调试信息
        this.optimize = 0; // 优化级别 0-3
        this.heapSize = 1048576; // 默认堆大小 1MB
        this.maxHeapSize = 0; // 最大堆大小，0 = 无限制
        this.numWorkers = 0; // 工作线程数，0 = 单线程
    }
}

// 编译结果
export class CompileResult {
    constructor() {
        this.success = false;
        this.binary = null;
        this.error = null;
        this.outputFile = null;
        this.size = 0;
    }

    static success(binary, outputFile) {
        let result = new CompileResult();
        result.success = true;
        result.binary = binary;
        result.outputFile = outputFile;
        result.size = binary.length;
        return result;
    }

    static failure(error) {
        let result = new CompileResult();
        result.success = false;
        result.error = error;
        return result;
    }
}

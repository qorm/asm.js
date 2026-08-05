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

export class CompileContext {
    constructor(funcName) {
        this.funcName = funcName || "main";
        this.locals = {}; // 变量名 -> 栈偏移量
        this.varTypes = {}; // 变量名 -> 类型（静态类型系统）
        // [解箱①] 循环内被证明为裸 int 驻留的 induction 变量:slot 存裸 int(非
        // float64 位/0x7FF8),读写走整数路径免 _to_int32/fmov;仅在安全 for 循环
        // 体内有效,循环出口物化回 float64。见 unboxing-int-residency-design 记忆。
        this.rawIntVars = {}; // 变量名 -> true
        // [解箱① P4.1] 循环内浮点累加器驻留 caller-saved FP 寄存器(d2+)的变量:
        // 仅在 call-free 循环体内有效(caller-saved FP 跨迭代存活、body 无 call 不被腐蚀);
        // 名 -> FP 寄存器号;`s=s<op>E` 直发 f<op> d_reg,d_reg,d_tmp,免 slot 往返/coerce
        // 守卫/操作数压栈。循环出口物化回 slot。见 unboxing-int-residency-design 记忆。
        this.fpAccumVars = {}; // 变量名 -> FP 寄存器号(>0)
        this.varInitExprs = {}; // 变量名 -> 初始化表达式 AST（用于类型推断）
        this.stackOffset = 0; // 当前栈偏移
        this.labelCounter = 0; // 标签计数器
        this.returnLabel = ""; // 当前函数的返回标签
        this.functions = {}; // 函数声明: 符号名 -> AST 节点
        this.functionAliases = {}; // 当前编译单元中的函数别名: 本地名 -> 符号名
        this.isAsync = false; // 是否是异步函数

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

        // [#60] 标签语句支持:
        // labelMap = Map<labelName, {breakLabel, continueLabel, breakTryLen, continueTryLen}>
        //   —— 用 Map 而非 {} 以规避用户标签名(如 __proto__/constructor)污染原型链([#32])。
        // pendingLabels = 紧邻其后语句待登记的标签名数组(compileLabeledStatement 压入,
        //   随后的循环/块消费)。
        this.labelMap = null;
        this.pendingLabels = null;
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

    // 分配局部变量（带类型）
    allocLocal(name, type = Type.UNKNOWN) {
        this.stackOffset = this.stackOffset + 8;
        this.locals[name] = -CALLEE_SAVED_AREA - this.stackOffset;
        this.varTypes[name] = type;
        return this.locals[name];
    }

    // 获取局部变量偏移
    // [#32] 双语义守卫:合法偏移恒为数值(负数)。node 下字典 miss 可能沿原型链
    // 返回函数(如 name="constructor"),asm.js 下返回 raw 0 —— 统一归一为 0(未分配)。
    getLocal(name) {
        const v = this.locals[name];
        if (v && typeof v !== "number") return 0;
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

    // 进入新作用域
    enterScope() {
        // 手动复制 locals 对象
        let copyLocals = {};
        for (let key in this.locals) {
            copyLocals[key] = this.locals[key];
        }
        this.scopeDepth = (this.scopeDepth || 0) + 1;
        return {
            locals: copyLocals,
            stackOffset: this.stackOffset,
            scopeDepth: this.scopeDepth - 1,
            breakLabel: this.breakLabel,
            continueLabel: this.continueLabel,
        };
    }

    // 离开作用域
    leaveScope(saved) {
        this.locals = saved.locals;
        this.stackOffset = saved.stackOffset;
        this.scopeDepth = saved.scopeDepth;
        this.breakLabel = saved.breakLabel;
        this.continueLabel = saved.continueLabel;
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

    // 克隆上下文（用于编译嵌套函数）
    clone(newFuncName) {
        let newCtx = new CompileContext(newFuncName);
        // 复制函数注册表
        for (let key in this.functions) {
            newCtx.functions[key] = this.functions[key];
        }
        for (let key in this.functionAliases) {
            newCtx.functionAliases[key] = this.functionAliases[key];
        }
        // 复制全局变量
        for (let key in this.globals) {
            newCtx.globals[key] = this.globals[key];
        }
        // 复制主程序被捕获变量
        for (let key in this.mainCapturedVars) {
            newCtx.mainCapturedVars[key] = this.mainCapturedVars[key];
        }
        // 复制类上下文（super 调用需要在方法/构造器帧内可见）
        newCtx.inClass = this.inClass;
        newCtx.className = this.className;
        newCtx.superClass = this.superClass;
        // 表达式父类(`extends (expr)`):父类无编译期名字,其 classinfo 指针在类声明处
        // 求值一次并存入 superInfoLabel 全局;super()/super.m() 经该全局解析(见
        // emitLoadSuperClassInfo)。标识符父类 superClassExpr 恒 undefined → 名字快路径不变。
        newCtx.superClassExpr = this.superClassExpr;
        newCtx.superInfoLabel = this.superInfoLabel;
        newCtx.inStaticMethod = this.inStaticMethod; // 静态方法内 super.m() 走父类对象(非 prototype)
        // [支柱②] 去虚拟化局部 new 跟踪(函数作用域):浅拷贝——方法见外层类型,
        // 方法内自有赋值不回写外层(语义按函数作用域隔离)。
        newCtx.devirtVarTypes = this.devirtVarTypes ? { ...this.devirtVarTypes } : null;
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

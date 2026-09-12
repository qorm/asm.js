// asm.js 编译器 - 赋值表达式编译
// 编译各类赋值：简单赋值、复合赋值、成员赋值、更新表达式

import { VReg } from "../../vm/registers.js";
import { Type, isIntType, isFloatType, inferType } from "../core/types.js";
import { nodeEvalDeclaresVar } from "../../lang/analysis/closure.js";

// 模块级算符表:热路径勿每次 new 短数组再 indexOf
const FP_ARITH_OPS = { "+": 1, "-": 1, "*": 1, "/": 1, "%": 1 };
const FP_ASSIGN_ARITH_OPS = { "+=": 1, "-=": 1, "*=": 1, "/=": 1, "%=": 1 };

// 赋值编译方法混入
export const AssignmentCompiler = {
    // 非装箱局部:优先 T*(与 members 标识符读/简单赋值写同契约);否则 FP。
    _loadLocalTemp(name, offset, dest) {
        const lt = this.ctx.localTemps && this.ctx.localTemps.get(name);
        if (lt && !this.ctx.isRawIntVar(name)) this.vm.mov(dest, lt);
        else this.vm.load(dest, VReg.FP, offset);
    },
    _storeLocalTemp(name, offset, src) {
        const lt = this.ctx.localTemps && this.ctx.localTemps.get(name);
        if (lt && !this.ctx.isRawIntVar(name)) this.vm.mov(lt, src);
        else this.vm.store(VReg.FP, offset, src);
    },

    // Object Environment SetMutableBinding:strict 且 !HasProperty(bindings, N) → ReferenceError。
    _emitStrictObjectEnvPutGuard(objSlot, name) {
        const goneL = this.ctx.newLabel("objenv_put_gone");
        const okL = this.ctx.newLabel("objenv_put_ok");
        this._emitObjectEnvHasProperty(objSlot, name, goneL);
        this.vm.jmp(okL);
        this.vm.label(goneL);
        this.emitThrowReferenceError(name + " is not defined");
        this.vm.label(okL);
    },

    // 装箱 globalThis 落帧槽。跨 call 只用 FP,避开 x64 V0≡RET / A0 别名。
    _emitLoadBoxedGlobalThis() {
        const off = this.ctx.allocLocal(`__gthis_${this.nextLabelId()}`);
        this.vm.lea(VReg.V0, "_global_this");
        this.vm.load(VReg.RET, VReg.V0, 0);
        this.vm.call("_box_obj_r");
        this.vm.store(VReg.FP, off, VReg.RET);
        return off;
    },

    // 全局对象环境 GetBindingValue:HasProperty miss → ReferenceError;命中则 Get+getter。
    _emitGlobalObjectEnvGet(gOff, name) {
        const missL = this.ctx.newLabel("genv_get_miss");
        const doneL = this.ctx.newLabel("genv_get_done");
        this._emitObjectEnvHasProperty(gOff, name, missL);
        this.vm.load(VReg.A0, VReg.FP, gOff);
        this.emitBoxedStringKey(name, VReg.A1);
        this.vm.call("_object_get");
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.load(VReg.A1, VReg.FP, gOff);
        this.vm.call("_maybe_getter");
        this.vm.jmp(doneL);
        this.vm.label(missL);
        this.emitThrowReferenceError(name + " is not defined");
        this.vm.label(doneL);
    },

    // 编译期未解析名的复合赋值:GetValue(globalThis.N) → 算 → PutValue(HasProperty 守卫)。
    // 只服务无词法槽的标识符;有局部/捕获的走原路径,热路径零税。
    _emitGlobalObjectEnvCompoundAssign(name, binOp, right, strictSet) {
        const gOff = this._emitLoadBoxedGlobalThis();
        this._emitGlobalObjectEnvGet(gOff, name);
        const leftSlot = this.ctx.allocLocal(`__genv_l_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, leftSlot, VReg.RET);
        this.compileExpression(right);
        const vSlot = this.ctx.allocLocal(`__genv_r_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, vSlot, VReg.RET);
        if (strictSet) this._emitStrictObjectEnvPutGuard(gOff, name);
        this._inWithResolve = true;
        this.compileAssignmentExpression({
            type: "AssignmentExpression",
            operator: "=",
            left: {
                type: "MemberExpression",
                object: { type: "__WithPrecomputed", slot: gOff },
                property: { type: "Identifier", name: name },
                computed: false,
            },
            right: {
                type: "BinaryExpression",
                operator: binOp,
                left: { type: "__WithPrecomputed", slot: leftSlot },
                right: { type: "__WithPrecomputed", slot: vSlot },
            },
        });
        this._inWithResolve = false;
    },

    // 编译赋值表达式
    // [解箱① P4.1] 把表达式编译为 float64 位模式(供浮点累加器更新的 E 操作数)。
    // 镜像 compileOperandAsFloat 的关键归一化:整数表达式(rawInt 变量/int 算术)编成
    // 裸 int 再转 float64;其余编译后 emitNumberCoerceFast 归一(float 位/装箱/堆 Number)。
    compileFpAccumOperand(expr) {
        if (isIntType(inferType(expr, this.ctx))) {
            this.compileExpressionAsInt(expr);
            this.intToFloat64Bits(VReg.RET);
            return;
        }
        this.compileExpression(expr);
        this.emitNumberCoerceFast();
    },

    compileAssignmentExpression(expr) {
        // [#48] 解构赋值形:[a,b]=[b,a] / ({x}=o) / 嵌套。解析器在赋值目标位把
        // {..}/[..] 产成 Object/ArrayExpression(字面量),重解释为 pattern 后走统一
        // 递归解构(mode "assign":叶子写既有 lvalue)。求值顺序:先整体求右侧到临时槽,
        // 再逐个赋值 → swap 语义正确([a,b]=[b,a])。整表达式值为右侧(可链式)。
        if (expr.operator === "=" &&
            (expr.left.type === "ObjectExpression" || expr.left.type === "ArrayExpression" ||
             expr.left.type === "ObjectPattern" || expr.left.type === "ArrayPattern")) {
            this.compileExpression(expr.right);
            const srcSlot = this.ctx.allocLocal(`__adestr_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, srcSlot, VReg.RET);
            const pat = this.reinterpretAsPattern(expr.left);
            this.emitDestructurePattern(pat, srcSlot, "assign");
            this.vm.load(VReg.RET, VReg.FP, srcSlot);
            return;
        }
        if (expr.left.type === "Identifier") {
            const name = expr.left.name;

            // with(obj) 作用域赋值:HasBinding 命中则 PutValue 恒写该 binding object。
            // 简单 `=` 仍先求 RHS 再 HasBinding:先钉 Reference 再 Set 会在
            // TypedArray 原型 + 数值键("NaN")上误 CreateDataProperty
            // (set-mutable-binding-binding-deleted-with-typed-array-in-proto-chain)。
            // 复合:GetValue 后 strict 且 !HasProperty → ReferenceError。
            if (this._hasAnyWithScope && this._hasAnyWithScope() && !this._inWithResolve) {
                const doneL = this.ctx.newLabel("withasgn_done");
                const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                    (this._currentModuleAst && this._currentModuleAst._bsStrict);
                const setHelper = strictSet ? "_object_set_strict" : "_object_set";
                const binOp = expr.operator !== "=" && expr.operator.length >= 2
                    ? expr.operator.slice(0, -1) : null;
                const _asgnGroups = [this.ctx.withScopes || []];
                if (!(this._isOwnBinding && this._isOwnBinding(name))) {
                    _asgnGroups.push(this.ctx.outerWithScopes || []);
                }
                // [S11.13.1_A5_T3] 嵌套 with 内简单 `=` 须先钉住 LHS Reference 的 binding
                // object,再求 RHS,再 PutValue(即使 RHS delete 了该属性仍写回原 object)。
                // sloppy 单层仍先 RHS 再 HasBinding:钉死后 _object_set 会在 TypedArray
                // 原型 + 数值键("NaN")上误 CreateDataProperty(sloppy TA 测须走 [[Set]] no-op)。
                // strict 简单 `=` 必须钉(含 outerWith 闭包):SetMutableBinding 在
                // !HasProperty 且 S 时 ReferenceError(putvalue-lref / TA-strict / unscopables-strict)。
                const withScopes = this.ctx.withScopes || [];
                const pinLhsRef = expr.operator === "=" && (withScopes.length > 1 || strictSet);
                const pinOff = pinLhsRef
                    ? this.ctx.allocLocal(`__withasgn_pin_${this.nextLabelId()}`) : 0;
                const pinHitOff = pinLhsRef
                    ? this.ctx.allocLocal(`__withasgn_phit_${this.nextLabelId()}`) : 0;
                const evalRhsL = this.ctx.newLabel("withasgn_eval_rhs");
                const oldPutL = this.ctx.newLabel("withasgn_old_put");
                if (pinLhsRef) {
                    this.vm.movImm(VReg.V5, 0);
                    this.vm.store(VReg.FP, pinHitOff, VReg.V5);
                    for (let _gi = 0; _gi < _asgnGroups.length; _gi++) {
                        const _pinList = _asgnGroups[_gi];
                        for (let i = _pinList.length - 1; i >= 0; i--) {
                            const missL = this.ctx.newLabel("withasgn_phit_miss");
                            this._emitObjectEnvHasBinding(_pinList[i], name, missL);
                            this.vm.load(VReg.V5, VReg.FP, _pinList[i]);
                            this.vm.store(VReg.FP, pinOff, VReg.V5);
                            this.vm.movImm(VReg.V6, 1);
                            this.vm.store(VReg.FP, pinHitOff, VReg.V6);
                            this.vm.jmp(evalRhsL);
                            this.vm.label(missL);
                        }
                    }
                    this.vm.jmp(evalRhsL);
                } else {
                    this.vm.jmp(evalRhsL);
                }
                this.vm.label(evalRhsL);
                this.compileExpression(expr.right);
                const vSlot = this.ctx.allocLocal(`__withasgn_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, vSlot, VReg.RET);
                if (pinLhsRef) {
                    const pinnedPutL = this.ctx.newLabel("withasgn_pinned_put");
                    this.vm.load(VReg.V5, VReg.FP, pinHitOff);
                    this.vm.cmpImm(VReg.V5, 0);
                    this.vm.jne(pinnedPutL);
                    this.vm.jmp(oldPutL);
                    this.vm.label(pinnedPutL);
                    if (strictSet) this._emitStrictObjectEnvPutGuard(pinOff, name);
                    this.vm.load(VReg.A0, VReg.FP, pinOff);
                    this.emitBoxedStringKey(name, VReg.A1);
                    this.vm.load(VReg.A2, VReg.FP, vSlot);
                    this.vm.call(setHelper);
                    this.vm.load(VReg.RET, VReg.FP, vSlot);
                    this.vm.jmp(doneL);
                }
                this.vm.label(oldPutL);
                for (let _gi = 0; _gi < _asgnGroups.length; _gi++) {
                const _asgnList = _asgnGroups[_gi];
                for (let i = _asgnList.length - 1; i >= 0; i--) {
                    const missL = this.ctx.newLabel("withasgn_miss");
                    const slot = _asgnList[i];
                    this._emitObjectEnvHasBinding(slot, name, missL);
                    if (expr.operator === "=") {
                        this.vm.load(VReg.A0, VReg.FP, slot);
                        this.emitBoxedStringKey(name, VReg.A1);
                        this.vm.load(VReg.A2, VReg.FP, vSlot);
                        this.vm.call(setHelper);
                        this.vm.load(VReg.RET, VReg.FP, vSlot);
                    } else if (binOp) {
                        // GetBindingValue / SetMutableBinding each do HasProperty
                        // after HasBinding (Proxy has traps, with-proxy-env).
                        const gbvHasL = this.ctx.newLabel("withcv_gbv_has");
                        this._emitObjectEnvHasProperty(slot, name, gbvHasL);
                        this.vm.label(gbvHasL);
                        this.vm.load(VReg.A0, VReg.FP, slot);
                        this.emitBoxedStringKey(name, VReg.A1);
                        this.vm.call("_object_get");
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.load(VReg.A1, VReg.FP, slot);
                        this.vm.call("_maybe_getter");
                        const leftSlot = this.ctx.allocLocal(`__withcv_l_${this.nextLabelId()}`);
                        this.vm.store(VReg.FP, leftSlot, VReg.RET);
                        if (strictSet) this._emitStrictObjectEnvPutGuard(slot, name);
                        const smbHasL = this.ctx.newLabel("withcv_smb_has");
                        this._emitObjectEnvHasProperty(slot, name, smbHasL);
                        this.vm.label(smbHasL);
                        this._inWithResolve = true;
                        this.compileAssignmentExpression({
                            type: "AssignmentExpression",
                            operator: "=",
                            left: {
                                type: "MemberExpression",
                                object: { type: "__WithPrecomputed", slot: slot },
                                property: { type: "Identifier", name: name },
                                computed: false,
                            },
                            right: {
                                type: "BinaryExpression",
                                operator: binOp,
                                left: { type: "__WithPrecomputed", slot: leftSlot },
                                right: { type: "__WithPrecomputed", slot: vSlot },
                            },
                        });
                        this._inWithResolve = false;
                    } else {
                        this._inWithResolve = true;
                        this.compileAssignmentExpression({
                            type: "AssignmentExpression", operator: expr.operator,
                            left: expr.left, right: { type: "__WithPrecomputed", slot: vSlot },
                        });
                        this._inWithResolve = false;
                        this.vm.jmp(doneL);
                        this.vm.label(missL);
                        continue;
                    }
                    this.vm.jmp(doneL);
                    this.vm.label(missL);
                }
                }
                this._inWithResolve = true;
                this.compileAssignmentExpression({
                    type: "AssignmentExpression", operator: expr.operator === "=" ? "=" : expr.operator,
                    left: expr.left, right: { type: "__WithPrecomputed", slot: vSlot },
                });
                this._inWithResolve = false;
                this.vm.label(doneL);
                return;
            }

            let offset = this.ctx.getLocal(name);

            // 检查是否是主程序被捕获的变量（从全局位置访问）
            const globalLabel = this.ctx.getMainCapturedVar(name);

            if (!offset && !globalLabel) {
                // [L2-②] 对**真正未解析**的标识符赋值:strict → ReferenceError(规范
                // PutValue 对 unresolvable reference);sloppy `=` → 在全局对象上
                // CreateDataProperty(读路径已在 members.js 对同形名做 globalThis 查找,
                // 此前写路径直接抛,令 S13_A15_T5/S13_A12_T1 等隐式全局族 FAIL)。
                // 判别复用 typeof 的 isUnresolvableIdentifier:内建/已知全局不算 ——
                // 但 sloppy `=` 一律走全局 set(规范即如此;此前静默 no-op 且不 eval RHS)。
                // 复合赋值(+= 等)/严格 `=`:未解析名走全局对象环境 GetValue+PutValue
                // (defineProperty(this,"x",getter-deletes) 后 x+= / x-- 须先 Get 再
                // HasProperty 守卫)。逻辑赋值仍早抛,不在本刀。
                const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                    (this._currentModuleAst && this._currentModuleAst._bsStrict);
                if (!strictSet && expr.operator === "=") {
                    // FP 槽保 RHS:不可用 push/pop——嵌套在二元运算等已 push 左值的
                    // 上下文里会掏错槽,且 arm64 stp 填充字使 SP+0 读值不可靠叠加。
                    this.compileExpression(expr.right);      // RET = RHS
                    const rhsOff = this.ctx.allocLocal(`__gassign_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, rhsOff, VReg.RET);
                    this.vm.lea(VReg.V0, "_global_this");
                    this.vm.load(VReg.RET, VReg.V0, 0);
                    this.vm.call("_box_obj_r");              // RET = boxed globalThis (x64 A0≢RET)
                    this.vm.mov(VReg.A0, VReg.RET);          // _object_set this
                    this.emitBoxedStringKey(name, VReg.A1);  // _tag_key_a1 clobber V1
                    this.vm.load(VReg.A2, VReg.FP, rhsOff);  // A2 = RHS
                    this.vm.call("_object_set");
                    this.vm.load(VReg.RET, VReg.FP, rhsOff); // 赋值表达式之值 = RHS
                    return;
                }
                // 严格简单 `=` 对编译期未解析名:先求 RHS,再全局对象环境 SetMutableBinding
                // (HasProperty 守卫)。此前 emitThrow 不求 RHS → delete global.x 未跑
                // (assignment-operator-calls-putvalue-lref--rval--1)。
                if (strictSet && expr.operator === "=" &&
                    this.isUnresolvableIdentifier &&
                    this.isUnresolvableIdentifier({ type: "Identifier", name: name })) {
                    this.compileExpression(expr.right);
                    const rhsOff = this.ctx.allocLocal(`__gassign_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, rhsOff, VReg.RET);
                    const gOff = this._emitLoadBoxedGlobalThis();
                    this._emitStrictObjectEnvPutGuard(gOff, name);
                    this.vm.load(VReg.A0, VReg.FP, gOff);
                    this.emitBoxedStringKey(name, VReg.A1);
                    this.vm.load(VReg.A2, VReg.FP, rhsOff);
                    this.vm.call("_object_set_strict");
                    this.vm.load(VReg.RET, VReg.FP, rhsOff);
                    return;
                }
                if (this.isUnresolvableIdentifier &&
                    this.isUnresolvableIdentifier({ type: "Identifier", name: name })) {
                    const binOp = expr.operator !== "=" && expr.operator.length >= 2
                        ? expr.operator.slice(0, -1) : null;
                    if (binOp && binOp !== "&&" && binOp !== "||" && binOp !== "??") {
                        this._emitGlobalObjectEnvCompoundAssign(name, binOp, expr.right, strictSet);
                        return;
                    }
                    this.emitThrowReferenceError(name + " is not defined");
                }
                return;
            }

            const op = expr.operator;
            let isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(name);
            // eval('var x') 与捕获同名:读走独立 eval var 槽。
            // 复合赋值、以及 RHS 内含 eval('var x') 的简单赋值:LHS Reference 在
            // eval 之前已解析,PutValue 仍写捕获 box(__cap_x)(S11.13.1_A6_T1)。
            if (this.ctx.bodyEvalVarNames && this.ctx.bodyEvalVarNames.has(name)) {
                const capOff = this.ctx.getLocal(`__cap_${name}`);
                if (capOff && (op !== "=" || nodeEvalDeclaresVar(expr.right, name))) {
                    offset = capOff;
                    isBoxed = true;
                }
            }

            // [解箱① P4.1] 浮点累加器驻留 FP 寄存器:`s=s<op>E` / `s<op>=E` 直发
            // f<op> d_reg,d_reg,d_tmp,免 slot 往返/coerce 守卫/操作数压栈。
            const fpReg = this.ctx.getFpAccum(name);
            if (fpReg > 0) {
                let fop = null, eExpr = null;
                if (op === "=") {
                    const r = expr.right;
                    if (r && r.type === "BinaryExpression" && r.left &&
                        r.left.type === "Identifier" && r.left.name === name &&
                        FP_ARITH_OPS[r.operator]) {
                        fop = r.operator; eExpr = r.right;
                    }
                } else if (FP_ASSIGN_ARITH_OPS[op]) {
                    fop = op.charAt(0); eExpr = expr.right;
                }
                if (fop && eExpr) {
                    this.compileFpAccumOperand(eExpr);  // RET = E 的 float64 位
                    this.vm.fmovToFloat(1, VReg.RET);    // d1 = E(算术 scratch,E 求值后才写)
                    if (fop === "+") this.vm.fadd(fpReg, fpReg, 1);
                    else if (fop === "-") this.vm.fsub(fpReg, fpReg, 1);
                    else if (fop === "*") this.vm.fmul(fpReg, fpReg, 1);
                    else if (fop === "/") this.vm.fdiv(fpReg, fpReg, 1);
                    else this.vm.fmod(fpReg, fpReg, 1); // %(fmod 用 d7 temp,不碰累加器 d2-d6)
                    this.vm.fmovToInt(VReg.RET, fpReg);  // 表达式值 = 新 s(float64 位)
                    return;
                }
                // 形态不符(detect 已排除,防御性):物化 FP→slot 后落通用路径,避免不一致
                this.vm.fmovToInt(VReg.RET, fpReg);
                this._storeLocalTemp(name, offset, VReg.RET);
                this.ctx.fpAccumVars[name] = 0;
            }

            // 简单赋值
            if (op === "=") {
                // [L4.2 字符串原地拼接] 仅对逃逸分析通过的 `s = s + E` 开启
                // 原地 append。编译器会在 compileStringConcat 中将该站点改发
                // `_str_concat_ip`；不满足门控时保持通用 `_strconcat` 语义。
                const _ipCand = expr.right && expr.right.type === "BinaryExpression" &&
                    expr.right.operator === "+" && expr.right.left &&
                    expr.right.left.type === "Identifier" && expr.right.left.name === name &&
                    this._isKnownStringExpr(expr.right.right) &&
                    !isBoxed && !globalLabel &&
                    !(this.ctx.withScopes && this.ctx.withScopes.length > 0) &&
                    this._canIpStringAccum && this._canIpStringAccum(name);
                if (_ipCand) this.ctx._ipConcatVar = name;
                this.compileExpression(expr.right);
                if (_ipCand) this.ctx._ipConcatVar = null;
                // 具名函数表达式 BindingIdentifier:CreateImmutableBinding。
                // sloppy 静默忽略赋值(仍返 RHS);strict 抛 TypeError。
                // 本函数形参/var 同名走 ownBindingNames,可写;箭头捕获外层名仍禁写。
                if (this.ctx.immutableLocals && this.ctx.immutableLocals.has(name) &&
                    !(this.ctx.ownBindingNames && this.ctx.ownBindingNames[name])) {
                    // Named function expression: sloppy silent / strict TypeError.
                    // Class name (CreateImmutableBinding): always TypeError, even
                    // in a sloppy heritage/method closure that captured it.
                    const classNameWrite = this.ctx.inClass ||
                        (this.ctx.classNameBindings && this.ctx.classNameBindings.has(name));
                    if (this.ctx.inStrictFunction || classNameWrite) {
                        this.emitThrowTypeError("Assignment to constant variable.");
                    }
                    return;
                }

                // 二元表达式（算术运算和字符串连接）返回 raw bits 或 NaN-boxed，
                // 不是 boxed Number，不需要 unbox
                // 注意：compileExpression 对 +,-,*,/ 已经返回 raw bits

                if (globalLabel && !offset) {
                    // 主程序被捕获变量的赋值（在顶层函数中）
                    this.vm.mov(VReg.V1, VReg.RET); // 保存要存的值
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0); // 加载 box 指针
                    // [TDZ 写] 声明前的捕获 let/const:全局 box 预建时写入 TDZ 哨兵 → 写
                    // 即抛 ReferenceError(put-let 族,闭包经 mainCapturedVars 写同判)。
                    // 走运行时 _throw_reference_error 单 call(与 emitUninitializedBindingGuard
                    // 同因:内联 new ReferenceError 破坏录制重放 → 自举崩)。
                    this.vm.load(VReg.V3, VReg.V2, 0);
                    const gTdzOk = this.ctx.newLabel("gtdzw_ok");
                    this.vm.movImm64(VReg.V4, 0x7ff70000deadbeefn);
                    this.vm.cmp(VReg.V3, VReg.V4);
                    this.vm.jne(gTdzOk);
                    // 工具链禁正则字面量(否则 codegen 改写 __RE_replace 却不注入 shim)。
                    let gDisp = name;
                    const gBlk = typeof name === "string" ? name.indexOf("$blk$") : -1;
                    if (gBlk !== -1) gDisp = name.slice(0, gBlk);
                    const gTdzMsg = this.asm.addString("Cannot access '" + gDisp + "' before initialization");
                    this.vm.lea(VReg.A0, gTdzMsg);
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.A0, VReg.A0, VReg.V1);
                    this.vm.call("_throw_reference_error"); // 不返回
                    this.vm.label(gTdzOk);
                    this.vm.store(VReg.V2, 0, VReg.V1); // 存入 box
                    this.vm.mov(VReg.RET, VReg.V1); // 返回值
                } else if (isBoxed) {
                    // 装箱变量：先加载 box 指针，然后存值到 box
                    this.vm.mov(VReg.V1, VReg.RET); // 保存要存的值
                    this.vm.load(VReg.V2, VReg.FP, offset); // 加载 box 指针
                    // [TDZ 写] 捕获的 let/const 在声明前被预建 box(初值=TDZ 哨兵):写 TDZ
                    // 绑定须抛 ReferenceError(for ([...x] of y) put-let 族——闭包延迟编译
                    // 使静态判据失效,运行期哨兵判准)。声明后写时 box 已是真值,零误拒。
                    this.vm.load(VReg.V3, VReg.V2, 0); // 当前值
                    const tdzOk = this.ctx.newLabel("tdzw_ok");
                    this.vm.movImm64(VReg.V4, 0x7ff70000deadbeefn);
                    this.vm.cmp(VReg.V3, VReg.V4);
                    this.vm.jne(tdzOk);
                    let tDisp = name;
                    const tBlk = typeof name === "string" ? name.indexOf("$blk$") : -1;
                    if (tBlk !== -1) tDisp = name.slice(0, tBlk);
                    const tdzMsg = this.asm.addString("Cannot access '" + tDisp + "' before initialization");
                    this.vm.lea(VReg.A0, tdzMsg);
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.A0, VReg.A0, VReg.V1);
                    this.vm.call("_throw_reference_error"); // 不返回
                    this.vm.label(tdzOk);
                    this.vm.store(VReg.V2, 0, VReg.V1); // 存入 box
                    this.vm.mov(VReg.RET, VReg.V1); // 返回值
                } else {
                    this._storeLocalTemp(name, offset, VReg.RET);
                }
                this.syncModuleExportBinding(name, VReg.RET);
                return;
            }

            // 逻辑赋值运算符 (ES2021)
            if (op === "&&=" || op === "||=" || op === "??=") {
                const endLabel = this.ctx.newLabel("assign_end");

                // 读取当前值
                if (globalLabel && !offset) {
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0); // 加载 box 指针
                    this.vm.load(VReg.RET, VReg.V2, 0); // 读取值
                    this.emitUninitializedBindingGuard(name, VReg.RET);
                } else if (isBoxed) {
                    this.vm.load(VReg.V2, VReg.FP, offset); // box 指针
                    this.vm.load(VReg.RET, VReg.V2, 0); // 值
                    this.emitUninitializedBindingGuard(name, VReg.RET);
                } else {
                    this._loadLocalTemp(name, offset, VReg.RET);
                }

                if (op === "&&=") {
                    // x &&= y:x 为假不赋值。[#33] 原为 raw-0 判定——tagged false
                    // (0x7FF9..02)/""/NaN 全被当真 → 改完整 ToBoolean(同 && 运算符)
                    this.vm.push(VReg.RET);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_boolean");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.pop(VReg.RET);
                    this.vm.jeq(endLabel);
                } else if (op === "||=") {
                    // x ||= y:x 为真不赋值(同上改完整 ToBoolean)
                    this.vm.push(VReg.RET);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_boolean");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.pop(VReg.RET);
                    this.vm.jne(endLabel);
                } else {
                    // x ??= y:仅 tagged null(0x7FFA)/undefined(0x7FFB)才赋值。
                    // [2026-07-14] null 现恒发 tagged(见 members.js),移除此前的
                    // `cmpImm(RET,0)` 裸-0 兜底——它把数值 0.0(位=裸 0)误判 nullish、
                    // 令 `w=0; w??=3` 错赋 3。默认(非 null/undef)→ 跳过赋值保原值。
                    // 数值类型特判已无必要(默认即跳过),但保留无害且更早短路。
                    const varType = this.ctx.getVarType ? this.ctx.getVarType(name) : null;
                    if (isIntType(varType) || isFloatType(varType)) {
                        this.vm.jmp(endLabel);
                    } else {
                        const doAssignL = this.ctx.newLabel("nullish_assign_do");
                        this.vm.shrImm(VReg.V1, VReg.RET, 48);
                        this.vm.cmpImm(VReg.V1, 0x7FFA);
                        this.vm.jeq(doAssignL);
                        this.vm.cmpImm(VReg.V1, 0x7FFB);
                        this.vm.jeq(doAssignL);
                        this.vm.jmp(endLabel);   // 非 null/undef → 保原值,跳过赋值
                        this.vm.label(doAssignL);
                    }
                }

                // 执行赋值
                this.compileExpression(expr.right);
                if (globalLabel && !offset) {
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0); // 加载 box 指针
                    this.vm.store(VReg.V2, 0, VReg.RET);
                } else if (isBoxed) {
                    this.vm.load(VReg.V2, VReg.FP, offset);
                    this.vm.store(VReg.V2, 0, VReg.RET);
                } else {
                    this._storeLocalTemp(name, offset, VReg.RET);
                }
                this.syncModuleExportBinding(name, VReg.RET);

                this.vm.label(endLabel);
                return;
            }

            // 复合赋值运算符
            // 对于算术运算符 (+=, -=, *=, /=)，需要区分整数运算和浮点运算
            const isArithOp = (op === "+=" || op === "-=" || op === "*=" || op === "/=");
            const isUnboxedArith = !isBoxed && !globalLabel && isArithOp;

            if (globalLabel && !offset) {
                // 主程序被捕获变量
                this.vm.lea(VReg.V3, globalLabel);
                this.vm.load(VReg.V3, VReg.V3, 0); // 加载 box 指针
                this.vm.push(VReg.V3); // 保存 box 指针
                this.vm.load(VReg.RET, VReg.V3, 0); // 当前值
                this.emitUninitializedBindingGuard(name, VReg.RET);
            } else if (isBoxed) {
                this.vm.load(VReg.V3, VReg.FP, offset); // box 指针
                this.vm.push(VReg.V3); // 保存 box 指针
                this.vm.load(VReg.RET, VReg.V3, 0); // 当前值
                this.emitUninitializedBindingGuard(name, VReg.RET);
            } else if (isUnboxedArith) {
                // 无装箱的变量且是算术运算符：使用浮点运算
                this._loadLocalTemp(name, offset, VReg.V1); // V1 = 左操作数 raw bits
            } else {
                this._loadLocalTemp(name, offset, VReg.RET);
            }

            if (isUnboxedArith && op === "+=") {
                // 字符串累加器命中 L4.2 门控时，直接走原地 append；否则保留
                // 完整 JS `+` 分派。右值静态字符串时无需额外 ToString。
                const _ipPlus = this._isKnownStringExpr(expr.right) &&
                    !isBoxed && !globalLabel &&
                    !(this.ctx.withScopes && this.ctx.withScopes.length > 0) &&
                    this._canIpStringAccum && this._canIpStringAccum(name);
                this.vm.push(VReg.V1);
                if (_ipPlus) {
                    this.compileExpressionToString(expr.right);
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.pop(VReg.A0);
                    this.vm.call("_str_concat_ip");
                } else {
                    this.compileExpression(expr.right);
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.pop(VReg.A0);
                    this.vm.call("_js_add");
                }
                this._storeLocalTemp(name, offset, VReg.RET);
            } else if (isUnboxedArith) {
                // [#F64] 未装箱算术复合赋值:slot 值可能是 tagged 值(如 x=true 存为
                // 0x7FF9.. tag、x=null 存为 0x7FFA.. tag)，直接 fmovToFloat 会误解
                // 位模式为 float64 → NaN/垃圾。先 ToNumber 两侧再浮点运算。
                // V1=左槽值。compileExpression 可能物化原型并占用 S0(如 new Number →
                // emitNumberProtoObject),故左值必须落栈而非 S0——否则 `true /= new Number(1)`
                // 左操作数被冲掉 → NaN。
                this.vm.push(VReg.V1);                   // 栈: 左 JSValue
                this.compileExpression(expr.right);      // RET = 右 JSValue
                this.vm.mov(VReg.A0, VReg.RET);          // A0 = 右 JSValue
                this.vm.call("_number_coerce");          // RET = 右 float64
                this.vm.pop(VReg.V1);                    // V1 = 左 JSValue
                this.vm.push(VReg.RET);                  // 栈: 右 float
                this.vm.mov(VReg.A0, VReg.V1);           // A0 = 左 JSValue
                this.vm.call("_number_coerce");          // RET = 左 float64
                this.vm.pop(VReg.V1);                    // V1 = 右 float

                // 现在: RET = 左 float, V1 = 右 float. 装 FP regs.
                this.vm.fmovToFloat(0, VReg.RET);        // FP0 = 左
                this.vm.fmovToFloat(1, VReg.V1);         // FP1 = 右

                switch (op) {
                    case "-=":
                        this.vm.fsub(0, 0, 1);
                        break;
                    case "*=":
                        this.vm.fmul(0, 0, 1);
                        break;
                    case "/=":
                        this.vm.fdiv(0, 0, 1);
                        break;
                }
                // 将结果移回整数寄存器
                this.vm.fmovToInt(VReg.RET, 0);
                // [#nan-int0] ARM64 fmul/fsub/fdiv 对 SNaN 产生 QNaN(high16=0x7FF8)
                // → 与 NaN-boxing int32 tag 别名 → 被误读为 tagged int。调用 _nan_canon
                // 改写为 0x7FF0.. 安全 NaN(与 binary-expression 同形)。
                this.emitNaNCanon();
                // 存储回 slot
                this._storeLocalTemp(name, offset, VReg.RET);
            } else {
                this.vm.push(VReg.RET);
                this.compileExpression(expr.right);
                this.vm.pop(VReg.V1);
                // 此处 V1 = 旧值, RET = 右值。

                // [#59] 算术复合赋值 (-=/*=//=/%=) 对 box/global 捕获变量及本路径经过的
                // 局部 %=：box/slot 存的是裸 float64 位（或 int32 JSValue / 堆 Number），
                // 原码用裸整数 sub/mul/div/mod 直接算位模式 → 垃圾（v*=3 得 0、m%=3 得 0.）。
                // 只有 += 走 _js_add(正确) 而其余非 += 算术分支错。改为把左右都 ToNumber
                // 归一到 float64 位再做浮点运算，与非装箱局部的浮点快路径同语义。
                // 跨 _number_coerce 调用用栈/GP 保值（FP 亦 caller-saved，故先全部落到
                // GP/栈再装 FP）。位运算/** 仍走各自运行时分派（下方 switch 不变）。
                if (op === "-=" || op === "*=" || op === "/=" || op === "%=") {
                    // 关键：(1) _number_coerce 破坏 caller-saved（含 V1、A*）；
                    // (2) arm64 上 A0 与 RET 同为 X0。故每次覆写 X0 前，需要的值必须已在栈
                    // 或保存寄存器里。原码 pop(A0) 冲掉了 RET 里的右 float → 两操作数坍缩成
                    // 旧值（*= 因交换律侥幸对，-=/=/% 露馅）。此序两次 call 间全程走栈/V1。
                    this.vm.push(VReg.RET);              // [.., 右值 raw]
                    this.vm.mov(VReg.A0, VReg.V1);       // A0 = 旧值 raw（V1 尚未被 call 破坏）
                    this.vm.call("_number_coerce");      // RET = 旧值 float
                    this.vm.pop(VReg.V1);                // V1 = 右值 raw
                    this.vm.push(VReg.RET);              // [.., 旧值 float]
                    this.vm.mov(VReg.A0, VReg.V1);       // A0 = 右值 raw
                    this.vm.call("_number_coerce");      // RET = 右值 float
                    this.vm.mov(VReg.V1, VReg.RET);      // V1 = 右值 float
                    this.vm.pop(VReg.RET);               // RET = 旧值 float
                    this.vm.fmovToFloat(0, VReg.RET);    // FP0 = 旧
                    this.vm.fmovToFloat(1, VReg.V1);     // FP1 = 右
                    if (op === "-=") { this.vm.fsub(0, 0, 1); }
                    else if (op === "*=") { this.vm.fmul(0, 0, 1); }
                    else if (op === "/=") { this.vm.fdiv(0, 0, 1); }
                    else { this.vm.fmod(0, 0, 1); }      // %=
                    this.vm.fmovToInt(VReg.RET, 0);
                    // [#nan-int0] 同上:fmul/fsub/fdiv/fmod 结果可能为别名 NaN → 规范化
                    this.emitNaNCanon();
                } else
                switch (op) {
                    case "+=":
                        // 完整 JS 加法语义（字符串拼接/数值）
                        // 注意：A0 与 RET 同映射 X0，必须先从 RET 取 A1(右值) 再设 A0(左值)，
                        // 否则 mov(A0,V1) 先覆盖 X0 → A1 也拿到左值 → 变成 op(左,左)。
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.mov(VReg.A0, VReg.V1);
                        this.vm.call("_js_add");
                        break;
                    // 位运算复合赋值必须走运行时分派（与非复合 a|b 一致），否则对
                    // BigInt（堆指针）和普通数字（裸 float64 位）做裸整数 or/and 得到垃圾。
                    // 是 `bits |= BigInt(...) << ...` 恒得 0 → 自举 floatToInt64Bits 返回 0、
                    // 数字全编成 0 的根因。V1=左值, RET=右值。
                    // A0 与 RET 同映射 X0：先取 A1(右=RET) 再设 A0(左=V1)。
                    case "&=":
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_js_band");
                        break;
                    case "|=":
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_js_bor");
                        break;
                    case "^=":
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_js_bxor");
                        break;
                    case "<<=":
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_js_bshl");
                        break;
                    case ">>=":
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_js_bshr");
                        break;
                    case ">>>=":
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_js_bushr");
                        break;
                    case "**=": // [#34] n **= e → _math_pow(左位, 右位)
                        this.vm.mov(VReg.A1, VReg.RET); this.vm.mov(VReg.A0, VReg.V1); this.vm.call("_math_pow");
                        break;
                    default:
                        console.warn("Unhandled assignment operator:", op);
                        return;
                }

                if (globalLabel && !offset) {
                    // 主程序被捕获变量
                    this.vm.pop(VReg.V2); // 恢复 box 指针
                    this.vm.store(VReg.V2, 0, VReg.RET);
                } else if (isBoxed) {
                    this.vm.pop(VReg.V2); // 恢复 box 指针
                    this.vm.store(VReg.V2, 0, VReg.RET);
                } else {
                    this._storeLocalTemp(name, offset, VReg.RET);
                }
                this.syncModuleExportBinding(name, VReg.RET);
            }
        } else if (expr.left.type === "MemberExpression") {
            // 成员表达式赋值：arr[idx] = value 或 obj.prop = value
            this.compileMemberAssignment(expr);
        }
    },

    // 编译成员赋值表达式 arr[idx] = value 或 obj.prop = value
    // [求值序] 纯表达式判别:标识符/this/字面量——求值无副作用、且其值不受其它操作数
    // 求值影响时,操作数间顺序不可观测 → 代码生成可保留既有顺序(编译器自身站点字节不变),
    // 仅非纯操作数按 ES 规范序(对象→键→值)发射。
    isPureExpr(n) {
        return !n || n.type === "Identifier" || n.type === "ThisExpression" ||
            n.type === "Literal" || n.type === "NumericLiteral" || n.type === "StringLiteral";
    },

    compileMemberAssignment(expr) {
        const member = expr.left;
        const op = expr.operator;

        if (op !== "=") {
            const binOp = op.slice(0, -1); // "+=" -> "+", "||=" -> "||"
            const isLogical = binOp === "||" || binOp === "&&" || binOp === "??";
            if (isLogical) {
                // 逻辑复合赋值 member ||=/&&=/??= rhs 的**短路**语义:先读一次 LHS(触发
                // getter),条件满足(||= 真 / &&= 假 / ??= 非 nullish)则**跳过赋值**——
                // 不调 setter(与 node 的访问器可观测性一致)。此前脱糖成 `member = (member OP rhs)`
                // 恒写回 → 即便短路也触发 setter(es-compat t850/t853/t856)。对象/键各求值一次
                // (存帧槽 + `__WithPrecomputed` 复用),读写共用同一预求值对象,免副作用重复。
                const id = this.nextLabelId();
                const endLabel = this.ctx.newLabel("mla_end");
                // (1) 对象求值一次
                this.compileExpression(member.object);
                const objSlot = this.ctx.allocLocal(`__mla_obj_${id}`);
                this.vm.store(VReg.FP, objSlot, VReg.RET);
                // (2) 计算键求值一次
                let propNode = member.property;
                if (member.computed) {
                    this.compileExpression(member.property);
                    const keySlot = this.ctx.allocLocal(`__mla_key_${id}`);
                    this.vm.store(VReg.FP, keySlot, VReg.RET);
                    propNode = { type: "__WithPrecomputed", slot: keySlot };
                }
                const preMember = {
                    type: "MemberExpression",
                    object: { type: "__WithPrecomputed", slot: objSlot },
                    property: propNode,
                    computed: member.computed,
                };
                // (3) 读当前值(触发 getter),RET = 读值
                this.compileExpression(preMember);
                // (4) 短路判定:满足则跳 end(RET 已是读值,即赋值表达式之值)
                if (binOp === "||" || binOp === "&&") {
                    this.vm.push(VReg.RET);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_boolean");
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.pop(VReg.RET);
                    if (binOp === "||") this.vm.jne(endLabel); // 真 → 不赋值
                    else this.vm.jeq(endLabel);                // &&:假 → 不赋值
                } else {
                    // ??=:仅 tagged null(0x7FFA)/undefined(0x7FFB) 才赋值,余皆短路保原值
                    const doAssignL = this.ctx.newLabel("mla_do");
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0x7FFA);
                    this.vm.jeq(doAssignL);
                    this.vm.cmpImm(VReg.V1, 0x7FFB);
                    this.vm.jeq(doAssignL);
                    this.vm.jmp(endLabel);
                    this.vm.label(doAssignL);
                }
                // (5) 未短路:执行赋值(触发 setter),RET = rhs 值
                this.compileAssignmentExpression({
                    type: "AssignmentExpression",
                    operator: "=",
                    left: preMember,
                    right: expr.right,
                });
                this.vm.label(endLabel);
                return;
            }
            // 算术/位复合赋值 member OP= rhs 脱糖成 member = (member OP rhs)，复用成员读 + 简单赋值。
            // 编译器 binary/macho_object.js `this.stringOffset += ...` 等被静默丢弃 → gen1 产物
            // 偏移错(自举 gen2 产物损坏根因之一)。this/简单下标无副作用，双求值安全。
            // [求值一次] 基/计算键**可能有副作用**(调用/成员链等非纯节点)时,先各求值一次
            // 存帧槽(__WithPrecomputed,同逻辑复合赋值的机制),再脱糖——`o().v += x` 不再
            // 调 o() 两次、`a[i++] += 1` 不再 i++ 两次。纯基(标识符/this/字面量)保持原
            // 脱糖路径,编译器自身热点(this.x += …)codegen 不变。
            // [I9] 计算键恒预求值并 ToPropertyKey 一次:即便键语法纯(base[prop]),
            // 键的对象 ToPrimitive/toString 可观测——旧脱糖读写各转一次键,
            // prop.toString 触发两次(S11.13.2_A7.1_T4 族)。非计算键不受影响;
            // 编译器自身源码无计算键复合赋值(全仓 grep)→ 自举产物零变化。
            let dsMember = member;
            // Super is a Super Reference, not an object value.
            // compileExpression(Super) is this → super[k]+=1 read this[k]
            // after ToPropertyKey mutated proto (getsuperbase compound: 0 vs 2).
            if (member.object && member.object.type === "SuperExpression") {
                dsMember = member;
            } else if (!this.isPureExpr(member.object) || member.computed) {
                const did = this.nextLabelId();
                this.compileExpression(member.object);
                const dsObjSlot = this.ctx.allocLocal(`__cma_obj_${did}`);
                this.vm.store(VReg.FP, dsObjSlot, VReg.RET);
                let dsProp = member.property;
                if (member.computed) {
                    this.compileExpression(member.property);
                    // [求值序] `base[prop] op= rhs`,base 为 null/undefined:键**表达式**要求值
                    // (其抛出可观测),但 ToPropertyKey 不做 —— GetValue 先 ToObject(base) 抛
                    // TypeError。此前先 _js_prop_key,键对象的 toString 被调 → 抛出的是它的错
                    // (S11.13.2_A7.x 族期待 TypeError)。
                    const coercibleOk = this.ctx.newLabel("cma_base_ok");
                    const coercibleBad = this.ctx.newLabel("cma_base_nullish");
                    this.vm.push(VReg.RET); // 保住键值
                    this.vm.load(VReg.V0, VReg.FP, dsObjSlot);
                    this.vm.shrImm(VReg.V1, VReg.V0, 48);
                    this.vm.cmpImm(VReg.V1, 0x7FFA); // null
                    this.vm.jeq(coercibleBad);
                    this.vm.cmpImm(VReg.V1, 0x7FFB); // undefined
                    this.vm.jne(coercibleOk);
                    this.vm.label(coercibleBad);
                    this.emitThrowTypeError("Cannot read properties of null or undefined");
                    this.vm.label(coercibleOk);
                    this.vm.pop(VReg.RET);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_prop_key"); // ToPropertyKey 单次(对象键 toString 可观测)
                    const dsKeySlot = this.ctx.allocLocal(`__cma_key_${did}`);
                    this.vm.store(VReg.FP, dsKeySlot, VReg.RET);
                    dsProp = { type: "__WithPrecomputed", slot: dsKeySlot };
                }
                dsMember = {
                    type: "MemberExpression",
                    object: { type: "__WithPrecomputed", slot: dsObjSlot },
                    property: dsProp,
                    computed: member.computed,
                };
            }
            const desugared = {
                type: "AssignmentExpression",
                operator: "=",
                left: dsMember,
                right: {
                    type: "BinaryExpression",
                    operator: binOp,
                    left: dsMember,
                    right: expr.right,
                },
            };
            this.compileAssignmentExpression(desugared);
            return;
        }

        // super.prop = v / super[k] = v: not this.prop (that re-enters the
        // object-literal setter → SIGSEGV). Set on GetPrototypeOf(this) / HomeObject
        // proto with Receiver=this. Before length / generic member write.
        if (member.object && member.object.type === "SuperExpression") {
            let propName = null;
            if (!member.computed) {
                propName = member.property.type === "PrivateIdentifier"
                    ? this.manglePrivateName(member.property.name)
                    : (member.property.name || member.property.value);
            } else if (member.property.type !== "Identifier" && this.getMemberPropertyName) {
                // Identifier computed key is a runtime value (super[prop]=v),
                // not the static name "prop". Same as regular member assign.
                propName = this.getMemberPropertyName(member.property);
            }
            this.emitSuperPropSet(propName, expr.right, member.computed ? member.property : null);
            return;
        }

        // [#63] arr.length = N（非计算 .length，或计算字符串字面量 ["length"]）：
        // 数组长度赋值(截断/扩展)必须走 _js_set_length 运行时按值分派——不能走
        // _object_set_ic / _object_set，后者把数组当哈希对象写 → 堆损坏/段错误。
        // 私有字段 #length 除外（member.property 为 PrivateIdentifier）。
        const isLengthWrite =
            (!member.computed && member.property.type === "Identifier" && member.property.name === "length") ||
            (member.computed && member.property.type === "Literal" && member.property.value === "length");
        if (isLengthWrite) {
            this.compileExpression(member.object);
            const slenObjOff = this.ctx.allocLocal(`__slen_obj_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, slenObjOff, VReg.RET); // 保存对象(boxed JSValue)
            this.compileExpression(expr.right);
            const slenValOff = this.ctx.allocLocal(`__slen_val_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, slenValOff, VReg.RET);  // 保存原始 RHS(作表达式值)
            this.vm.mov(VReg.A1, VReg.RET);                // A1 = boxed value(保留 Inf/负数)
            this.vm.load(VReg.A0, VReg.FP, slenObjOff);    // A0 = 对象
            const slenStrict = (this.ctx && this.ctx.inStrictFunction) ||
                (this._currentModuleAst && this._currentModuleAst._bsStrict);
            this.vm.movImm(VReg.A2, slenStrict ? 1 : 0);
            this.vm.call("_js_set_length");
            this.vm.load(VReg.RET, VReg.FP, slenValOff);   // 赋值表达式求值为原始 RHS 值
            return;
        }

        // 用户函数自定义属性写 fn.x = v(x 非 length):接收者静态解析到函数时,经闭包属性侧表
        // (_closure_prop_set)按裸指针身份挂——asm.js 函数无属性容器。仅函数接收者触发,其它类型
        // 走下方通用路径逐字节不变。fn.name/.length 由读侧静态反射;此处只接自定义属性写。
        const _cpsFnr = (!member.computed && member.property.type === "Identifier" &&
            member.property.name !== "prototype" && this._resolveFnNode)
            ? this._resolveFnNode(member.object) : null;
        if (_cpsFnr && (_cpsFnr.node.type === "FunctionDeclaration" ||
            _cpsFnr.node.type === "FunctionExpression" || _cpsFnr.node.type === "ArrowFunctionExpression")) {
            this.compileExpression(member.object);
            const cpsObjOff = this.ctx.allocLocal(`__cps_fn_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, cpsObjOff, VReg.RET);
            this.compileExpression(expr.right);
            const cpsValOff = this.ctx.allocLocal(`__cps_val_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, cpsValOff, VReg.RET);
            this.vm.mov(VReg.A2, VReg.RET);
            this.vm.load(VReg.A0, VReg.FP, cpsObjOff);
            this.emitBoxedStringKey(member.property.name, VReg.A1);
            const _cpsStrict = (this.ctx && this.ctx.inStrictFunction) ||
                (this._currentModuleAst && this._currentModuleAst._bsStrict);
            this.vm.call(_cpsStrict ? "_closure_prop_set_strict" : "_closure_prop_set");
            this.vm.load(VReg.RET, VReg.FP, cpsValOff);
            return;
        }

        if (member.computed) {
            // computed 且键是标识符/表达式（a[i]=v）必须运行时求值 i，不能把 i 的「名字」
            // 当字面属性名（getMemberPropertyName 对 Identifier 会误返回其名 → _object_set(arr,"i")
            // 把数组当对象写坏 → 野写/堆损坏，fixupAll/宏 gen 大量 arr[var]=v 卡死自举的根因）。
            // computed 字符串字面量 a["k"]=v 仍取字面名。
            const computedPropName = (member.property.type === "Identifier")
                ? null
                : (this.getMemberPropertyName ? this.getMemberPropertyName(member.property) : null);
            if (computedPropName !== null) {
                this.compileExpression(member.object);
                const objTempName = `__obj_assign_${this.nextLabelId()}`;
                const objOffset = this.ctx.allocLocal(objTempName);
                this.vm.store(VReg.FP, objOffset, VReg.RET);

                this.compileExpression(expr.right);
                const cvalOff = this.ctx.allocLocal(`__cval_assign_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, cvalOff, VReg.RET); // 保存被赋值(call 后作表达式值)
                this.vm.mov(VReg.A2, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, objOffset);
                if (computedPropName === "Symbol.iterator" ||
                    computedPropName === "Symbol.asyncIterator" ||
                    computedPropName === "Symbol.species") {
                    // 规范键是 well-known Symbol;勿落字符串别名(读侧 @@iterator 走符号键)。
                    const wkSlot = computedPropName === "Symbol.iterator"
                        ? "_symwk_iterator"
                        : (computedPropName === "Symbol.asyncIterator"
                            ? "_symwk_asyncIterator"
                            : "_symwk_species");
                    this.vm.lea(VReg.A0, wkSlot);
                    this.vm.lea(VReg.A1, this.asm.addString(computedPropName));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.A1, VReg.A1, VReg.V1);
                    this.vm.call("_symbol_wellknown");
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, objOffset);
                } else {
                    this.emitBoxedStringKey(computedPropName, VReg.A1);
                }
                // Resolving a well-known Symbol calls _symbol_wellknown, which is
                // free to clobber argument registers.  Reload the saved RHS only
                // after the key is ready; otherwise `obj[Symbol.iterator] = fn`
                // stores an A2 scratch value on x64 and GetMethod later sees a
                // non-callable number instead of fn.
                this.vm.load(VReg.A2, VReg.FP, cvalOff);
                {
                    const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                        (this._currentModuleAst && this._currentModuleAst._bsStrict);
                    this.vm.call(strictSet ? "_object_set_strict" : "_object_set");
                }
                this.vm.load(VReg.RET, VReg.FP, cvalOff); // 赋值表达式求值为被赋的值
                return;
            }

            // 数组元素赋值：arr[idx] = value
            // 使用 _subscript_set 统一处理 Array 和 TypedArray
            if (member.property.type === "Literal" && typeof member.property.value === "number" &&
                Math.trunc(member.property.value) === member.property.value) {
                // 静态索引：arr[0] = value（仅整数字面量,非整数走动态路径 [#39],同 members.js）
                const idx = Math.trunc(member.property.value);

                // 先编译数组对象
                this.compileExpression(member.object);
                const arrTempName = `__arr_assign_${this.nextLabelId()}`;
                const arrOffset = this.ctx.allocLocal(arrTempName);
                this.vm.store(VReg.FP, arrOffset, VReg.RET);

                // 编译要赋的值
                this.compileExpression(expr.right);
                // 注意：RET = A0 = X0，所以要先保存 value 再加载 arr
                const valTempName = `__val_assign_${this.nextLabelId()}`;
                const valOffset = this.ctx.allocLocal(valTempName);
                this.vm.store(VReg.FP, valOffset, VReg.RET);

                // 调用 _subscript_set(arr, idx, value)
                this.vm.load(VReg.A0, VReg.FP, arrOffset); // arr
                this.vm.movImm(VReg.A1, idx); // index
                this.vm.load(VReg.A2, VReg.FP, valOffset); // value
                // Strict getter-only / nonwritable array index must TypeError
                // (4-243-2). Object props already pick _object_set_strict.
                {
                    const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                        (this._currentModuleAst && this._currentModuleAst._bsStrict);
                    this.vm.call(strictSet ? "_subscript_set_strict" : "_subscript_set");
                }
                // 赋值表达式求值为**被赋的值**(a[i]=v 返 v),非 _subscript_set 的返回残留。
                this.vm.load(VReg.RET, VReg.FP, valOffset);
            } else {
                // 动态下标：arr[i] = value / obj[key] = value
                // 键保持原始 JSValue，交给 _subscript_set 运行时分派。
                // [求值序] ES 规范:对象 → 键 → 值 严格左到右。任一操作数**非纯**(可能有
                // 副作用/受副作用影响)时按规范序发;两者皆纯(标识符/this/字面量,编译器
                // 自身全此类)保持原键先序 → 字节不变(纯操作数下顺序不可观测)。
                const idxTempName = `__idx_assign_${this.nextLabelId()}`;
                const idxOffset = this.ctx.allocLocal(idxTempName);
                const arrTempName = `__arr_assign_${this.nextLabelId()}`;
                const arrOffset = this.ctx.allocLocal(arrTempName);
                if (this.isPureExpr(member.object) && this.isPureExpr(member.property)) {
                    this.compileExpression(member.property);
                    this.vm.store(VReg.FP, idxOffset, VReg.RET);
                    this.compileExpression(member.object);
                    this.vm.store(VReg.FP, arrOffset, VReg.RET);
                } else {
                    this.compileExpression(member.object);
                    this.vm.store(VReg.FP, arrOffset, VReg.RET);
                    this.compileExpression(member.property);
                    this.vm.store(VReg.FP, idxOffset, VReg.RET);
                }

                // 编译要赋的值
                this.compileExpression(expr.right);
                // 注意：RET = A0 = X0，所以要先保存 value 再加载 arr
                const valTempName = `__val_assign_${this.nextLabelId()}`;
                const valOffset = this.ctx.allocLocal(valTempName);
                this.vm.store(VReg.FP, valOffset, VReg.RET);

                // 调用 _subscript_set(arr, idx, value)
                this.vm.load(VReg.A0, VReg.FP, arrOffset); // arr
                this.vm.load(VReg.A1, VReg.FP, idxOffset); // index
                this.vm.load(VReg.A2, VReg.FP, valOffset); // value
                {
                    const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                        (this._currentModuleAst && this._currentModuleAst._bsStrict);
                    this.vm.call(strictSet ? "_subscript_set_strict" : "_subscript_set");
                }
                // 赋值表达式求值为**被赋的值**(arr[i]=v / obj[k]=v 返 v)。
                this.vm.load(VReg.RET, VReg.FP, valOffset);
            }
        } else {
            // 对象属性赋值：obj.prop = value
            // 私有字段 this.#x = v：键名经 manglePrivateName 改写（与读侧一致）
            const propName = member.property.type === "PrivateIdentifier"
                ? this.manglePrivateName(member.property.name)
                : (member.property.name || member.property.value);
            const propLabel = this.asm.addString(propName);

            // 先编译对象
            this.compileExpression(member.object);
            const objTempName = `__obj_assign_${this.nextLabelId()}`;
            const objOffset = this.ctx.allocLocal(objTempName);
            this.vm.store(VReg.FP, objOffset, VReg.RET);

            // 编译要赋的值
            this.compileExpression(expr.right);
            const pvalOff = this.ctx.allocLocal(`__pval_assign_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, pvalOff, VReg.RET); // 保存被赋值(IC call 后作表达式值)

            // PutValue ToObject(base) after RHS. _object_set on null/undefined is
            // a silent no-op ("illegal type, skip"); spec TypeError.
            // `base.prop = count += 1` must run RHS then throw
            // (target-member-identifier-reference-null/undefined).
            {
                const idBaseOk = this.ctx.newLabel("cma_id_base_ok");
                const idBaseBad = this.ctx.newLabel("cma_id_base_nullish");
                this.vm.load(VReg.V1, VReg.FP, objOffset);
                this.vm.shrImm(VReg.V2, VReg.V1, 48); // V2 tag; x64 V0≡RET
                this.vm.cmpImm(VReg.V2, 0x7FFA);
                this.vm.jeq(idBaseBad);
                this.vm.cmpImm(VReg.V2, 0x7FFB);
                this.vm.jne(idBaseOk);
                this.vm.label(idBaseBad);
                this.emitThrowTypeError("Cannot convert undefined or null to object");
                this.vm.label(idBaseOk);
                this.vm.load(VReg.RET, VReg.FP, pvalOff);
            }

            // [私有品牌] `o.#x = v`:接收者无该私有名 → TypeError;私有方法、无 setter 的
            // 私有访问器一律不可写(规范 PrivateSet)。此前静默当普通属性写(键 "#C#x"),
            // 把品牌违规写成新增属性。
            if (this._isPrivateMemberKey(member.property)) {
                this.vm.load(VReg.RET, VReg.FP, objOffset);
                this.emitPrivateBrandCheck(propName, 1, !!(member.object && member.object.type === "ThisExpression"));
                this.vm.load(VReg.RET, VReg.FP, pvalOff);
            }

            // 调用 _object_set_ic(obj, key, value, site)
            // 注意：RET 和 A0 都是 X0，所以要先 mov A2 再 load A0
            this.vm.mov(VReg.A2, VReg.RET); // value (先移动，因为 load A0 会覆盖 X0)
            this.vm.load(VReg.A0, VReg.FP, objOffset); // obj
            this.emitObjectSetIC(propName); // [P2] 站点缓存(key→A1/site→A3/call)

            // 赋值表达式求值为**被赋的值**(obj.prop=v 返 v),非 IC 调用返回残留。
            this.vm.load(VReg.RET, VReg.FP, pvalOff);
        }
    },

    // 编译更新表达式 (++, --)
    compileUpdateExpression(expr) {
        // with(obj) 内 n++/--n:HasBinding 只一次(含 @@unscopables getter),再 Get/Put
        // 同一 binding object——避免 read+assign 双次 HasBinding(unscopables-inc-dec)。
        if (expr.argument.type === "Identifier" && !this._inWithResolve &&
            this._hasAnyWithScope && this._hasAnyWithScope()) {
            const name = expr.argument.name;
            const doneL = this.ctx.newLabel("withupd_done");
            const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                (this._currentModuleAst && this._currentModuleAst._bsStrict);
            const setHelper = strictSet ? "_object_set_strict" : "_object_set";
            const _updGroups = [this.ctx.withScopes || []];
            if (!(this._isOwnBinding && this._isOwnBinding(name))) {
                _updGroups.push(this.ctx.outerWithScopes || []);
            }
            for (let _gi = 0; _gi < _updGroups.length; _gi++) {
            const _updList = _updGroups[_gi];
            for (let i = _updList.length - 1; i >= 0; i--) {
                const missL = this.ctx.newLabel("withupd_miss");
                const slot = _updList[i];
                this._emitObjectEnvHasBinding(slot, name, missL);
                // GetValue
                this.vm.load(VReg.A0, VReg.FP, slot);
                this.emitBoxedStringKey(name, VReg.A1);
                this.vm.call("_object_get");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.load(VReg.A1, VReg.FP, slot);
                this.vm.call("_maybe_getter");
                const oldSlot = this.ctx.allocLocal(`__withupd_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, oldSlot, VReg.RET);
                // new = old ± 1
                this.vm.load(VReg.RET, VReg.FP, oldSlot);
                this.emitNumberCoerceFast();
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.movImm(VReg.V1, 0x3ff00000);
                this.vm.shl(VReg.V1, VReg.V1, 32); // 1.0
                this.vm.fmovToFloat(1, VReg.V1);
                if (expr.operator === "++") this.vm.fadd(0, 0, 1);
                else this.vm.fsub(0, 0, 1);
                this.vm.fmovToInt(VReg.A2, 0);
                const newOff = this.ctx.allocLocal(`__withupd_new_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, newOff, VReg.A2);
                // PutValue 恒写本 binding(不再 HasBinding)
                if (strictSet) this._emitStrictObjectEnvPutGuard(slot, name);
                this.vm.load(VReg.A2, VReg.FP, newOff);
                this.vm.load(VReg.A0, VReg.FP, slot);
                this.emitBoxedStringKey(name, VReg.A1);
                this.vm.call(setHelper);
                if (expr.prefix) this.vm.fmovToInt(VReg.RET, 0);
                else this.vm.load(VReg.RET, VReg.FP, oldSlot);
                this.vm.jmp(doneL);
                this.vm.label(missL);
            }
            }
            // 全 miss → 词法 ++/--
            this._inWithResolve = true;
            this.compileUpdateExpression(expr);
            this._inWithResolve = false;
            this.vm.label(doneL);
            return;
        }
        if (expr.argument.type === "Identifier") {
            // sloppy const ++/--:blockscope 标 _constWrite,运行期 TypeError
            // (for (const i = 0; i < 1; i++) 族)。strict 已是解析期 SyntaxError。
            if (expr.argument._constWrite) {
                this.emitThrowTypeError("Assignment to constant variable.");
                return;
            }
            const name = expr.argument.name;
            const offset = this.ctx.getLocal(name);
            // [#56/A4] 顶层 hoisted function 体内对模块捕获变量(全局 box)的 ++/--：
            // 此处 offset 为 0(不是本函数局部)，原代码只有 `if (offset)` 分支 → 整个读-改-写
            // 被跳过 → 静默 no-op(c++ 不变、return c++ 返 undefined)。镜像 CompoundAssignment
            // 的 globalLabel 路径：box 指针来自全局 label，其余读-改-写与装箱局部完全一致。
            const globalLabel = (!offset && this.ctx.getMainCapturedVar) ? this.ctx.getMainCapturedVar(name) : null;
            const useGlobalBox = !!globalLabel && !offset;
            if (offset || useGlobalBox) {
                const isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(name);
                const isInt = this.ctx.isIntVar(name);

                // [P4.1] FP 累加器驻留变量:++/-- 直接作用于 FP 寄存器。此前走下方 slot 读改写,
                // 但循环出口把 FP 寄存器物化回 slot 会覆盖该写 → `for(i){c++}`(c 为 FP 累加器)
                // 的 ++ 静默丢失。表达式值:postfix=旧值、prefix=新值。
                const fpReg = this.ctx.getFpAccum(name);
                if (fpReg > 0) {
                    this.vm.fmovToInt(VReg.RET, fpReg); // 旧值(postfix 表达式值)
                    this.vm.movImm(VReg.V1, 0x3ff00000);
                    this.vm.shl(VReg.V1, VReg.V1, 32);  // 1.0 高32位 → float64 1.0
                    this.vm.fmovToFloat(1, VReg.V1);
                    if (expr.operator === "++") this.vm.fadd(fpReg, fpReg, 1);
                    else this.vm.fsub(fpReg, fpReg, 1);
                    if (expr.prefix) this.vm.fmovToInt(VReg.RET, fpReg); // prefix=新值
                    return;
                }

                if (isBoxed || useGlobalBox) {
                    // 装箱变量 / 模块捕获变量(全局 box)
                    if (useGlobalBox) {
                        this.vm.lea(VReg.V2, globalLabel);
                        this.vm.load(VReg.V2, VReg.V2, 0); // box 指针(全局)
                    } else {
                        this.vm.load(VReg.V2, VReg.FP, offset); // box 指针
                    }
                    this.vm.load(VReg.RET, VReg.V2, 0); // 当前值
                    this.emitUninitializedBindingGuard(name, VReg.RET);

                    if (expr.prefix) {
                        if (isInt) {
                            // int 类型：使用整数运算
                            if (expr.operator === "++") {
                                this.vm.addImm(VReg.RET, VReg.RET, 1);
                            } else {
                                this.vm.subImm(VReg.RET, VReg.RET, 1);
                            }
                        } else {
                            // Boxed slots may contain raw float bits, int32 JSValues, or heap Numbers.
                            // Normalize through ToNumber before applying ++/--.
                            this.vm.push(VReg.V2);
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_number_coerce");
                            this.vm.movImm(VReg.V1, 0x3ff00000);
                            this.vm.shl(VReg.V1, VReg.V1, 32);
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.fmovToFloat(1, VReg.V1);
                            if (expr.operator === "++") {
                                this.vm.fadd(0, 0, 1);
                            } else {
                                this.vm.fsub(0, 0, 1);
                            }
                            this.vm.fmovToInt(VReg.RET, 0);
                            this.vm.pop(VReg.V2);
                        }
                        this.vm.store(VReg.V2, 0, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                    } else {
                        this.vm.mov(VReg.V1, VReg.RET); // 保存原值
                        if (isInt) {
                            if (expr.operator === "++") {
                                this.vm.addImm(VReg.V1, VReg.V1, 1);
                            } else {
                                this.vm.subImm(VReg.V1, VReg.V1, 1);
                            }
                        } else {
                            // 后置表达式值 = ToNumber(old),不是原对象/函数。
                            // 此前 push 未 coerce 的旧值:`y=fn--` 在 isNaN(y) 走
                            // 第二次 ToNumber 时又撞 0x7FF8/int0 别名。
                            this.vm.push(VReg.V2); // box pointer
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_number_coerce");
                            this.vm.push(VReg.RET); // ToNumber(old)=postfix ret
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.movImm(VReg.V1, 0x3ff00000);
                            this.vm.shl(VReg.V1, VReg.V1, 32);
                            this.vm.fmovToFloat(1, VReg.V1);
                            if (expr.operator === "++") {
                                this.vm.fadd(0, 0, 1);
                            } else {
                                this.vm.fsub(0, 0, 1);
                            }
                            this.vm.fmovToInt(VReg.RET, 0);
                            this.emitNaNCanon();
                            this.vm.mov(VReg.V1, VReg.RET); // new
                            this.vm.pop(VReg.RET);          // postfix = ToNumber(old)
                            this.vm.pop(VReg.V2);           // box pointer
                        }
                        this.vm.store(VReg.V2, 0, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                        // 非 int:RET 已是 ToNumber(old);int:RET 仍是原整数值
                    }
                } else {
                    // 普通变量
                    // [#F65] slot 值可能是 tagged(boolean/null/undefined)或堆对象,
                    // 直接 fmovToFloat 会误解位模式 → NaN/垃圾。先 ToNumber 再浮点 ±1,
                    // 并加 NaN 规范化(同 compound-assignment [#nan-int0])。
                    this._loadLocalTemp(name, offset, VReg.RET);
                    if (expr.prefix) {
                        if (isInt) {
                            if (expr.operator === "++") {
                                this.vm.addImm(VReg.RET, VReg.RET, 1);
                            } else {
                                this.vm.subImm(VReg.RET, VReg.RET, 1);
                            }
                        } else {
                            this.vm.mov(VReg.A0, VReg.RET);
                            this.vm.call("_number_coerce");   // RET = float64
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.movImm(VReg.V1, 0x3ff00000);
                            this.vm.shl(VReg.V1, VReg.V1, 32);
                            this.vm.fmovToFloat(1, VReg.V1);
                            if (expr.operator === "++") {
                                this.vm.fadd(0, 0, 1);
                            } else {
                                this.vm.fsub(0, 0, 1);
                            }
                            this.vm.fmovToInt(VReg.RET, 0);
                            this.emitNaNCanon();
                        }
                        this._storeLocalTemp(name, offset, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                    } else {
                        // 后置：表达式值 = ToNumber(old),写回值 = ToNumber(old) ± 1。
                        // [#F65] 对 tagged/堆对象值先 ToNumber 再浮点 ±1。
                        this.vm.mov(VReg.V1, VReg.RET);
                        if (isInt) {
                            if (expr.operator === "++") {
                                this.vm.addImm(VReg.V1, VReg.V1, 1);
                            } else {
                                this.vm.subImm(VReg.V1, VReg.V1, 1);
                            }
                        } else {
                            this.vm.mov(VReg.A0, VReg.V1);
                            this.vm.call("_number_coerce");   // RET = float64(old) = postfix ret
                            this.vm.push(VReg.RET);          // 保护 postfix ret;SP-=16
                            this.vm.fmovToFloat(0, VReg.RET);
                            this.vm.movImm(VReg.V2, 0x3ff00000);
                            this.vm.shl(VReg.V2, VReg.V2, 32);
                            this.vm.fmovToFloat(1, VReg.V2);
                            if (expr.operator === "++") {
                                this.vm.fadd(0, 0, 1);
                            } else {
                                this.vm.fsub(0, 0, 1);
                            }
                            this.vm.fmovToInt(VReg.V1, 0);   // V1 = 浮点结果
                            this.vm.mov(VReg.RET, VReg.V1);  // RET = 结果(canon)
                            this.emitNaNCanon();             // [#nan-int0]
                            this.vm.mov(VReg.V1, VReg.RET);  // V1 = 规范化结果
                            this.vm.pop(VReg.RET);           // RET = postfix ret;SP+=16
                        }
                        this._storeLocalTemp(name, offset, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                        // RET = postfix 表达式值(ToNumber(old))
                    }
                }
            } else if (this.isUnresolvableIdentifier &&
                this.isUnresolvableIdentifier({ type: "Identifier", name: name })) {
                // 全局对象环境 ++/--:GetValue(globalThis.N) 后 ±1,strict 再 HasProperty。
                // 此前无词法槽时整段跳过 → 静默 no-op(putvalue x--/--x 不抛)。
                const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                    (this._currentModuleAst && this._currentModuleAst._bsStrict);
                const setHelper = strictSet ? "_object_set_strict" : "_object_set";
                const gOff = this._emitLoadBoxedGlobalThis();
                this._emitGlobalObjectEnvGet(gOff, name);
                const oldSlot = this.ctx.allocLocal(`__gupd_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, oldSlot, VReg.RET);
                this.vm.load(VReg.RET, VReg.FP, oldSlot);
                this.emitNumberCoerceFast();
                const oldNumOff = this.ctx.allocLocal(`__gupd_oldn_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, oldNumOff, VReg.RET);
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.movImm(VReg.V1, 0x3ff00000);
                this.vm.shl(VReg.V1, VReg.V1, 32);
                this.vm.fmovToFloat(1, VReg.V1);
                if (expr.operator === "++") this.vm.fadd(0, 0, 1);
                else this.vm.fsub(0, 0, 1);
                this.vm.fmovToInt(VReg.A2, 0);
                const newOff = this.ctx.allocLocal(`__gupd_new_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, newOff, VReg.A2);
                if (strictSet) this._emitStrictObjectEnvPutGuard(gOff, name);
                this.vm.load(VReg.A2, VReg.FP, newOff);
                this.vm.load(VReg.A0, VReg.FP, gOff);
                this.emitBoxedStringKey(name, VReg.A1);
                this.vm.call(setHelper);
                if (expr.prefix) this.vm.load(VReg.RET, VReg.FP, newOff);
                else this.vm.load(VReg.RET, VReg.FP, oldNumOff);
            }
        } else if (expr.argument.type === "MemberExpression" &&
            expr.argument.object && expr.argument.object.type === "SuperExpression") {
            // ++super[k] / super[k]++: update path compiled Super as this.
            // Prefix desugars to Super += 1 (GetSuperBase then ToPropertyKey).
            // Postfix: Super GET, then Super SET GET+1, return old.
            const one = { type: "Literal", value: 1 };
            if (expr.prefix) {
                this.compileMemberAssignment({
                    type: "AssignmentExpression",
                    operator: expr.operator === "++" ? "+=" : "-=",
                    left: expr.argument,
                    right: one,
                });
                return;
            }
            this.compileExpression(expr.argument);
            const oldOff = this.ctx.allocLocal(`__supupd_old_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, oldOff, VReg.RET);
            this.compileMemberAssignment({
                type: "AssignmentExpression",
                operator: expr.operator === "++" ? "+=" : "-=",
                left: expr.argument,
                right: one,
            });
            this.vm.load(VReg.RET, VReg.FP, oldOff);
            return;
        } else if (expr.argument.type === "MemberExpression") {
            // 成员自增/自减：obj.prop++ / obj[k]-- / arr[i]++ （原先未处理 → 静默 no-op，
            // 致 this.labelCounter++ 等失效 → 标签重复/野跳，是自举后期堆损坏/野跳的又一根因）。
            const member = expr.argument;
            const isInc = expr.operator === "++";
            // 全程用栈保存 obj/key/old/new（自包含、push/pop 平衡），避免 allocLocal 帧槽在
            // 模板字面量/拼接等外层表达式已 push 累加器的上下文里交互出错（原 allocLocal 版
            // 在 `${this.n++}` 里会野写 _object_set(NULL)）。
            // 1. 求值 object → 压栈
            this.compileExpression(member.object);
            this.vm.push(VReg.RET); // 栈: [obj]
            let dynKey = false, staticKey = null;
            if (member.computed) {
                const kn = (member.property.type === "Identifier")
                    ? null
                    : (this.getMemberPropertyName ? this.getMemberPropertyName(member.property) : null);
                if (kn !== null) {
                    staticKey = kn;
                } else {
                    this.compileExpression(member.property);
                    this.vm.push(VReg.RET); // 栈: [obj, key]
                    dynKey = true;
                }
            } else {
                staticKey = this.getMemberPropertyName(member.property);
            }
            // 闭包属性侧表路由(fn.x++ / fn.x--):接收者静态解析到函数(非类)且非计算键时,
            // 读/写改经 _closure_prop_get/_closure_prop_set(与 fn.x 读写路由一致;此前
            // update 路径直走 IC → 侧表被绕过,fn.x++ 读到 undefined、写进错误容器)。
            let updFnProp = false;
            if (!member.computed && staticKey !== null && staticKey !== "prototype" &&
                this._resolveFnNode) {
                const _ufr = this._resolveFnNode(member.object);
                if (_ufr && (_ufr.node.type === "FunctionDeclaration" ||
                    _ufr.node.type === "FunctionExpression" || _ufr.node.type === "ArrowFunctionExpression")) {
                    updFnProp = true;
                }
            }
            // 2. 读旧值 obj[key]。push 槽宽因后端而异：arm64 stp reg,xzr,[sp,#-16]! 每格
            // 16 字节；x64 pushq 每格 8 字节。偏移按 slot 递增（原硬编码 16 在 x64 上
            // 读错槽 → _object_set(NULL) FATAL，是 this.labelCounter++ 自举崩溃根因）。
            const updSlot = this.vm.backend.name === "x64" ? 8 : 16;
            if (dynKey) {
                // EvaluatePropertyAccessWithExpressionKey:RequireObjectCoercible(base)
                // 先于 ToPropertyKey。_subscript_get_nullish 为拼 message 会
                // _valueToStr(key) → 键对象 toString 抢先抛
                // (S11.4.4_A6_T1 / S11.3.2_A6_T2)。ToPropertyKey 只一次,读写共用
                // (S11.4.5_A6_T3)。热路径 this.n++ 非计算键,不受影响。
                const okL = this.ctx.newLabel("upd_base_ok");
                const badL = this.ctx.newLabel("upd_base_nullish");
                this.vm.load(VReg.V0, VReg.SP, updSlot);
                this.vm.shrImm(VReg.V1, VReg.V0, 48);
                this.vm.cmpImm(VReg.V1, 0x7FFA);
                this.vm.jeq(badL);
                this.vm.cmpImm(VReg.V1, 0x7FFB);
                this.vm.jne(okL);
                this.vm.label(badL);
                this.emitThrowTypeError("Cannot read properties of null or undefined");
                this.vm.label(okL);
                this.vm.load(VReg.A0, VReg.SP, 0);
                this.vm.call("_js_prop_key");
                this.vm.store(VReg.SP, 0, VReg.RET);
                this.vm.load(VReg.A1, VReg.SP, 0);
                this.vm.load(VReg.A0, VReg.SP, updSlot);
                this.vm.call("_subscript_get");
            } else if (updFnProp) {
                this.vm.load(VReg.A0, VReg.SP, 0);   // obj(函数值)
                this.emitBoxedStringKey(staticKey, VReg.A1);
                this.vm.call("_closure_prop_get");
            } else {
                this.vm.load(VReg.RET, VReg.SP, 0);  // obj
                this.emitObjectGetIC(staticKey);     // [P2] 站点缓存(getter 已融合)
            }
            // 3. ToNumber(old) → 压栈
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_number_coerce");
            this.vm.push(VReg.RET); // 栈: [obj,(key,)old]
            // 4. new = old ± 1.0 → 压栈
            this.vm.movImm(VReg.V1, 0x3ff00000);
            this.vm.shl(VReg.V1, VReg.V1, 32);
            this.vm.fmovToFloat(0, VReg.RET);
            this.vm.fmovToFloat(1, VReg.V1);
            if (isInc) { this.vm.fadd(0, 0, 1); } else { this.vm.fsub(0, 0, 1); }
            this.vm.fmovToInt(VReg.RET, 0);
            this.vm.push(VReg.RET); // 栈顶→底(每格 slot): new@0,old@slot,(key@2slot,)obj@(dynKey?3slot:2slot)
            // 5. 写回 obj[key] = new
            if (dynKey) {
                this.vm.load(VReg.A2, VReg.SP, 0);   // new
                this.vm.load(VReg.A1, VReg.SP, 2 * updSlot);  // key
                this.vm.load(VReg.A0, VReg.SP, 3 * updSlot);  // obj
                {
                    const strictSet = (this.ctx && this.ctx.inStrictFunction) ||
                        (this._currentModuleAst && this._currentModuleAst._bsStrict);
                    this.vm.call(strictSet ? "_subscript_set_strict" : "_subscript_set");
                }
            } else if (updFnProp) {
                this.vm.load(VReg.A2, VReg.SP, 0);   // new
                this.vm.load(VReg.A0, VReg.SP, 2 * updSlot);  // obj(函数值)
                this.emitBoxedStringKey(staticKey, VReg.A1);
                const _updFnStrict = (this.ctx && this.ctx.inStrictFunction) ||
                    (this._currentModuleAst && this._currentModuleAst._bsStrict);
                this.vm.call(_updFnStrict ? "_closure_prop_set_strict" : "_closure_prop_set");
            } else {
                this.vm.load(VReg.A0, VReg.SP, 2 * updSlot);  // obj
                this.vm.load(VReg.A2, VReg.SP, 0);   // new
                this.emitObjectSetIC(staticKey); // [P2] 站点缓存(key→A1/site→A3/call)
            }
            // 6. 结果：prefix→new(SP+0)，postfix→old(SP+slot)
            this.vm.load(VReg.RET, VReg.SP, expr.prefix ? 0 : updSlot);
            // 7. 清栈（pop 到废寄存器，RET 不受影响；x64 上 V0==RET==RAX，改用 V1）
            const updScrap = this.vm.backend.name === "x64" ? VReg.V1 : VReg.V0;
            this.vm.pop(updScrap); // new
            this.vm.pop(updScrap); // old
            if (dynKey) { this.vm.pop(updScrap); } // key
            this.vm.pop(updScrap); // obj
        }
    },

    // 编译浮点自增/自减 (Number 对象版本)
    // RET 包含当前 Number 对象指针，结果是新的 Number 对象指针存回 RET
    compileFloatIncDec(isIncrement) {
        // 使用 VM 的统一浮点接口
        // 1. 从 Number 对象加载 float64 位
        this.vm.load(VReg.V0, VReg.RET, 8); // V0 = float64 位
        this.vm.fmovToFloat(0, VReg.V0); // FP0 = float

        // 2. 加载 1.0 到 FP1 (IEEE 754: 0x3ff0_0000_0000_0000)
        this.vm.movImm(VReg.V1, 0x3ff00000);
        this.vm.shl(VReg.V1, VReg.V1, 32);
        this.vm.fmovToFloat(1, VReg.V1);

        // 3. 执行加法或减法
        if (isIncrement) {
            this.vm.fadd(0, 0, 1);
        } else {
            this.vm.fsub(0, 0, 1);
        }

        // 4. 移回整数寄存器，保存到 S0
        this.vm.fmovToInt(VReg.S0, 0);

        // 5. 统一走 boxNumber，避免在各处重复手写装箱逻辑
        this.boxNumber(VReg.S0);
    },

    // [L4.2] 保守的字符串累加逃逸门控。仅当变量所有写入都是字符串字面量
    // 或门控拼接、且在最后一次拼接前没有可观察别名时，才允许原地追加。
    _canIpStringAccum(name) {
        const root = this.ctx && this.ctx._ipScanRoot;
        // Bootstrap determinism: compiler/runtime sources are themselves
        // self-hosted and must retain their canonical concat instruction stream.
        // Restrict L4 to user/test modules; this still covers test262's
        // buildString hot path while avoiding gen1→gen2 drift in toolchain code.
        const srcPath = this.sourcePath || (this._currentModuleAst && this._currentModuleAst.filename) || "";
        // 禁正则字面量（自举：toolchain 不注入 __regexp_shim）。
        if (typeof srcPath === "string") {
            if (srcPath.indexOf("/compiler/") !== -1 || srcPath.indexOf("/runtime/") !== -1 ||
                srcPath.indexOf("/lang/") !== -1 || srcPath.indexOf("/vm/") !== -1 ||
                srcPath.indexOf("/backend/") !== -1 || srcPath.indexOf("/asm/") !== -1) {
                return false;
            }
        }
        if (!root || (this.ctx._ipExportedNames && this.ctx._ipExportedNames.has(name))) return false;
        let index = this.ctx._ipIndex;
        if (!index) index = this.ctx._ipIndex = this._buildIpIndex(root);
        if (index.paramNames.has(name)) return false;
        const e = index.per.get(name);
        if (!e || e.appends.length === 0 || e.nestedRef || e.badWrite) return false;
        const lastAppend = e.appends[e.appends.length - 1];
        let activeEnd = lastAppend;
        for (let i = 0; i < index.loops.length; i++) {
            const L = index.loops[i];
            if (L[0] <= lastAppend && lastAppend <= L[1]) { activeEnd = L[1]; break; }
        }
        for (let i = 0; i < e.escapes.length; i++) if (e.escapes[i] <= activeEnd) return false;
        return true;
    },

    // inferType cannot see the compiler's special `String.fromCodePoint.apply`
    // lowering, so recognize that exact builtin shape as a string producer.
    _isKnownStringExpr(expr) {
        if (!expr) return false;
        if (inferType(expr, this.ctx) === Type.STRING) return true;
        if (expr.type !== "CallExpression" || !expr.callee || expr.callee.type !== "MemberExpression") return false;
        const p = expr.callee.property;
        const o = expr.callee.object;
        if (!p || p.type !== "Identifier" || p.name !== "apply" || !o || o.type !== "MemberExpression") return false;
        return o.object && o.object.type === "Identifier" && o.object.name === "String" &&
            o.property && o.property.type === "Identifier" &&
            (o.property.name === "fromCodePoint" || o.property.name === "fromCharCode");
    },

    _buildIpIndex(root) {
        let idx = 0, fnDepth = 0;
        const loops = [];
        const per = new Map();
        const paramNames = new Set();
        const entry = (nm) => {
            let e = per.get(nm);
            if (!e) { e = { appends: [], escapes: [], badWrite: false, nestedRef: false }; per.set(nm, e); }
            return e;
        };
        const isStrLit = (n) => n && (n.type === "StringLiteral" || n.type === "TemplateLiteral" ||
            (n.type === "Literal" && typeof n.value === "string"));
        const isStringProducer = (n) => {
            if (isStrLit(n)) return true;
            if (!n || n.type !== "CallExpression" || !n.callee || n.callee.type !== "MemberExpression") return false;
            const p = n.callee.property, o = n.callee.object;
            return p && p.type === "Identifier" && p.name === "apply" && o && o.type === "MemberExpression" &&
                o.object && o.object.type === "Identifier" && o.object.name === "String" &&
                o.property && o.property.type === "Identifier" &&
                (o.property.name === "fromCodePoint" || o.property.name === "fromCharCode");
        };
        const isGatedFor = (n, nm) => n && n.type === "AssignmentExpression" && n.left &&
            n.left.type === "Identifier" && n.left.name === nm &&
            (n.operator === "+=" || (n.operator === "=" && n.right && n.right.type === "BinaryExpression" &&
             n.right.operator === "+" && n.right.left && n.right.left.type === "Identifier" &&
             n.right.left.name === nm));
        const collectParams = (n) => {
            if (!n || typeof n !== "object") return;
            if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) collectParams(n[i]); return; }
            if (n.type === "Identifier" && n.name) paramNames.add(n.name);
            for (const k in n) if (k !== "type") collectParams(n[k]);
        };
        collectParams(root.params || []);
        const walk = (node, parent, grand) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) walk(node[i], parent, grand); return; }
            const my = idx++;
            const t = node.type;
            if (typeof t === "string" && t.indexOf("Function") >= 0) {
                fnDepth++;
                for (const k in node) if (k !== "type") walk(node[k], node, parent);
                fnDepth--;
                return;
            }
            let loopRec = null;
            if (t === "ForStatement" || t === "ForInStatement" || t === "ForOfStatement" ||
                t === "WhileStatement" || t === "DoWhileStatement") {
                loopRec = [my, my]; loops.push(loopRec);
            }
            if (t === "Identifier" && node.name) {
                const nm = node.name;
                if (fnDepth > 0) entry(nm).nestedRef = true;
                else if (parent && ((parent.type === "VariableDeclarator" && parent.id === node) ||
                    (parent.type === "FunctionDeclaration" && parent.id === node) ||
                    (parent.type === "ClassDeclaration" && parent.id === node))) {
                    // declaration binding, not a read
                } else if (parent && parent.type === "AssignmentExpression" && parent.left === node && isGatedFor(parent, nm)) {
                    entry(nm).appends.push(my);
                } else if (grand && grand.type === "AssignmentExpression" && isGatedFor(grand, nm) &&
                           grand.right === parent && parent && parent.type === "BinaryExpression" && parent.left === node) {
                    // accumulator read in `s = s + E`
                } else entry(nm).escapes.push(my);
            }
            if (fnDepth === 0) {
                if (t === "AssignmentExpression" && node.left && node.left.type === "Identifier" && node.left.name) {
                    const nm = node.left.name;
                    if (!isGatedFor(node, nm) && !(node.operator === "=" && isStringProducer(node.right))) entry(nm).badWrite = true;
                }
                if (t === "VariableDeclarator" && node.id && node.id.type === "Identifier" && node.id.name &&
                    node.init && !isStringProducer(node.init)) entry(node.id.name).badWrite = true;
                if (t === "UpdateExpression" && node.argument && node.argument.type === "Identifier" && node.argument.name) {
                    entry(node.argument.name).badWrite = true;
                }
            }
            for (const k in node) if (k !== "type") walk(node[k], node, parent);
            if (loopRec) loopRec[1] = idx;
        };
        walk(root.body, null, null);
        return { per, loops, paramNames };
    },

};

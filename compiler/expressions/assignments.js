// asm.js 编译器 - 赋值表达式编译
// 编译各类赋值：简单赋值、复合赋值、成员赋值、更新表达式

import { VReg } from "../../vm/index.js";
import { Type, isIntType, isFloatType, inferType } from "../core/types.js";
// 赋值编译方法混入
export const AssignmentCompiler = {
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

            // with(obj) 作用域赋值:命中 with 对象则写其属性(否则回退词法)。RHS 只求值一次
            // (存帧槽),命中走 _object_set,miss 用合成 __WithPrecomputed 节点复用普通赋值全逻辑。
            if (this.ctx.withScopes && this.ctx.withScopes.length > 0 && !this._inWithResolve) {
                this.compileExpression(expr.right);
                const vSlot = this.ctx.allocLocal(`__withasgn_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, vSlot, VReg.RET);
                // 复合运算符(+= 等)+ with 目标属性的读改写:本切片仅支持简单 "=" 走 with;
                // 复合赋值回退词法(记偏差)。
                if (expr.operator === "=") {
                    const doneL = this.ctx.newLabel("withasgn_done");
                    for (let i = this.ctx.withScopes.length - 1; i >= 0; i--) {
                        const missL = this.ctx.newLabel("withasgn_miss");
                        const slot = this.ctx.withScopes[i];
                        this.vm.load(VReg.A0, VReg.FP, slot);
                        this.emitBoxedStringKey(name, VReg.A1);
                        this.vm.call("_object_has");
                        this.vm.cmpImm(VReg.RET, 0);
                        this.vm.jeq(missL);
                        this.vm.load(VReg.A0, VReg.FP, slot);
                        this.emitBoxedStringKey(name, VReg.A1);
                        this.vm.load(VReg.A2, VReg.FP, vSlot);
                        this.vm.call("_object_set");
                        this.vm.jmp(doneL);
                        this.vm.label(missL);
                    }
                    // miss → 词法赋值(合成 RHS 读 vSlot,不重求值)
                    this._inWithResolve = true;
                    this.compileAssignmentExpression({
                        type: "AssignmentExpression", operator: "=",
                        left: expr.left, right: { type: "__WithPrecomputed", slot: vSlot },
                    });
                    this._inWithResolve = false;
                    this.vm.label(doneL);
                    this.vm.load(VReg.RET, VReg.FP, vSlot); // 赋值表达式值 = RHS
                    return;
                }
                // 复合赋值:回退普通词法路径(RHS 已在 vSlot,用合成节点避免重求值)
                this._inWithResolve = true;
                this.compileAssignmentExpression({
                    type: "AssignmentExpression", operator: expr.operator,
                    left: expr.left, right: { type: "__WithPrecomputed", slot: vSlot },
                });
                this._inWithResolve = false;
                return;
            }

            const offset = this.ctx.getLocal(name);

            // 检查是否是主程序被捕获的变量（从全局位置访问）
            const globalLabel = this.ctx.getMainCapturedVar(name);

            if (!offset && !globalLabel) return;

            const op = expr.operator;
            const isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(name);

            // [解箱① P4.1] 浮点累加器驻留 FP 寄存器:`s=s<op>E` / `s<op>=E` 直发
            // f<op> d_reg,d_reg,d_tmp,免 slot 往返/coerce 守卫/操作数压栈。
            const fpReg = this.ctx.getFpAccum(name);
            if (fpReg > 0) {
                let fop = null, eExpr = null;
                if (op === "=") {
                    const r = expr.right;
                    if (r && r.type === "BinaryExpression" && r.left &&
                        r.left.type === "Identifier" && r.left.name === name &&
                        ["+", "-", "*", "/", "%"].indexOf(r.operator) >= 0) {
                        fop = r.operator; eExpr = r.right;
                    }
                } else if (["+=", "-=", "*=", "/=", "%="].indexOf(op) >= 0) {
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
                this.vm.store(VReg.FP, offset, VReg.RET);
                this.ctx.fpAccumVars[name] = 0;
            }

            // 简单赋值
            if (op === "=") {
                // [L4.2 字符串原地拼接] 逃逸门控:`s = s + E`(含 `s += E` 解糖形态)。
                // 门控通过时设 _ipConcatVar,compileStringConcat 发 _str_concat_ip(旧串为
                // 堆串且容量足 → 就地追加返同指针;不满足则运行时尾委托 _strconcat,
                // 逐字节等价旧语义)。静态非拼接路径(右侧非串 → _js_add)不受影响。
                // 否决前置:装箱变量(闭包捕获)、主程序被捕获变量、with 作用域活跃、
                // 右侧静态非串(数值累加等根本不进 compileStringConcat,免扫描)。
                const _ipCand = expr.right && expr.right.type === "BinaryExpression" &&
                    expr.right.operator === "+" && expr.right.left &&
                    expr.right.left.type === "Identifier" && expr.right.left.name === name &&
                    inferType(expr.right.right, this.ctx) === Type.STRING &&
                    !isBoxed && !globalLabel &&
                    !(this.ctx.withScopes && this.ctx.withScopes.length > 0) &&
                    this._canIpStringAccum(name);
                if (_ipCand) this.ctx._ipConcatVar = name;
                this.compileExpression(expr.right);
                if (_ipCand) this.ctx._ipConcatVar = null;

                // 二元表达式（算术运算和字符串连接）返回 raw bits 或 NaN-boxed，
                // 不是 boxed Number，不需要 unbox
                // 注意：compileExpression 对 +,-,*,/ 已经返回 raw bits

                if (globalLabel && !offset) {
                    // 主程序被捕获变量的赋值（在顶层函数中）
                    this.vm.mov(VReg.V1, VReg.RET); // 保存要存的值
                    this.vm.lea(VReg.V2, globalLabel);
                    this.vm.load(VReg.V2, VReg.V2, 0); // 加载 box 指针
                    this.vm.store(VReg.V2, 0, VReg.V1); // 存入 box
                    this.vm.mov(VReg.RET, VReg.V1); // 返回值
                } else if (isBoxed) {
                    // 装箱变量：先加载 box 指针，然后存值到 box
                    this.vm.mov(VReg.V1, VReg.RET); // 保存要存的值
                    this.vm.load(VReg.V2, VReg.FP, offset); // 加载 box 指针
                    this.vm.store(VReg.V2, 0, VReg.V1); // 存入 box
                    this.vm.mov(VReg.RET, VReg.V1); // 返回值
                } else {
                    this.vm.store(VReg.FP, offset, VReg.RET);
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
                    this.vm.load(VReg.RET, VReg.FP, offset);
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
                    this.vm.store(VReg.FP, offset, VReg.RET);
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
                this.vm.load(VReg.V1, VReg.FP, offset); // V1 = 左操作数 raw bits
            } else {
                this.vm.load(VReg.RET, VReg.FP, offset);
            }

            if (isUnboxedArith && op === "+=") {
                // += 需要完整的 JS 加法语义（字符串拼接/数值），走运行时分派
                this.vm.push(VReg.V1);
                this.compileExpression(expr.right);
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.pop(VReg.A0);
                this.vm.call("_js_add");
                this.vm.store(VReg.FP, offset, VReg.RET);
            } else if (isUnboxedArith) {
                // 浮点运算路径
                this.vm.fmovToFloat(0, VReg.V1); // FP0 = 左操作数
                this.compileExpression(expr.right); // RET = 右操作数 raw bits
                this.vm.fmovToFloat(1, VReg.RET); // FP1 = 右操作数

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
                // 存储回 slot
                this.vm.store(VReg.FP, offset, VReg.RET);
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
                    this.vm.store(VReg.FP, offset, VReg.RET);
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
            let dsMember = member;
            if (!this.isPureExpr(member.object) || (member.computed && !this.isPureExpr(member.property))) {
                const did = this.nextLabelId();
                this.compileExpression(member.object);
                const dsObjSlot = this.ctx.allocLocal(`__cma_obj_${did}`);
                this.vm.store(VReg.FP, dsObjSlot, VReg.RET);
                let dsProp = member.property;
                if (member.computed && !this.isPureExpr(member.property)) {
                    this.compileExpression(member.property);
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
            this.vm.mov(VReg.A0, VReg.RET);
            this.vm.call("_number_coerce");               // RET = float64 位
            this.vm.fmovToFloat(0, VReg.RET);
            this.vm.fcvtzs(VReg.RET, 0);                   // RET = 裸整数 n
            this.vm.mov(VReg.A1, VReg.RET);                // A1 = n
            this.vm.load(VReg.A0, VReg.FP, slenObjOff);    // A0 = 对象
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
            this.vm.call("_closure_prop_set");
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
                this.emitBoxedStringKey(computedPropName, VReg.A1);
                this.vm.call("_object_set");
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
                this.vm.call("_subscript_set");
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
                this.vm.call("_subscript_set");
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
        // with(obj) 内 n++/--n:经 with-read 取旧值、with-assign 写回(运行时目标一致)。
        // 旧值存槽,合成 `n = (旧值) ± 1` 走 with 赋值;postfix 返旧值、prefix 返新值。
        if (expr.argument.type === "Identifier" && !this._inWithResolve &&
            this.ctx.withScopes && this.ctx.withScopes.length > 0) {
            this.compileExpression(expr.argument); // with-read 旧值
            const oldSlot = this.ctx.allocLocal(`__withupd_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, oldSlot, VReg.RET);
            const binOp = expr.operator === "++" ? "+" : "-";
            this.compileAssignmentExpression({
                type: "AssignmentExpression", operator: "=", left: expr.argument,
                right: {
                    type: "BinaryExpression", operator: binOp,
                    left: { type: "__WithPrecomputed", slot: oldSlot },
                    right: { type: "NumericLiteral", value: 1 },
                },
            });
            if (!expr.prefix) this.vm.load(VReg.RET, VReg.FP, oldSlot); // postfix 返旧值
            return;
        }
        if (expr.argument.type === "Identifier") {
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
                            this.vm.push(VReg.V2); // box pointer
                            this.vm.push(VReg.RET); // original expression result
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
                            this.vm.pop(VReg.V1); // original expression result
                            this.vm.pop(VReg.V2); // box pointer
                        }
                        this.vm.store(VReg.V2, 0, isInt ? VReg.V1 : VReg.RET);
                        this.syncModuleExportBinding(name, isInt ? VReg.V1 : VReg.RET);
                        if (!isInt) {
                            this.vm.mov(VReg.RET, VReg.V1);
                        }
                        // RET 保持原值
                    }
                } else {
                    // 普通变量
                    this.vm.load(VReg.RET, VReg.FP, offset);
                    if (expr.prefix) {
                        if (isInt) {
                            if (expr.operator === "++") {
                                this.vm.addImm(VReg.RET, VReg.RET, 1);
                            } else {
                                this.vm.subImm(VReg.RET, VReg.RET, 1);
                            }
                        } else {
                            // float 类型：使用浮点运算 (unboxed 直接操作 raw bits)
                            this.vm.fmovToFloat(0, VReg.RET); // FP0 = float bits
                            // 加载 1.0 到 FP1
                            this.vm.movImm(VReg.V1, 0x3ff00000);
                            this.vm.shl(VReg.V1, VReg.V1, 32);
                            this.vm.fmovToFloat(1, VReg.V1);
                            // 执行加法或减法
                            if (expr.operator === "++") {
                                this.vm.fadd(0, 0, 1);
                            } else {
                                this.vm.fsub(0, 0, 1);
                            }
                            // 移回整数寄存器
                            this.vm.fmovToInt(VReg.RET, 0);
                        }
                        this.vm.store(VReg.FP, offset, VReg.RET);
                        this.syncModuleExportBinding(name, VReg.RET);
                    } else {
                        // 后置：先保存原值
                        this.vm.mov(VReg.V1, VReg.RET);
                        if (isInt) {
                            if (expr.operator === "++") {
                                this.vm.addImm(VReg.V1, VReg.V1, 1);
                            } else {
                                this.vm.subImm(VReg.V1, VReg.V1, 1);
                            }
                        } else {
                            // float 类型：使用浮点运算 (unboxed 直接操作 raw bits)
                            this.vm.fmovToFloat(0, VReg.V1); // FP0 = original value bits
                            // 加载 1.0 到 FP1
                            this.vm.movImm(VReg.V2, 0x3ff00000);
                            this.vm.shl(VReg.V2, VReg.V2, 32);
                            this.vm.fmovToFloat(1, VReg.V2);
                            // 执行加法或减法
                            if (expr.operator === "++") {
                                this.vm.fadd(0, 0, 1);
                            } else {
                                this.vm.fsub(0, 0, 1);
                            }
                            // 移回整数寄存器到 V1 (V1 会被存回)
                            this.vm.fmovToInt(VReg.V1, 0);
                            // RET 已经保存原值，无需额外操作
                        }
                        this.vm.store(VReg.FP, offset, VReg.V1);
                        this.syncModuleExportBinding(name, VReg.V1);
                        // RET 保持原值（后置表达式的值）
                    }
                }
            }
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
                this.vm.load(VReg.A1, VReg.SP, 0);   // key
                this.vm.load(VReg.A0, VReg.SP, updSlot);  // obj
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
                this.vm.call("_subscript_set");
            } else if (updFnProp) {
                this.vm.load(VReg.A2, VReg.SP, 0);   // new
                this.vm.load(VReg.A0, VReg.SP, 2 * updSlot);  // obj(函数值)
                this.emitBoxedStringKey(staticKey, VReg.A1);
                this.vm.call("_closure_prop_set");
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

    // [L4.2 字符串原地拼接] 逃逸门控:函数级保守语法分析(不做 SSA/活性)。
    // 全部成立才允许把 `s = s + E` / `s += E` 发射为 _str_concat_ip(见 docs/STR_CONCAT_L4_DESIGN.md §2.3):
    //   ① s 不是形参(含解构/默认值/rest 子树);② 模块顶层时 s 未被导出(import 侧可别名);
    //   ③ 至少一个门控拼接形态;④ s 的每次写入均为 串字面量/模板字面量/门控拼接形态
    //   (其他类型或来源否决;`let s;` 无初值允许——运行时守卫对非串旧值委托 _strconcat);
    //   ⑤ 别名化引用(t=s / f(s) / return s / [s] / {x:s} / s.x / s() / typeof s …)只允许
    //   出现在**活跃区之后**(活跃区 = 含末次门控拼接的最外层循环;无循环则到末次拼接止);
    //   ⑥ 嵌套函数内引用 s 一律否决(捕获语义,与 boxedVars 检查双保险)。
    // 正确性根基:④ 保证 s 持有的堆块要么来自全新拼接分配(唯一引用),要么是数据段
    // 字面量(运行时守卫对只读数据段串恒委托 _strconcat);⑤ 保证唯一引用不被别名。
    // 实现:扫描根(函数/模块 AST)**单次遍历建索引**(每名字收集 append/escape/写入事实
    // + 循环区间表),按名裁决 O(该名引用数)——避免"每候选站点全函数走一遍"在模块级
    // 大 AST 上退化成 O(规模 × 名字数)(曾使 gen0 自编译 1.55s → 3.13s)。
    _canIpStringAccum(name) {
        const root = this.ctx._ipScanRoot;
        if (!root) return false;
        if (this.ctx._ipExportedNames && this.ctx._ipExportedNames.has(name)) return false;
        let index = this.ctx._ipIndex;
        if (!index) index = this.ctx._ipIndex = this._buildIpIndex(root);
        if (index.paramNames.has(name)) return false;
        const e = index.per.get(name);
        if (!e || e.appends.length === 0 || e.nestedRef || e.badWrite) return false;
        // 活跃区终点:含末次拼接的最外层循环(前序入栈,外先内后 → 首个命中即最外);无循环取末次拼接
        let lastAppend = e.appends[e.appends.length - 1];
        let activeEnd = lastAppend;
        for (let i = 0; i < index.loops.length; i++) {
            const L = index.loops[i];
            if (L[0] <= lastAppend && lastAppend <= L[1]) { activeEnd = L[1]; break; }
        }
        for (let i = 0; i < e.escapes.length; i++) if (e.escapes[i] <= activeEnd) return false;
        return true;
    },

    _buildIpIndex(root) {
        let idx = 0, fnDepth = 0;
        const loops = []; // [入序, 出序]
        const per = new Map(); // name -> { appends: [], escapes: [], badWrite, nestedRef }
        const paramNames = new Set();
        const entry = (nm) => {
            let e = per.get(nm);
            if (!e) { e = { appends: [], escapes: [], badWrite: false, nestedRef: false }; per.set(nm, e); }
            return e;
        };
        const isStrLit = (n) => n != null && (n.type === "StringLiteral" ||
            n.type === "TemplateLiteral" || (n.type === "Literal" && typeof n.value === "string"));
        const isGatedFor = (n, nm) => n != null && n.type === "AssignmentExpression" &&
            n.left && n.left.type === "Identifier" && n.left.name === nm &&
            (n.operator === "+=" || (n.operator === "=" && n.right != null &&
             n.right.type === "BinaryExpression" && n.right.operator === "+" &&
             n.right.left && n.right.left.type === "Identifier" && n.right.left.name === nm));
        // 形参子树内全部名字(覆盖解构/默认值/rest)→ 这些名字永不入原地拼接
        const collectParams = (n) => {
            if (!n || typeof n !== "object") return;
            if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) collectParams(n[i]); return; }
            if (n.type === "Identifier" && n.name) paramNames.add(n.name);
            for (const k in n) { if (k !== "type") collectParams(n[k]); }
        };
        collectParams(root.params || []);

        const walk = (node, parent, grand) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) walk(node[i], parent, grand); return; }
            const my = idx++;
            const t = node.type;
            if (typeof t === "string" && t.indexOf("Function") >= 0) {
                fnDepth++;
                for (const k in node) { if (k !== "type") walk(node[k], node, parent); }
                fnDepth--;
                return;
            }
            let loopRec = null;
            if (t === "ForStatement" || t === "ForInStatement" || t === "ForOfStatement" ||
                t === "WhileStatement" || t === "DoWhileStatement") {
                loopRec = [my, my];
                loops.push(loopRec);
            }
            if (t === "Identifier" && node.name) {
                const nm = node.name;
                if (fnDepth > 0) {
                    entry(nm).nestedRef = true; // 嵌套函数内引用 → 捕获语义 → 否决
                } else if (parent && ((parent.type === "VariableDeclarator" && parent.id === node) ||
                    (parent.type === "FunctionDeclaration" && parent.id === node) ||
                    (parent.type === "ClassDeclaration" && parent.id === node))) {
                    // 绑定位置(声明 id),非引用 → 不计
                } else if (parent && parent.type === "AssignmentExpression" && parent.left === node && isGatedFor(parent, nm)) {
                    entry(nm).appends.push(my); // 门控拼接的赋值目标
                } else if (grand && grand.type === "AssignmentExpression" && isGatedFor(grand, nm) &&
                           grand.right === parent && parent && parent.type === "BinaryExpression" && parent.left === node) {
                    // 门控拼接 `s = s + E` 的累加读(二元左侧的 s):允许,不计
                } else {
                    entry(nm).escapes.push(my); // 其余一切引用 = 潜在别名化
                }
            }
            if (fnDepth === 0) {
                if (t === "AssignmentExpression" && node.left && node.left.type === "Identifier" && node.left.name) {
                    const nm = node.left.name;
                    if (!isGatedFor(node, nm) && !(node.operator === "=" && isStrLit(node.right))) entry(nm).badWrite = true;
                }
                if (t === "VariableDeclarator" && node.id && node.id.type === "Identifier" && node.id.name) {
                    if (node.init && !isStrLit(node.init)) entry(node.id.name).badWrite = true;
                }
                if (t === "UpdateExpression" && node.argument && node.argument.type === "Identifier" && node.argument.name) {
                    entry(node.argument.name).badWrite = true; // s++/s-- → 非串写 → 否决
                }
            }
            for (const k in node) { if (k !== "type") walk(node[k], node, parent); }
            if (loopRec) loopRec[1] = idx;
        };
        walk(root.body, null, null);
        return { per: per, loops: loops, paramNames: paramNames };
    },
};

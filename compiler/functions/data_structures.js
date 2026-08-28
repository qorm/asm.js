// asm.js 编译器 - 数据结构编译
// 编译数组表达式、对象表达式

import { VReg } from "../../vm/registers.js";
import { Type, inferType } from "../core/types.js";

// getter/setter 标记对象类型（与 runtime/core/allocator.js TYPE_GETTER 一致）
const TYPE_GETTER = 60;

// 数据结构编译方法混入
export const DataStructureCompiler = {
    // 编译数组表达式 [a, b, c]
    compileArrayExpression(expr) {
        const elements = expr.elements || [];
        const count = elements.length;

        // 含扩展 [...a, x]：走动态 push 构建路径
        for (let si = 0; si < count; si++) {
            if (elements[si] && elements[si].type === "SpreadElement") {
                this.compileArrayExpressionWithSpread(elements);
                return;
            }
        }

        // 统一走数组运行时封装，避免手写数组头/布局导致的不一致
        this.vm.movImm(VReg.A0, count);
        this.vm.call("_array_new_with_size");

        // 将数组指针保存到局部变量槽位，避免被 compileExpression 破坏
        const arrTempName = `__arr_temp_${this.nextLabelId()}`;
        const arrOffset = this.ctx.allocLocal(arrTempName);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 填充元素：_array_set(arr, index, value)
        for (let i = 0; i < count; i++) {
            if (!elements[i]) {
                // 空位洞 [1,,3]:保留 _array_new_with_size 初值 0(真 hole)。
                // 勿填 undefined——那是 dense-with-undefined,`1 in a` 会误 true。
                continue;
            }
            this.compileExpression(elements[i]);
            this.vm.mov(VReg.A2, VReg.RET);
            this.vm.load(VReg.A0, VReg.FP, arrOffset);
            this.vm.movImm(VReg.A1, i);
            this.vm.call("_array_set");
        }

        // 将原始指针装箱为 JSValue 数组
        // JSValue = (ptr & 0x0000ffffffffffff) | 0x7ffe000000000000
        this.vm.load(VReg.V2, VReg.FP, arrOffset);  // V2 = 原始指针
        this.vm.emitMaskLoad(VReg.V1);  // V1 = MASK
        this.vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1);  // V2 = V2 & V1 = ptr & MASK
        this.vm.movImm64(VReg.V1, 0x7ffe000000000000n);  // V1 = TAG (array)
        this.vm.or(VReg.RET, VReg.V2, VReg.V1);  // RET = (ptr & MASK) | TAG
    },

    // 编译含扩展元素的数组 [a, ...b, c]
    // 建 length=0 空数组（容量 MIN），逐元素 _array_push（捕获扩容后新指针）；
    // 扩展元素运行时遍历源数组逐个 push。
    compileArrayExpressionWithSpread(elements) {
        this.vm.movImm(VReg.A0, 0);
        this.vm.call("_array_new_with_size");     // RET = boxed 空数组
        const arrOff = this.ctx.allocLocal(`__arrsp_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOff, VReg.RET);

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (!el) {
                // 稀疏空位 [1,,...x]:push undefined(dense-with-undefined,与非 spread 路径一致)
                this.vm.movImm64(VReg.A1, 0x7ffb000000000000n); // JS_UNDEFINED
                this.vm.load(VReg.A0, VReg.FP, arrOff);
                this.vm.call("_array_push");
                this.vm.store(VReg.FP, arrOff, VReg.RET);
                continue;
            }

            if (el.type === "SpreadElement") {
                // 遍历源数组：for (idx=0; idx<len; idx++) push(src[idx])
                this.compileExpression(el.argument);      // RET = 源（boxed array）
                // TypedArray(裸指针,type 字节 0x40+)静态可知时先转普通数组——否则落下方
                // type==1 判否 → _array_spread_into 不识 typed → 空/崩。转后走数组快路。
                if (inferType(el.argument, this.ctx) === Type.TYPED_ARRAY) {
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_ta_to_array");         // RET = 装箱普通数组(0x7FFE)
                }
                const srcOff = this.ctx.allocLocal(`__arrsp_src_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, srcOff, VReg.RET);
                // 非可迭代守卫:spread 源须堆可迭代(高16 ∈ {0 裸指针,0x7FFC 串,0x7FFD 对象/
                // Set/Map/生成器,0x7FFE 数组})。number/null/undefined/bool/int/function 非可迭代
                // → TypeError(此前把数字位当堆指针 loadByte → SIGSEGV)。用 V2 避 x64 V0==RET
                // 别名,保 RET=源给下方字符串分支的 tag 检查。
                {
                    const iterOk = this.ctx.newLabel("arrsp_iter_ok");
                    const iterBad = this.ctx.newLabel("arrsp_iter_bad");
                    this.vm.load(VReg.V2, VReg.FP, srcOff);
                    // +0 / 未绑定 rest:high16=0 曾被当成裸堆指针 → loadByte[0] SIGSEGV
                    this.vm.cmpImm(VReg.V2, 0);
                    this.vm.jeq(iterBad);
                    this.vm.shrImm(VReg.V2, VReg.V2, 48);
                    this.vm.cmpImm(VReg.V2, 0); this.vm.jeq(iterOk);
                    this.vm.cmpImm(VReg.V2, 0x7FFC); this.vm.jeq(iterOk);
                    this.vm.cmpImm(VReg.V2, 0x7FFD); this.vm.jeq(iterOk);
                    this.vm.cmpImm(VReg.V2, 0x7FFE); this.vm.jeq(iterOk);
                    this.vm.label(iterBad);
                    this.emitThrowTypeError("Spread source is not iterable");
                    this.vm.label(iterOk);
                }
                // 本元素所有源类型分支的汇合落点（在整个 SpreadElement 处理末尾发射）
                const spElemEnd = this.ctx.newLabel("arrsp_elem_end");
                // [#33] 字符串源(tag 0x7FFC):逐字符 charAt push。原先把字符串
                // 内容当数组头读 length@8 → 垃圾长度 → _array_get 越界 SIGSEGV。
                {
                    const spStrLoop = this.ctx.newLabel("arrsp_str");
                    const spStrDone = this.ctx.newLabel("arrsp_str_done");
                    const spNotStr = this.ctx.newLabel("arrsp_notstr");
                    const sIdxOff = this.ctx.allocLocal(`__arrsp_sidx_${this.nextLabelId()}`);
                    const sLenOff = this.ctx.allocLocal(`__arrsp_slen_${this.nextLabelId()}`);
                    this.vm.shrImm(VReg.V0, VReg.RET, 48); // x64 上 V0==RET,RET 已毁
                    this.vm.cmpImm(VReg.V0, 0x7FFC);
                    this.vm.jne(spNotStr);
                    this.vm.load(VReg.A0, VReg.FP, srcOff); // 从槽重载(勿用 RET)
                    this.vm.call("_js_length");
                    this.vm.store(VReg.FP, sLenOff, VReg.RET);
                    this.vm.movImm(VReg.V0, 0);
                    this.vm.store(VReg.FP, sIdxOff, VReg.V0);
                    // 按**码点**迭代(非字节):sIdxOff = 字节偏移,每步取一个完整 UTF-8
                    // 码点子串并 push,再按 _str_cp_bytes 推进偏移。sLenOff 是字节长度上界。
                    // ASCII 恒 1 字节/码点 → 与旧逐字节行为一致(自举保真);多字节 UTF-8
                    // (中文/astral)现产正确码点而非乱码字节。
                    this.vm.label(spStrLoop);
                    this.vm.load(VReg.V0, VReg.FP, sIdxOff);
                    this.vm.load(VReg.V1, VReg.FP, sLenOff);
                    this.vm.cmp(VReg.V0, VReg.V1);
                    this.vm.jge(spStrDone);
                    this.vm.load(VReg.A0, VReg.FP, srcOff);
                    this.vm.load(VReg.A1, VReg.FP, sIdxOff);
                    this.vm.call("_str_codepoint_at"); // RET = 码点子串
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, arrOff);
                    this.vm.call("_array_push");
                    this.vm.store(VReg.FP, arrOff, VReg.RET);
                    // off += _str_cp_bytes(str, off)(cpLen 先挪 V1,避 x64 V0==RET 别名)
                    this.vm.load(VReg.A0, VReg.FP, srcOff);
                    this.vm.load(VReg.A1, VReg.FP, sIdxOff);
                    this.vm.call("_str_cp_bytes");
                    this.vm.mov(VReg.V1, VReg.RET);
                    this.vm.load(VReg.V0, VReg.FP, sIdxOff);
                    this.vm.add(VReg.V0, VReg.V0, VReg.V1);
                    this.vm.store(VReg.FP, sIdxOff, VReg.V0);
                    this.vm.jmp(spStrLoop);
                    this.vm.label(spStrDone);
                    // 跳过数组路径(用哨兵 continue 结构:直接跳到本元素尾)
                    this.vm.jmp(spElemEnd);
                    this.vm.label(spNotStr);
                }
                // [#44] 非字符串:按堆块 type 字节分派。原先无条件当数组读 length@8,
                // 生成器(TYPE_OBJECT)/Map/Set 被当数组读垃圾长度 → _array_get 越界 SIGSEGV。
                // 数组(TYPE_ARRAY=1,含 boxed 0x7FFE 与裸头指针 tag 0x0000)走原快路(内联,
                // 零语义改动;编译器自身大量 [...arr]/f(...args) 定点保真);Set/Map/生成器/
                // 自定义可迭代委托运行时 _array_spread_into(纯 S 寄存器,不受晋升器影响;
                // 复杂遍历移出用户函数避免大函数触发晋升器误判 → gen1 崩)。
                const spHelper = this.ctx.newLabel("arrsp_helper");
                this.vm.load(VReg.RET, VReg.FP, srcOff);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);   // V0 = 裸块指针
                this.vm.loadByte(VReg.V1, VReg.V0, 0);     // type 字节
                this.vm.cmpImm(VReg.V1, 1);                // TYPE_ARRAY
                this.vm.jne(spHelper);                      // 非数组 → 运行时可迭代展开

                // ---- 数组源快路(原路径,零语义改动):push 每个 src[idx] ----
                this.vm.load(VReg.RET, VReg.FP, srcOff);
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_length");            // RET = 原始整数长度
                const lenOff = this.ctx.allocLocal(`__arrsp_len_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, lenOff, VReg.RET);
                const idxOff = this.ctx.allocLocal(`__arrsp_idx_${this.nextLabelId()}`);
                this.vm.movImm(VReg.V0, 0);
                this.vm.store(VReg.FP, idxOff, VReg.V0);

                const id = this.nextLabelId();
                const loopL = `_arrsp_loop_${id}`;
                const doneL = `_arrsp_done_${id}`;
                this.vm.label(loopL);
                this.vm.load(VReg.V0, VReg.FP, idxOff);   // idx
                this.vm.load(VReg.V1, VReg.FP, lenOff);   // len
                this.vm.cmp(VReg.V0, VReg.V1);
                this.vm.jge(doneL);
                // elem = _array_get(src, idx)
                this.vm.load(VReg.A0, VReg.FP, srcOff);
                this.vm.load(VReg.A1, VReg.FP, idxOff);
                this.vm.call("_array_get");               // RET = elem
                // arr = _array_push(arr, elem)
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, arrOff);
                this.vm.call("_array_push");
                this.vm.store(VReg.FP, arrOff, VReg.RET);
                // idx++
                this.vm.load(VReg.V0, VReg.FP, idxOff);
                this.vm.addImm(VReg.V0, VReg.V0, 1);
                this.vm.store(VReg.FP, idxOff, VReg.V0);
                this.vm.jmp(loopL);
                this.vm.label(doneL);
                this.vm.jmp(spElemEnd);

                // ---- [#44] Set/Map/生成器/自定义可迭代:委托运行时 helper ----
                this.vm.label(spHelper);
                this.vm.load(VReg.A0, VReg.FP, arrOff);   // A0 = 目标数组(裸头)
                this.vm.load(VReg.A1, VReg.FP, srcOff);   // A1 = 源(可迭代)
                this.vm.call("_array_spread_into");
                this.vm.store(VReg.FP, arrOff, VReg.RET);
                this.vm.label(spElemEnd); // 各源类型分支汇合点
            } else {
                this.compileExpression(el);               // RET = value
                this.vm.mov(VReg.A1, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, arrOff);
                this.vm.call("_array_push");
                this.vm.store(VReg.FP, arrOff, VReg.RET);
            }
        }
        this.vm.load(VReg.RET, VReg.FP, arrOff);
        // 结果装箱 0x7FFE:arrOff 源自 _array_new_with_size(返裸头,tag 高16=0),
        // _array_push 保留输入 tag → 全程裸头。此前 [...arr] 作为值返裸指针 →
        // typeof=number、JSON/console.log 见 0(数组方法消费者容裸指针曾掩盖,与
        // concat/Promise.all 未装箱同族)。装箱幂等(已箱再箱无害)。
        this.vm.call("_box_arr_r"); // box->helper
    },

    // 编译对象表达式 { a: 1, b: 2 }
    compileObjectExpression(expr) {
        const props = expr.properties || [];
        const count = props.length;

        // 统计对象扩展 { ...src }：这些属性数编译期未知，需为每个扩展源
        // 预留大容量（对象无扩容语义，_object_set 溢出即野写）。
        // 自举编译器大量使用 { ...MixinA, ...MixinB, method(){} } 组装原型，
        // 每个 Mixin 可能有几十个方法，故每个扩展源预留 512 槽（8192B）。
        let spreadCount = 0;
        for (let si = 0; si < count; si++) {
            if (props[si] && props[si].type === "SpreadElement") spreadCount++;
        }
        const nonSpread = count - spreadCount;

        // Annex B.3.1: Syntax Error if two+ proto-setters
        // (PropertyName : AssignmentExpression named "__proto__").
        // Method / shorthand / computed / get/set are not proto setters.
        // compileObjectExpression is only for object literals; destructuring
        // assignment uses reinterpretAsPattern (obj-prop-__proto__dup).
        let protoSetters = 0;
        for (let psi = 0; psi < count; psi++) {
            const pp = props[psi];
            if (!pp || pp.type === "SpreadElement" || pp.computed || pp.method || pp.shorthand) continue;
            if (pp.kind === "get" || pp.kind === "set") continue;
            const pkn = this.objectPropStaticKeyName(pp.key);
            if (pkn === "__proto__") protoSetters++;
        }
        if (protoSetters > 1) {
            throw new SyntaxError("Duplicate __proto__ property");
        }

        // 统一走对象运行时封装，避免手写对象头/布局导致的不一致。
        // 对象现已支持自动扩容（capacity 满即 realloc 2×、指针稳定），故只给小初始容量，
        // 动态追加属性时自然增长。**关键**：旧代码给每个 {} 预留 16384/8192B（对象无扩容时代的
        // 遗留），自举编译整个编译器时数十万对象 × 16KB → 4GB+ 内存 → OOM(137) 跑不出 gen2。
        // 现按字段数 + 少量余量（8 槽），空对象也走 _object_new_sized 下限(容量4)。
        this.vm.movImm(VReg.A0, 24 + 16 * nonSpread + 128);
        this.vm.call("_object_new_sized");

        // 将对象指针保存到局部变量槽位，避免被 compileExpression 破坏
        const objTempName = `__obj_temp_${this.nextLabelId()}`;
        const objOffset = this.ctx.allocLocal(objTempName);
        this.vm.store(VReg.FP, objOffset, VReg.RET);

        // 访问器归组：同名 get/set 必须合并进同一个 24B 标记对象
        // {TYPE_GETTER@0, getter@8, setter@16}。键名归组用 Map（禁止裸 {}
        // 字典判真——node 原型链污染，见 [#32]）。
        let accessorGroups = null;
        for (let ai = 0; ai < count; ai++) {
            const p = props[ai];
            if (!p || p.type === "SpreadElement") continue;
            if (p.kind !== "get" && p.kind !== "set") continue;
            if (!p.key || !p.value) continue;
            // 计算键访问器 `{ get [k](){} }`(k 为标识符):键运行时求值,分组键加 " c "
            // 前缀与同名静态访问器分隔。非计算键分组键 === kn(自举字节不变)。
            let kn, computedAcc = false;
            if (p.computed) {
                // [#85] 计算键访问器:支持 Identifier / NumericLiteral / StringLiteral /
                // Symbol.* well-known(get [Symbol.unscopables])。前仅 Identifier+字面量,
                // MemberExpression 漏分组 → getter 当数据属性存、HasBinding 永不调 accessor。
                if (p.key.type === "Identifier") {
                    kn = " c " + p.key.name;
                    computedAcc = true;
                } else if (p.key.type === "NumericLiteral" || p.key.type === "Literal") {
                    kn = " c " + String(p.key.value);
                } else if (p.key.type === "StringLiteral") {
                    kn = " c " + p.key.value;
                } else if (p.key.type === "MemberExpression" &&
                    p.key.object && p.key.object.type === "Identifier" &&
                    p.key.object.name === "Symbol" &&
                    p.key.property && p.key.property.type === "Identifier") {
                    kn = " c Symbol." + p.key.property.name;
                } else {
                    // 任意计算键表达式(含 `in`/Call 等):运行时求键
                    kn = " c #" + ai;
                    computedAcc = true;
                }
            } else {
                kn = this.objectPropStaticKeyName(p.key);
                if (kn === null) continue;
            }
            if (accessorGroups === null) accessorGroups = new Map();
            let g = accessorGroups.get(kn);
            if (!g) {
                // [#85] 计算键访问器:Identifier 用 name,NumericLiteral/StringLiteral 用
                // ToString(key) → 运行时键。Symbol.* → "Symbol.xxx" 静态键。
                let groupName;
                if (computedAcc) {
                    // Identifier:保留原名;其它表达式 keyNode 供运行时求值
                    groupName = (p.key.type === "Identifier") ? p.key.name : ("#" + ai);
                } else if (p.key && (p.key.type === "NumericLiteral" || p.key.type === "Literal")) {
                    groupName = String(p.key.value);
                } else if (p.key && p.key.type === "StringLiteral") {
                    groupName = p.key.value;
                } else if (p.key && p.key.type === "MemberExpression" &&
                    p.key.property && p.key.property.type === "Identifier") {
                    groupName = "Symbol." + p.key.property.name;
                } else {
                    groupName = kn;
                }
                g = { name: groupName, getter: null, setter: null,
                      emitted: false, computed: computedAcc, keyNode: p.key,
                      symWk: !!(p.key && p.key.type === "MemberExpression" &&
                        p.key.object && p.key.object.name === "Symbol") };
                accessorGroups.set(kn, g);
            }
            if (p.kind === "get") g.getter = p.value;
            else g.setter = p.value;
        }

        // [A2] 静态形状资格:全静态数据键(无 spread/访问器/计算键/重名/__proto__)→
        // 形状描述符仅记 key_count(IC 做地址身份比较);声明序即 props 插入序(逐一
        // _object_define 追加),故 count 必等 key_count。不合格留 null(形状恒 0)。
        let literalShapeKeyCount = null;
        if (spreadCount === 0 && accessorGroups === null) {
            const seenKeys = new Set();
            let shapeN = 0, shapeEligible = true;
            for (const p of props) {
                if (!p) continue;
                if (p.computed || !p.key || !p.value) { shapeEligible = false; break; }
                if (p.kind === "get" || p.kind === "set") { shapeEligible = false; break; }
                let skn = null;
                if (p.key.type === "Identifier") skn = p.key.name;
                else if (p.key.type === "Literal" || p.key.type === "StringLiteral" ||
                         p.key.type === "NumericLiteral") skn = String(p.key.value);
                if (skn === null || skn === "__proto__" || seenKeys.has(skn)) { shapeEligible = false; break; }
                seenKeys.add(skn);
                shapeN++;
            }
            if (shapeEligible) literalShapeKeyCount = shapeN;
        }

        // 填充属性：_object_set(obj, key, value)
        for (let i = 0; i < count; i++) {
            const prop = props[i];
            if (!prop) continue;

            // 对象扩展 { ...src }：求值 src，把其自有属性拷入新对象。
            // 顺序即源码顺序——后面的属性/扩展覆盖前面的同名键。
            if (prop.type === "SpreadElement") {
                this.compileExpression(prop.argument);   // RET = 源值（装箱）
                this.vm.mov(VReg.A1, VReg.RET);          // A1 = source
                this.vm.load(VReg.V0, VReg.FP, objOffset);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                this.vm.or(VReg.A0, VReg.V0, VReg.V1);   // A0 = 装箱目标对象
                this.vm.call("_object_assign");          // _object_assign(target, source)
                continue;
            }

            if (!prop.key) continue;

            if (!prop.value) continue;

            // 访问器 { get x() {}, set x(v) {} }：在首个同名访问器处发射
            // 合并标记对象（getter/setter 闭包指针存 @8/@16，缺者存 0）
            if ((prop.kind === "get" || prop.kind === "set") && !prop.computed) {
                const accName = this.objectPropStaticKeyName(prop.key);
                const group = accName !== null && accessorGroups !== null
                    ? accessorGroups.get(accName) : null;
                if (!group || group.emitted) continue;
                group.emitted = true;
                this.emitObjectLiteralAccessor(group, objOffset);
                continue;
            }

            // 计算键访问器 { get [k](){} , set [k](v){} }(k 为标识符或任意表达式):
            // 运行时求键→ marker。须在下方通用计算键分支前拦截。
            if ((prop.kind === "get" || prop.kind === "set") && prop.computed &&
                prop.key && prop.key.type === "Identifier") {
                const group = accessorGroups !== null
                    ? accessorGroups.get(" c " + prop.key.name) : null;
                if (!group || group.emitted) continue;
                group.emitted = true;
                this.emitObjectLiteralComputedAccessor(group, objOffset, group.keyNode);
                continue;
            }

            // 任意计算键访问器 { get [expr](){} }(含 `in`/Call 等,分组键 " c #i")
            if ((prop.kind === "get" || prop.kind === "set") && prop.computed &&
                accessorGroups !== null) {
                const gExpr = accessorGroups.get(" c #" + i);
                if (gExpr && !gExpr.emitted && gExpr.computed) {
                    gExpr.emitted = true;
                    this.emitObjectLiteralComputedAccessor(gExpr, objOffset, gExpr.keyNode);
                    continue;
                }
            }

            // [#85] 计算键访问器 { get [1E+9](){} , get ["str"](){} }:键为字面量(NumericLiteral/
            // StringLiteral/Literal)→ 静态键,走 emitObjectLiteralAccessor(同非计算路径)。
            if ((prop.kind === "get" || prop.kind === "set") && prop.computed &&
                prop.key && (prop.key.type === "NumericLiteral" || prop.key.type === "Literal" ||
                prop.key.type === "StringLiteral")) {
                const accName = String(prop.key.value);
                const group = accessorGroups !== null
                    ? accessorGroups.get(" c " + accName) : null;
                if (!group || group.emitted) continue;
                group.emitted = true;
                this.emitObjectLiteralAccessor(group, objOffset);
                continue;
            }

            // get/set [Symbol.xxx]():
            // - iterator/asyncIterator → 字符串键 "Symbol.X"(与 for-of/yield*/getMemberPropertyName 协议一致)
            // - 其余(unscopables 等) → well-known Symbol 键(与 env[Symbol.unscopables]= 同键)
            if ((prop.kind === "get" || prop.kind === "set") && prop.computed &&
                prop.key && prop.key.type === "MemberExpression" &&
                prop.key.object && prop.key.object.type === "Identifier" &&
                prop.key.object.name === "Symbol" &&
                prop.key.property && prop.key.property.type === "Identifier") {
                const symProp = prop.key.property.name;
                const group = accessorGroups !== null
                    ? accessorGroups.get(" c Symbol." + symProp) : null;
                if (!group || group.emitted) continue;
                group.emitted = true;
                if (symProp === "iterator" || symProp === "asyncIterator") {
                    group.name = "Symbol." + symProp;
                    this.emitObjectLiteralAccessor(group, objOffset);
                } else {
                    this.emitObjectLiteralSymWkAccessor(group, objOffset, symProp);
                }
                continue;
            }

            // 计算属性名 { [expr]: v }：键在运行时求值（转字符串装箱）
            if (prop.computed) {
                // `[Symbol.iterator]` 计算键:静态存字符串键 "Symbol.iterator"(与成员赋值
                // o[Symbol.iterator]= 及 for-of/spread 查找一致)。此前走下方 _valueToStr(symbol)
                // → 键 "Symbol(Symbol.iterator)" 不匹配 → 自定义 [Symbol.iterator] 对象在
                // for-of/spread/解构里迭代器查不到 → 静默零迭代。
                const k = prop.key;
                const isSymWK = k && k.type === "MemberExpression" &&
                    k.object && k.object.type === "Identifier" && k.object.name === "Symbol" &&
                    k.property && k.property.type === "Identifier" &&
                    (k.property.name === "iterator" || k.property.name === "asyncIterator");
                if (isSymWK) {
                    // [Symbol.iterator] / [Symbol.asyncIterator]:静态存字符串键(读侧
                    // getMemberPropertyName 同名归一 → for-of / for-await 协议同键查得到)。
                    this.compileExpression(prop.value);
                    const vTmp2 = `__objv_si_${this.nextLabelId()}`;
                    const vOff2 = this.ctx.allocLocal(vTmp2);
                    this.vm.store(VReg.FP, vOff2, VReg.RET);
                    this.emitBoxedStringKey("Symbol." + k.property.name, VReg.A1);
                    this.vm.load(VReg.A2, VReg.FP, vOff2);
                    this.vm.load(VReg.V0, VReg.FP, objOffset);
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                    this.vm.or(VReg.A0, VReg.V0, VReg.V1);
                    this.vm.call("_object_define");
                    continue;
                }
                // [求值序] ES 规范:计算键**先**求值(含 ToPropertyKey 规范化——可触发
                // 用户 toString),**再**求值 value(此前 value 先于键,`{[k()]:v()}` 侧效序错)。
                // 键规范化:symbol 键走 _js_prop_key(与 o[sym]=v 下标读写路径一致,
                // 保证 {[sym]:v} 后 o[sym] 读得到);非 symbol 键保持 _valueToStr(ToString),
                // 对编译器自身的字符串/数值计算键字节不变。
                const kTmp = `__objk_${this.nextLabelId()}`;
                const kOff = this.ctx.allocLocal(kTmp);
                const symKeyL = this.ctx.newLabel("objlit_symkey");
                const keyDoneL = this.ctx.newLabel("objlit_keydone");
                this.compileExpression(prop.key);
                this.vm.store(VReg.FP, kOff, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, kOff);
                this.vm.call("_is_symbol");
                this.vm.cmpImm(VReg.RET, 0);
                this.vm.jne(symKeyL);
                this.vm.load(VReg.A0, VReg.FP, kOff);
                this.vm.call("_valueToStr"); // RET = 装箱字符串键
                this.vm.jmp(keyDoneL);
                this.vm.label(symKeyL);
                this.vm.load(VReg.A0, VReg.FP, kOff);
                this.vm.call("_js_prop_key"); // 与下标路径一致的 symbol 键规范化
                this.vm.label(keyDoneL);
                this.vm.store(VReg.FP, kOff, VReg.RET); // 规范化后键回存槽
                this.compileExpression(prop.value);
                const vTmp = `__objv_${this.nextLabelId()}`;
                const vOff = this.ctx.allocLocal(vTmp);
                this.vm.store(VReg.FP, vOff, VReg.RET);
                // NamedEvaluation:计算键匿名函数/方法 → SetFunctionName(propKey)
                // (Symbol 描述 → "[desc]";无描述 → "";字符串键原样)。静态键已由
                // _collectFnNameHints 写进元数据,此处只补计算键缺口。
                this._emitObjLitSetFnName(prop.value, vOff, kOff);
                this.vm.load(VReg.A1, VReg.FP, kOff);
                this.vm.load(VReg.A2, VReg.FP, vOff);
                this.vm.load(VReg.V0, VReg.FP, objOffset);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
                this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                this.vm.or(VReg.A0, VReg.V0, VReg.V1);
                this.vm.call("_object_define");
                continue;
            }

            let keyName;
            if (prop.key.type === "Identifier") {
                keyName = prop.key.name;
            } else if (prop.key.type === "Literal" || prop.key.type === "StringLiteral" ||
                       prop.key.type === "NumericLiteral") {
                keyName = String(prop.key.value);
            } else {
                continue;
            }

            // ES ObjectLiteral __proto__:非计算键 "__proto__" 设 [[Prototype]],不建自有属性。
            // `{__proto__:null}` → getPrototypeOf null(此前当普通键 define,链仍 Object.prototype)。
            // Method `{ __proto__() {} }` and shorthand `{ __proto__ }` are not proto setters.
            // x64: tag extract must not use V0 (V0≡RET) — shrImm V0,RET,48 smashed
            // the proto, then store into boxed obj+16 (objOffset is 0x7FFD) SIGSEGV.
            // GetSuperBase tests use `{__proto__: proto, m(){ return super[key]; }}`.
            if (keyName === "__proto__" && !prop.method && !prop.shorthand) {
                this.compileExpression(prop.value);
                const protoValOff = this.ctx.allocLocal(`__objlit_proto_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, protoValOff, VReg.RET);
                const protoNullL = this.ctx.newLabel("objlit_proto_null");
                const protoDoneL = this.ctx.newLabel("objlit_proto_done");
                const protoObjL = this.ctx.newLabel("objlit_proto_obj");
                this.vm.shrImm(VReg.V1, VReg.RET, 48); // V1 tag; x64 V0≡RET
                this.vm.cmpImm(VReg.V1, 0x7FFA); // null
                this.vm.jeq(protoNullL);
                this.vm.cmpImm(VReg.V1, 0x7FFD); // object
                this.vm.jeq(protoObjL);
                this.vm.cmpImm(VReg.V1, 0x7FFE); // array
                this.vm.jeq(protoObjL);
                this.vm.cmpImm(VReg.V1, 0x7FFF); // function
                this.vm.jeq(protoObjL);
                // 其它值:规范忽略(不改 [[Prototype]]);此处同样跳过
                this.vm.jmp(protoDoneL);
                this.vm.label(protoNullL);
                this.vm.load(VReg.V2, VReg.FP, objOffset);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1); // raw obj
                this.vm.movImm(VReg.V1, 0);
                this.vm.store(VReg.V2, 16, VReg.V1);
                this.vm.jmp(protoDoneL);
                this.vm.label(protoObjL);
                this.vm.load(VReg.RET, VReg.FP, protoValOff);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1); // raw proto
                this.vm.load(VReg.V2, VReg.FP, objOffset);
                this.vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1); // raw obj
                this.vm.store(VReg.V2, 16, VReg.RET);
                this.vm.label(protoDoneL);
                continue;
            }

            const keyLabel = this.asm.addString(keyName);
            this.compileExpression(prop.value);
            this.vm.mov(VReg.A2, VReg.RET);
            // Box the object pointer before calling _object_set (expects JSValue with tag 0x7FFD)
            this.vm.load(VReg.V0, VReg.FP, objOffset);  // V0 = raw object pointer
            this.vm.emitMaskLoad(VReg.V1);  // V1 = MASK
            this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);  // V0 = V0 & MASK
            this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);  // V1 = TAG (object)
            this.vm.or(VReg.A0, VReg.V0, VReg.V1);  // A0 = boxed object JSValue
            this.vm.lea(VReg.A1, keyLabel);
            // Box the property key label as a JSValue string (TAG_STRING_BASE = 0x7FFC...)
            this.vm.call("_tag_str_a1"); // key box->helper
            this.vm.call("_object_define");
        }

        // [A2] 赋静态形状:描述符地址写入 shape_ptr@48。此刻全部 _object_define
        // 已按声明序追加完毕,count == key_count(资格扫描排除计算键/访问器/spread/
        // 重名/__proto__);后续改键站点会把形状置 0,IC 键自验证作安全网。
        if (literalShapeKeyCount !== null) {
            const shapeLabel = this.ctx.newLabel("shape_lit");
            this.asm.addDataLabel(shapeLabel);
            this.asm.addDataQword(literalShapeKeyCount);
            this.vm.load(VReg.V0, VReg.FP, objOffset);
            this.vm.lea(VReg.V1, shapeLabel);
            this.vm.store(VReg.V0, 48, VReg.V1);
        }

        // 将原始指针装箱为 JSValue 对象
        // JSValue = (ptr & 0x0000ffffffffffff) | 0x7ffd000000000000
        this.vm.load(VReg.V2, VReg.FP, objOffset);  // V2 = 原始指针
        this.vm.emitMaskLoad(VReg.V1);  // V1 = MASK
        this.vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1);  // V2 = V2 & V1 = ptr & MASK
        this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);  // V1 = TAG (object)
        this.vm.or(VReg.RET, VReg.V2, VReg.V1);  // RET = (ptr & MASK) | TAG
    },

    // 对象字面量属性的静态键名（Identifier/字符串/数字字面量；取不到返回 null）
    // 注意用 "" + v 而非 String(v)：自编译运行时里 String() 的产物在 Map 中
    // 非内容哈希（同内容两次 String() → get miss），归组会裂成两组、getter 被吞。
    objectPropStaticKeyName(key) {
        if (!key) return null;
        if (key.type === "Identifier") return key.name;
        if (key.type === "Literal" || key.type === "StringLiteral" ||
            key.type === "NumericLiteral") return "" + key.value;
        return null;
    },

    // ES SetFunctionName(fn, propKey):计算键对象属性上的匿名函数/方法简写/匿名类。
    // 命名函数表达式(带 id)与具名类表达式(`class x {}`)跳过。
    // 静态键匿名类的可见名由 compileClassDeclaration 读 _fnHint;计算键(含 Symbol)
    // 只能在此运行时补。
    _emitObjLitSetFnName(valueAst, fnSlot, keySlot) {
        if (!valueAst || typeof valueAst !== "object") return;
        const t = valueAst.type;
        if (t === "FunctionExpression" || t === "ArrowFunctionExpression") {
            if (valueAst.id && valueAst.id.name) return;
            this._emitSetFunctionName(fnSlot, keySlot, false);
            return;
        }
        if (t === "ClassExpression" || t === "ClassDeclaration") {
            const rawId = (valueAst.id && valueAst.id.name) || "";
            if (rawId && rawId.indexOf("__classexpr") !== 0) return;
            if (valueAst.body && Array.isArray(valueAst.body)) {
                for (const m of valueAst.body) {
                    if (m && m.static && m.key && (m.key.name === "name" || m.key.value === "name")) {
                        return;
                    }
                }
            }
            this._emitSetFunctionName(fnSlot, keySlot, true);
        }
    },

    // SetFunctionName(fn, propKey [, prefix])。Symbol → "[desc]" / "";字符串键原样。
    // prefix "get"/"set": name = prefix + " " + name（"get " / "get [test262]"）。
    // forClass:类值是 classinfo,attr 须写对象本身(_object_set_prop_attr),
    // 不可走 _closure_prop_set_attr(那只改侧表,classinfo.name 描述符不变)。
    _emitSetFunctionName(fnSlot, keySlot, forClass, prefix) {
        const vm = this.vm;
        const symL = this.ctx.newLabel("objlit_sfn_sym");
        const emptyL = this.ctx.newLabel("objlit_sfn_empty");
        const nameReadyL = this.ctx.newLabel("objlit_sfn_ready");
        const nameSlot = this.ctx.allocLocal(`__sfn_${this.nextLabelId()}`);

        vm.load(VReg.A0, VReg.FP, keySlot);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne(symL);
        // 字符串/数值键:规范化结果已是装箱字符串 → 直接作 name
        vm.load(VReg.RET, VReg.FP, keySlot);
        vm.jmp(nameReadyL);

        vm.label(symL);
        // Symbol → description;无描述 "" ,有描述 → "[" + desc + "]"
        vm.load(VReg.A0, VReg.FP, keySlot);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1); // 裸 Symbol 块
        vm.load(VReg.V0, VReg.V0, 8); // desc 裸串指针(0=无描述)
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(emptyL);
        vm.lea(VReg.A0, this.asm.addString("["));
        vm.mov(VReg.A1, VReg.V0);
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.asm.addString("]"));
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.jmp(nameReadyL);

        vm.label(emptyL);
        vm.lea(VReg.A0, this.asm.addString(""));
        vm.call("_js_box_string");

        vm.label(nameReadyL);
        // SetFunctionName prefix: "get"/"set" → prefix + " " + name
        // 匿名 Symbol 描述为空 → "get " / "set "（尾空格是规范）。
        if (prefix === "get" || prefix === "set") {
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_getStrContent");
            vm.store(VReg.FP, nameSlot, VReg.RET);
            vm.lea(VReg.A0, this.asm.addString(prefix + " "));
            vm.load(VReg.A1, VReg.FP, nameSlot);
            vm.call("_strconcat");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_js_box_string");
        }
        vm.store(VReg.FP, nameSlot, VReg.RET);
        // define(fn, "name", nameStr);函数值走 _closure_prop_define
        vm.load(VReg.A0, VReg.FP, fnSlot);
        this.emitBoxedStringKey("name", VReg.A1);
        vm.load(VReg.A2, VReg.FP, nameSlot);
        vm.call("_object_define");
        // 规范 {writable:false,enumerable:false,configurable:true}=attr 4
        vm.load(VReg.A0, VReg.FP, fnSlot);
        this.emitBoxedStringKey("name", VReg.A1);
        vm.movImm(VReg.A2, 4);
        if (forClass) {
            vm.call("_object_set_prop_attr");
        } else {
            vm.call("_closure_prop_set_attr");
        }
    },

    // 类方法/访问器是 0x7FFF|TEXT。装箱标签后走 SetFunctionName。
    _emitSetFunctionNameForLabel(label, keySlot, prefix) {
        this.vm.lea(VReg.A2, label);
        this.vm.movImm64(VReg.V0, 0x7fff000000000000n);
        this.vm.or(VReg.A2, VReg.A2, VReg.V0);
        const fnSlot = this.ctx.allocLocal(`__sfnlbl_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, fnSlot, VReg.A2);
        this._emitSetFunctionName(fnSlot, keySlot, false, prefix);
    },

    // 发射对象字面量访问器：24B 标记对象 {TYPE_GETTER@0, getter@8, setter@16}，
    // getter/setter 槽存闭包裸堆指针（无者存 0），再 _object_set(obj, key, marker)。
    // 标记对象先入 FP 局部槽——闭包编译途中可能触发 GC，保守栈扫描保活。
    emitObjectLiteralAccessor(group, objOffset) {
        // 分配标记对象并清槽
        this.vm.movImm(VReg.A0, 24);
        this.vm.call("_alloc");
        const markerOffset = this.ctx.allocLocal(`__objacc_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, markerOffset, VReg.RET);
        this.vm.movImm(VReg.V1, TYPE_GETTER);
        this.vm.store(VReg.RET, 0, VReg.V1); // type@user+0（不碰 block 分配器头）
        this.vm.movImm(VReg.V1, 0);
        this.vm.store(VReg.RET, 8, VReg.V1);
        this.vm.store(VReg.RET, 16, VReg.V1);

        // getter/setter：编译 FunctionExpression 得装箱闭包(0x7fff|ptr)，
        // 脱壳成裸堆指针存入对应槽。装箱值留 FP 槽供 SetFunctionName。
        let getSlot = null, setSlot = null;
        if (group.getter) {
            this.compileExpression(group.getter);
            getSlot = this.ctx.allocLocal(`__objaccg_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, getSlot, VReg.RET);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, markerOffset);
            this.vm.store(VReg.V1, 8, VReg.V0);
        }
        if (group.setter) {
            this.compileExpression(group.setter);
            setSlot = this.ctx.allocLocal(`__objaccs_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, setSlot, VReg.RET);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, markerOffset);
            this.vm.store(VReg.V1, 16, VReg.V0);
        }

        // _object_set(装箱 obj, 装箱 key, 标记对象裸指针)
        this.vm.load(VReg.V0, VReg.FP, objOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        this.vm.or(VReg.A0, VReg.V0, VReg.V1);
        const keyLabel = this.asm.addString(group.name);
        this.vm.lea(VReg.A1, keyLabel);
        this.vm.call("_tag_str_a1"); // key box->helper
        const keySlot = this.ctx.allocLocal(`__objacck_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, keySlot, VReg.A1);
        this.vm.load(VReg.A2, VReg.FP, markerOffset);
        this.vm.call("_object_define");
        // SetFunctionName(closure, propKey, "get"|"set") — 静态键 "get id"
        if (getSlot) this._emitSetFunctionName(getSlot, keySlot, false, "get");
        if (setSlot) this._emitSetFunctionName(setSlot, keySlot, false, "set");
    },

    // get/set [Symbol.xxx]():TYPE_GETTER 挂 well-known Symbol 键(非 ToString 假串)。
    emitObjectLiteralSymWkAccessor(group, objOffset, symName) {
        this.vm.movImm(VReg.A0, 24);
        this.vm.call("_alloc");
        const markerOffset = this.ctx.allocLocal(`__objsacc_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, markerOffset, VReg.RET);
        this.vm.movImm(VReg.V1, TYPE_GETTER);
        this.vm.store(VReg.RET, 0, VReg.V1);
        this.vm.movImm(VReg.V1, 0);
        this.vm.store(VReg.RET, 8, VReg.V1);
        this.vm.store(VReg.RET, 16, VReg.V1);

        if (group.getter) {
            this.compileExpression(group.getter);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, markerOffset);
            this.vm.store(VReg.V1, 8, VReg.V0);
        }
        if (group.setter) {
            this.compileExpression(group.setter);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, markerOffset);
            this.vm.store(VReg.V1, 16, VReg.V0);
        }

        this.vm.lea(VReg.A0, "_symwk_" + symName);
        this.vm.lea(VReg.A1, this.asm.addString("Symbol." + symName));
        this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        this.vm.or(VReg.A1, VReg.A1, VReg.V1);
        this.vm.call("_symbol_wellknown");
        this.vm.mov(VReg.S0, VReg.RET); // Symbol 键跨 call

        this.vm.load(VReg.V0, VReg.FP, objOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        this.vm.or(VReg.A0, VReg.V0, VReg.V1);
        this.vm.mov(VReg.A1, VReg.S0);
        this.vm.load(VReg.A2, VReg.FP, markerOffset);
        this.vm.call("_object_define");
    },

    // 计算键访问器 `{ get [k](){}, set [k](v){} }`:同 emitObjectLiteralAccessor,但键在
    // 运行时求值(keyNode → _valueToStr)。getter/setter 合并进同一 marker(编译期已归组)。
    emitObjectLiteralComputedAccessor(group, objOffset, keyNode) {
        this.vm.movImm(VReg.A0, 24);
        this.vm.call("_alloc");
        const markerOffset = this.ctx.allocLocal(`__objcacc_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, markerOffset, VReg.RET);
        this.vm.movImm(VReg.V1, TYPE_GETTER);
        this.vm.store(VReg.RET, 0, VReg.V1);
        this.vm.movImm(VReg.V1, 0);
        this.vm.store(VReg.RET, 8, VReg.V1);
        this.vm.store(VReg.RET, 16, VReg.V1);

        let getSlot = null, setSlot = null;
        if (group.getter) {
            this.compileExpression(group.getter);
            getSlot = this.ctx.allocLocal(`__objcacg_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, getSlot, VReg.RET);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, markerOffset);
            this.vm.store(VReg.V1, 8, VReg.V0);
        }
        if (group.setter) {
            this.compileExpression(group.setter);
            setSlot = this.ctx.allocLocal(`__objcacs_${this.nextLabelId()}`);
            this.vm.store(VReg.FP, setSlot, VReg.RET);
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
            this.vm.load(VReg.V1, VReg.FP, markerOffset);
            this.vm.store(VReg.V1, 16, VReg.V0);
        }

        // 运行时键:求值 → symbol 走 _js_prop_key、否则 _valueToStr(与数据计算键一致)
        this.compileExpression(keyNode);
        const kOff = this.ctx.allocLocal(`__objcack_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, kOff, VReg.RET);
        const symKeyL = this.ctx.newLabel("objcacc_sym");
        const keyDoneL = this.ctx.newLabel("objcacc_keydone");
        this.vm.load(VReg.A0, VReg.FP, kOff);
        this.vm.call("_is_symbol");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(symKeyL);
        this.vm.load(VReg.A0, VReg.FP, kOff);
        this.vm.call("_valueToStr");
        this.vm.jmp(keyDoneL);
        this.vm.label(symKeyL);
        this.vm.load(VReg.A0, VReg.FP, kOff);
        this.vm.call("_js_prop_key");
        this.vm.label(keyDoneL);
        this.vm.store(VReg.FP, kOff, VReg.RET);

        // _accessor_define(装箱 obj, 运行时键, 标记对象裸指针):键相同的 get/set 是两个
        // 独立成员(`{get [k](){}, set [k](v){}}` 编译期按下标分组,同键只在运行期可知),
        // 走合并定义保住另半边;此前后发的 marker 直接覆盖 → getter 或 setter 丢一半。
        this.vm.load(VReg.V0, VReg.FP, objOffset);
        this.vm.emitMaskLoad(VReg.V1);
        this.vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        this.vm.or(VReg.A0, VReg.V0, VReg.V1);
        this.vm.load(VReg.A1, VReg.FP, kOff);
        this.vm.load(VReg.A2, VReg.FP, markerOffset);
        this.vm.call("_accessor_define");
        // SetFunctionName(closure, propKey, "get"|"set"): Symbol → "get " / "get [desc]"
        if (getSlot) this._emitSetFunctionName(getSlot, kOff, false, "get");
        if (setSlot) this._emitSetFunctionName(setSlot, kOff, false, "set");
    },
};

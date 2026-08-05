// asm.js 编译器 - Array 方法编译
// 从 builtin_methods.js 按功能拆出(2026-07-14)。方法经 this 解析,与主 mixin 同一原型。

import { VReg } from "../../vm/index.js";

export const BuiltinArrayMethodCompiler = {
    // [半支持修补] Array.prototype.flat(depth):接收者已在 RET。逐层调用 _array_flat
    // (每次展一层),直到 depth 耗尽或数组内已无嵌套数组(提前退出——支持 flat(Infinity))。
    // depth 来源:数字字面量→截断整数;标识符 Infinity→大哨兵(配合无嵌套退出);
    // 其他表达式→_to_int32(变量形式的 Infinity 会坍缩为 0,罕见,不支持)。
    compileArrayFlatDepth(depthArg) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const accOff = this.ctx.allocLocal(`__flat_acc_${id}`);
        const depthOff = this.ctx.allocLocal(`__flat_depth_${id}`);
        const idxOff = this.ctx.allocLocal(`__flat_idx_${id}`);
        const lenOff = this.ctx.allocLocal(`__flat_len_${id}`);
        // 接收者(boxed 数组)已在 RET
        vm.store(VReg.FP, accOff, VReg.RET);
        // depth 整数 → depthOff
        if (depthArg.type === "Literal" && typeof depthArg.value === "number") {
            vm.movImm(VReg.V0, Math.max(0, Math.trunc(depthArg.value)));
            vm.store(VReg.FP, depthOff, VReg.V0);
        } else if (depthArg.type === "Identifier" && depthArg.name === "Infinity") {
            vm.movImm(VReg.V0, 0x40000000); // 足够大;"无嵌套即止"负责真正退出
            vm.store(VReg.FP, depthOff, VReg.V0);
        } else {
            this.compileExpression(depthArg);
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_to_int32");
            vm.store(VReg.FP, depthOff, VReg.RET);
        }
        const outL = `_flat_out_${id}`;
        const doneL = `_flat_done_${id}`;
        const scanL = `_flat_scan_${id}`;
        const nestedL = `_flat_nested_${id}`;
        vm.label(outL);
        // depth <= 0 → 完成
        vm.load(VReg.V0, VReg.FP, depthOff);
        vm.cmpImm(VReg.V0, 0);
        vm.jle(doneL);
        // len = acc.length(@8,脱壳)
        vm.load(VReg.RET, VReg.FP, accOff);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.store(VReg.FP, lenOff, VReg.V1);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.FP, idxOff, VReg.V0);
        // 扫描:acc 中是否还有嵌套数组
        vm.label(scanL);
        vm.load(VReg.V0, VReg.FP, idxOff);
        vm.load(VReg.V1, VReg.FP, lenOff);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge(doneL); // 扫完仍无嵌套 → 完成
        vm.load(VReg.A0, VReg.FP, accOff);
        vm.load(VReg.A1, VReg.FP, idxOff);
        vm.call("_array_get"); // RET = elem(boxed)
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFE); // 数组 tag
        vm.jeq(nestedL);
        vm.load(VReg.V0, VReg.FP, idxOff);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.FP, idxOff, VReg.V0);
        vm.jmp(scanL);
        // 有嵌套:展一层,depth--
        vm.label(nestedL);
        vm.load(VReg.A0, VReg.FP, accOff);
        vm.call("_array_flat");
        vm.store(VReg.FP, accOff, VReg.RET);
        vm.load(VReg.V0, VReg.FP, depthOff);
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.FP, depthOff, VReg.V0);
        vm.jmp(outL);
        vm.label(doneL);
        vm.load(VReg.RET, VReg.FP, accOff);
    },

    // 编译数组方法
    compileArrayMethod(arrayExpr, method, args) {
        // push 方法特殊处理：需要更新数组引用（因为扩容可能重新分配）
        if (method === "push") {
            if (args.length > 0) {
                const hasSpread = args.some((a) => a && a.type === "SpreadElement");
                if (!hasSpread) {
                    // 多参数 push(a,b,c,...):逐个 _array_push;每次扩容可能返回新指针,
                    // 栈顶滚动保存当前数组指针,循环结束 RET=最终数组。(曾只编译 args[0]
                    // → arr.push(1,2,3,4) 只进 1 个元素;引擎 relocsToBytes 踩过。)
                    // 非 spread 快路径不分配 FP-local(编译器自身热用 push,避免帧膨胀踩
                    // layout-position 定点雷)。
                    this.compileExpression(arrayExpr);
                    this.vm.push(VReg.RET);                  // 栈顶 = 当前数组指针
                    for (let ai = 0; ai < args.length; ai++) {
                        this.compileExpression(args[ai]);
                        this.vm.mov(VReg.A1, VReg.RET);      // A1 = 元素
                        this.vm.pop(VReg.A0);                // A0 = 当前数组
                        this.vm.call("_array_push");         // RET = 扩容后新数组指针
                        this.vm.push(VReg.RET);              // 更新栈顶 = 新数组
                    }
                    this.vm.pop(VReg.RET);                   // RET = 最终数组指针
                } else {
                    // spread 慢路径:arr.push(...src) 逐元素展开。FP-local 槽滚动当前数组,
                    // spread 源用 _array_length + _array_get + _array_push 运行时循环
                    // (与 concat 的 spreadArrInto 同构)。
                    const curOff = this.ctx.allocLocal(`__push_cur_${this.nextLabelId()}`);
                    this.compileExpression(arrayExpr);
                    this.vm.store(VReg.FP, curOff, VReg.RET);
                    for (let ai = 0; ai < args.length; ai++) {
                        const arg = args[ai];
                        if (arg && arg.type === "SpreadElement") {
                            this.compileExpression(arg.argument);
                            const srcOff = this.ctx.allocLocal(`__push_src_${this.nextLabelId()}`);
                            const lenOff = this.ctx.allocLocal(`__push_len_${this.nextLabelId()}`);
                            const idxOff = this.ctx.allocLocal(`__push_idx_${this.nextLabelId()}`);
                            this.vm.store(VReg.FP, srcOff, VReg.RET);
                            this.vm.load(VReg.A0, VReg.FP, srcOff);
                            this.vm.call("_array_length");   // RET = 整数长度
                            this.vm.store(VReg.FP, lenOff, VReg.RET);
                            this.vm.movImm(VReg.V0, 0);
                            this.vm.store(VReg.FP, idxOff, VReg.V0);
                            const id = this.nextLabelId();
                            const loopL = `_push_sloop_${id}`;
                            const doneL = `_push_sdone_${id}`;
                            this.vm.label(loopL);
                            this.vm.load(VReg.V0, VReg.FP, idxOff);
                            this.vm.load(VReg.V1, VReg.FP, lenOff);
                            this.vm.cmp(VReg.V0, VReg.V1);
                            this.vm.jge(doneL);
                            this.vm.load(VReg.A0, VReg.FP, srcOff);
                            this.vm.load(VReg.A1, VReg.FP, idxOff);
                            this.vm.call("_array_get");      // RET = elem
                            this.vm.mov(VReg.A1, VReg.RET);
                            this.vm.load(VReg.A0, VReg.FP, curOff);
                            this.vm.call("_array_push");     // RET = 新数组
                            this.vm.store(VReg.FP, curOff, VReg.RET);
                            this.vm.load(VReg.V0, VReg.FP, idxOff);
                            this.vm.addImm(VReg.V0, VReg.V0, 1);
                            this.vm.store(VReg.FP, idxOff, VReg.V0);
                            this.vm.jmp(loopL);
                            this.vm.label(doneL);
                        } else {
                            this.compileExpression(arg);
                            this.vm.mov(VReg.A1, VReg.RET);
                            this.vm.load(VReg.A0, VReg.FP, curOff);
                            this.vm.call("_array_push");
                            this.vm.store(VReg.FP, curOff, VReg.RET);
                        }
                    }
                    this.vm.load(VReg.RET, VReg.FP, curOff);  // RET = 最终数组指针
                }

                // 如果数组是标识符，更新该变量（因为扩容可能返回新指针）
                if (arrayExpr.type === "Identifier") {
                    const offset = this.ctx.getLocal(arrayExpr.name);
                    if (offset) {
                        // 检查是否是装箱变量
                        const isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(arrayExpr.name);
                        if (isBoxed) {
                            // 装箱变量：更新 box 的内容
                            // x64: V0==RET==RAX，load(V0,FP,off) 会冲掉 _array_push 返回的
                            // 新数组指针，把 box 指针写进 box 自身 → 捕获数组 push 后变量
                            // 读回垃圾（自举 syncModuleExportBinding not a function 根因）。
                            const pushBoxReg = this.vm.backend.name === "x64" ? VReg.V2 : VReg.V0;
                            this.vm.load(pushBoxReg, VReg.FP, offset); // 加载 box 指针
                            this.vm.store(pushBoxReg, 0, VReg.RET); // 写入新值
                        } else {
                            // 普通变量：直接更新栈上的值
                            this.vm.store(VReg.FP, offset, VReg.RET);
                        }
                    }
                } else if (arrayExpr.type === "MemberExpression" && !arrayExpr.computed &&
                           arrayExpr.property && arrayExpr.property.name) {
                    // this.data.push()/obj.arr.push()：扩容返回新指针，必须写回成员，
                    // 否则超出初始容量(8)的元素全部丢失（Buffer.from(大数组) 只得 8 字节的元凶）。
                    // 私有字段 this.#items.push()：写回键须与读侧一致地经私有改写，
                    // 否则写回裸 "#items" 造成读写分家（读到旧指针 → 元素丢失）。
                    const wbKey = arrayExpr.property.type === "PrivateIdentifier"
                        ? this.manglePrivateName(arrayExpr.property.name)
                        : arrayExpr.property.name;
                    this.vm.push(VReg.RET);                       // 栈: [新数组]
                    this.compileExpression(arrayExpr.object);     // RET = obj
                    this.vm.mov(VReg.A0, VReg.RET);               // A0 = obj
                    this.emitBoxedStringKey(wbKey, VReg.A1);      // A1 = key
                    this.vm.pop(VReg.A2);                         // A2 = 新数组
                    this.vm.push(VReg.A2);                        // 再存一份供后续算长度
                    this.vm.call("_object_set");                  // obj[key] = 新数组
                    this.vm.pop(VReg.RET);                        // 恢复 RET = 新数组
                }

                // _array_push 返回了更新后的数组指针 (boxed JSValue)
                // 我们需要返回数组的新长度 (按 ECMAScript 标准)
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.emitMaskLoad(VReg.V4);
                this.vm.andMaskReg(VReg.A0, VReg.A0, VReg.V4); // unbox
                this.vm.load(VReg.RET, VReg.A0, 8); // load length

                // 将整数长度装箱为 Number
                this.boxIntAsNumber(VReg.RET);
            }
            return true;
        }

        this.compileExpression(arrayExpr);

        switch (method) {
            case "pop":
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_js_unbox");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_pop");
                break;
            case "length":
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_js_unbox");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_length");
                this.boxIntAsNumber(VReg.RET);
                break;
            case "at":
                // arr.at(index) - 支持负索引
                // 注意：index 应该是整数
                if (args.length > 0) {
                    this.vm.push(VReg.RET); // 保存数组 JSValue
                    this.compileExpressionAsInt(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // index (int)
                    this.vm.pop(VReg.A0); // arr JSValue
                    // unbox JSValue 得到裸指针
                    this.vm.call("_js_unbox");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_array_at");
                }
                break;
            case "slice":
                // arr.slice(start, end?)
                // 注意：start 和 end 应该是整数索引
                this.vm.push(VReg.RET);
                if (args.length >= 1) {
                    this.compileExpressionAsInt(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // start (int)
                } else {
                    this.vm.movImm(VReg.A1, 0);
                }
                if (args.length >= 2) {
                    this.vm.push(VReg.A1);
                    this.compileExpressionAsInt(args[1]);
                    this.vm.mov(VReg.A2, VReg.RET); // end (int)
                    this.vm.pop(VReg.A1);
                } else {
                    this.vm.movImm(VReg.A2, 2147483647); // -1 表示到末尾
                }
                this.vm.pop(VReg.A0);
                // unbox JSValue 得到裸指针
                this.vm.call("_js_unbox");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_slice");
                // 装箱返回值为 JSValue 数组
                // JSValue = (ptr & 0x0000ffffffffffff) | 0x7ffe000000000000
                this.vm.call("_box_arr_r"); // box->helper
                break;
            case "indexOf":
                // arr.indexOf(value, fromIndex?)
                if (args.length > 0) {
                    this.vm.push(VReg.RET); // 数组
                    this.compileExpression(args[0]);
                    if (args.length > 1) {
                        // fromIndex:先存 value,编译第二参转裸 int 入 A2
                        this.vm.push(VReg.RET);
                        this.compileExpression(args[1]);
                        if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_int32");
                        this.vm.mov(VReg.A2, VReg.RET);
                        this.vm.pop(VReg.A1); // value
                    } else {
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.movImm(VReg.A2, 0);
                    }
                    this.vm.pop(VReg.A0);
                    // unbox JSValue 得到裸指针(_js_unbox 保 A1,不碰 A2)
                    this.vm.call("_js_unbox");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_array_indexOf");
                    // 装箱返回值为 Number 对象
                    this.boxIntAsNumber(VReg.RET);
                }
                break;
            case "includes":
                // arr.includes(value, fromIndex?) -> 返回 _js_true 或 _js_false
                if (args.length > 0) {
                    this.vm.push(VReg.RET);
                    this.compileExpression(args[0]);
                    if (args.length > 1) {
                        // fromIndex:先存 value,编译第二参转裸 int 入 A2(与 indexOf 同)
                        this.vm.push(VReg.RET);
                        this.compileExpression(args[1]);
                        if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_int32");
                        this.vm.mov(VReg.A2, VReg.RET);
                        this.vm.pop(VReg.A1); // value
                    } else {
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.movImm(VReg.A2, 0);
                    }
                    this.vm.pop(VReg.A0);
                    // unbox JSValue 得到裸指针(_js_unbox 保 A1,不碰 A2)
                    this.vm.call("_js_unbox");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_array_includes");
                    // 转换为布尔单例
                    const trueLabel = `_includes_true_${this.nextLabelId()}`;
                    const doneLabel = `_includes_done_${this.nextLabelId()}`;
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jne(trueLabel);
                    this.vm.lea(VReg.V0, "_js_false");
                    this.vm.load(VReg.RET, VReg.V0, 0);
                    this.vm.jmp(doneLabel);
                    this.vm.label(trueLabel);
                    this.vm.lea(VReg.V0, "_js_true");
                    this.vm.load(VReg.RET, VReg.V0, 0);
                    this.vm.label(doneLabel);
                }
                break;
            case "forEach":
                // arr.forEach(callback) - 编译时展开循环
                if (args.length > 0) {
                    this.compileArrayForEach(arrayExpr, args[0], args[1]);
                }
                break;
            case "map":
                // arr.map(callback) -> new array
                if (args.length > 0) {
                    this.compileArrayMap(arrayExpr, args[0], args[1]);
                }
                break;
            case "filter":
                // arr.filter(callback) -> new array
                if (args.length > 0) {
                    this.compileArrayFilter(arrayExpr, args[0], args[1]);
                }
                break;
            case "flatMap":
                // arr.flatMap(callback) -> map 后展平一层
                if (args.length > 0) {
                    this.compileArrayFlatMap(arrayExpr, args[0]);
                }
                break;
            case "some":
                // arr.some(callback) -> boolean
                // 此前本表（活跃的 compileArrayMethod）漏了 some/every → default
                // 返回 false，但数组已 push → some/every 变成返回数组本身（对象）。
                // fixupAll 用 prefixes.some(...) 判字符串方法标签 → 恒真 →
                // 所有字符串标签当代码地址解析 → 自举产物打印代码乱码。
                if (args.length > 0) {
                    this.compileArraySome(arrayExpr, args[0], args[1]);
                }
                break;
            case "every":
                // arr.every(callback) -> boolean
                if (args.length > 0) {
                    this.compileArrayEvery(arrayExpr, args[0], args[1]);
                }
                break;
            case "findLast":
                // [#35] arr.findLast(cb) —— find 的反向遍历版
                if (args.length > 0) {
                    this.compileArrayFindLast(arrayExpr, args[0], false, args[1]);
                }
                break;
            case "findLastIndex":
                if (args.length > 0) {
                    this.compileArrayFindLast(arrayExpr, args[0], true, args[1]);
                }
                break;
            case "toReversed": {
                // [#35] 非破坏反转:slice 全拷贝后原地 reverse 拷贝(接收者已在 RET)
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_js_unbox");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, 0);
                this.vm.movImm(VReg.A2, 2147483647);
                this.vm.call("_array_slice");
                this.vm.call("_box_arr_r"); // box->helper
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_reverse");
                break;
            }
            case "toSorted": {
                // [#35] 非破坏排序:slice 拷贝存临时槽,借"伪 Identifier"复用
                // compileArraySort(其签名要求 AST 节点会重求值,临时名解析到该槽)
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_js_unbox");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, 0);
                this.vm.movImm(VReg.A2, 2147483647);
                this.vm.call("_array_slice");
                this.vm.call("_box_arr_r"); // box->helper
                const tsName = `__tosorted_${this.nextLabelId()}`;
                const tsOff = this.ctx.allocLocal(tsName);
                this.vm.store(VReg.FP, tsOff, VReg.RET);
                const tsIdent = { type: "Identifier", name: tsName };
                if (args.length > 0) {
                    this.compileArraySort(tsIdent, args[0]);
                } else {
                    this.compileArraySortDefault(tsIdent);
                }
                break;
            }
            case "with": {
                // [#73b] arr.with(idx, val) 非破坏:全拷贝 → 归一负 idx → copy[idx]=val
                // → 返回副本。接收者已在 RET(line 428)。委托 _array_with 运行时(内部
                // slice 全拷贝 + _array_set)。越界不抛 RangeError(记偏差)。
                this.vm.push(VReg.RET); // 原数组 boxed
                if (args.length >= 1) {
                    this.compileExpressionAsInt(args[0]);
                } else {
                    this.vm.movImm(VReg.RET, 0);
                }
                this.vm.push(VReg.RET); // idx(裸 int)
                if (args.length >= 2) {
                    this.compileExpression(args[1]);
                } else {
                    this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
                }
                this.vm.mov(VReg.A2, VReg.RET); // val(先落 A2,pop 会冲 RET/A0)
                this.vm.pop(VReg.A1);           // idx
                this.vm.pop(VReg.A0);           // arr boxed
                this.vm.call("_array_with");
                break;
            }
            case "find":
                // arr.find(callback) -> element or undefined
                // 同 some/every：impl 在未 mix 的 ArrayCallbackCompiler，活跃表漏了 →
                // find 返回数组本身(真值)。自举 resolveImports 的
                // `if(!moduleOrder.find(...)) push(ast)` 恒不 push → 主模块从不编译 →
                // 产物 _main 空、无任何输出。
                if (args.length > 0) {
                    this.compileArrayFind(arrayExpr, args[0], args[1]);
                }
                break;
            case "findIndex":
                // arr.findIndex(callback) -> index or -1
                if (args.length > 0) {
                    this.compileArrayFindIndex(arrayExpr, args[0], args[1]);
                }
                break;
            case "reduce":
                // arr.reduce(callback, initialValue?)
                if (args.length > 0) {
                    this.compileArrayReduce(arrayExpr, args[0], args[1]);
                }
                break;
            case "reduceRight":
                // arr.reduceRight(callback, initialValue?) —— 从右往左
                if (args.length > 0) {
                    this.compileArrayReduceRight(arrayExpr, args[0], args[1]);
                }
                break;
            case "join":
                // 接收者已在行首(line 148)求值到 RET；勿再 compileExpression(arrayExpr)，
                // 否则 arr.reverse().join() 会二次求值把原地反转再跑一遍 → 得原序。
                this.vm.push(VReg.RET);
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.lea(VReg.A1, "_str_comma_only");
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_array_join");
                break;
            case "reverse":
                // 接收者已在 RET(line 148);二次求值会让 X.reverse() 作接收者时反转两遍。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_reverse");
                break;
            case "flat":
                // arr.flat() - 展开一层。此前无 case 落 default 返回接收者本身 → join
                // 出乱码。接收者已在 RET。
                if (args.length === 0) {
                    // 无参深度 1:保持原 codegen 逐字节不变(自举安全——编译器源仅用无参 flat)。
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_array_flat");
                } else {
                    // [半支持修补] flat(depth):此前忽略深度参数恒展一层。
                    // 循环展平,每层一次 _array_flat,直到深度耗尽或已无嵌套数组。
                    this.compileArrayFlatDepth(args[0]);
                }
                break;
            case "lastIndexOf":
                // 接收者已在 RET(line 148),勿二次求值(同 join 理由)。
                // A0=arr, A1=value, A2=fromIndex(从此下标向前搜;缺省用 INT_MAX 哨兵,
                // 运行时钳到 len-1)。此前不传 fromIndex → 恒从末尾搜,忽略第 2 参。
                this.vm.push(VReg.RET);
                if (args.length >= 2) {
                    // fromIndex 存栈,先算 value 再算 fromIndex(保持求值序 value→from)
                    this.compileExpression(args[0]); this.vm.push(VReg.RET);
                    this.compileExpressionAsInt(args[1]); this.vm.mov(VReg.A2, VReg.RET);
                    this.vm.pop(VReg.A1);
                } else if (args.length === 1) {
                    this.compileExpression(args[0]); this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.movImm(VReg.A2, 2147483647);
                } else {
                    this.vm.movImm(VReg.A1, 0);
                    this.vm.movImm(VReg.A2, 2147483647);
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_array_lastIndexOf");
                // 裸整数结果装箱为 Number(否则打印成乱码浮点/-NaN)
                this.boxIntAsNumber(VReg.RET);
                break;
            case "sort":
                // arr.sort(comparator) - 原地排序，调用用户比较器。
                // 无比较器：按 ECMAScript 默认序（元素 ToString 后字典序）。
                if (args.length > 0) {
                    this.compileArraySort(arrayExpr, args[0]);
                } else {
                    this.compileArraySortDefault(arrayExpr);
                }
                break;
            case "concat": {
                // arr.concat(a, b, ...) -> 全新数组（不改原数组）。此前 compileArrayMethod
                // 缺 concat case → 落 default 返回接收者本身、实参被丢弃：
                // captured.concat(["__this"]) 恒为无操作 → 闭包从不捕获 __this（gen1 自举
                // 产物里方法内箭头/闭包读不到 this 的根因）。
                // 建空数组，先并入接收者元素、再依次并入每个实参（数组展开元素、否则单元素
                // 追加）。用 _array_length + _array_get + _array_push 手写循环，与已验证的
                // compileArrayExpressionWithSpread 完全同构（不走 _array_concat）。
                const accOff = this.ctx.allocLocal(`__concat_acc_${this.nextLabelId()}`);
                const recvOff = this.ctx.allocLocal(`__concat_recv_${this.nextLabelId()}`);
                this.vm.store(VReg.FP, recvOff, VReg.RET); // 接收者（已在 RET）
                this.vm.movImm(VReg.A0, 0);
                this.vm.call("_array_new_with_size");
                this.vm.store(VReg.FP, accOff, VReg.RET);

                // 展开一个数组源（已存于 srcOff）到累加器
                const spreadArrInto = (srcOff) => {
                    const lenOff = this.ctx.allocLocal(`__concat_len_${this.nextLabelId()}`);
                    const idxOff = this.ctx.allocLocal(`__concat_idx_${this.nextLabelId()}`);
                    this.vm.load(VReg.A0, VReg.FP, srcOff);
                    this.vm.call("_array_length");         // RET = 整数长度
                    this.vm.store(VReg.FP, lenOff, VReg.RET);
                    this.vm.movImm(VReg.V0, 0);
                    this.vm.store(VReg.FP, idxOff, VReg.V0);
                    const id = this.nextLabelId();
                    const loopL = `_concat_loop_${id}`;
                    const doneL = `_concat_ldone_${id}`;
                    this.vm.label(loopL);
                    this.vm.load(VReg.V0, VReg.FP, idxOff);
                    this.vm.load(VReg.V1, VReg.FP, lenOff);
                    this.vm.cmp(VReg.V0, VReg.V1);
                    this.vm.jge(doneL);
                    this.vm.load(VReg.A0, VReg.FP, srcOff);
                    this.vm.load(VReg.A1, VReg.FP, idxOff);
                    this.vm.call("_array_get");            // RET = elem
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, accOff);
                    this.vm.call("_array_push");
                    this.vm.store(VReg.FP, accOff, VReg.RET);
                    this.vm.load(VReg.V0, VReg.FP, idxOff);
                    this.vm.addImm(VReg.V0, VReg.V0, 1);
                    this.vm.store(VReg.FP, idxOff, VReg.V0);
                    this.vm.jmp(loopL);
                    this.vm.label(doneL);
                };

                // 接收者一定是数组
                spreadArrInto(recvOff);

                // 单个实参并入累加器(数组→展开元素,否则→单元素追加)。argOff = 存实参的 FP 槽。
                const concatOneArg = (argOff) => {
                    const pushLbl = this.ctx.newLabel("concat_push");
                    const doneLbl = this.ctx.newLabel("concat_argdone");
                    this.vm.load(VReg.V0, VReg.FP, argOff);
                    this.vm.shrImm(VReg.V0, VReg.V0, 48);
                    this.vm.cmpImm(VReg.V0, 0x7ffe); // 实参是数组？
                    this.vm.jne(pushLbl);
                    spreadArrInto(argOff);           // 数组：展开元素
                    this.vm.jmp(doneLbl);
                    this.vm.label(pushLbl);
                    this.vm.load(VReg.A1, VReg.FP, argOff); // 非数组：单元素追加
                    this.vm.load(VReg.A0, VReg.FP, accOff);
                    this.vm.call("_array_push");
                    this.vm.store(VReg.FP, accOff, VReg.RET);
                    this.vm.label(doneLbl);
                };

                if (args.some((a) => a && a.type === "SpreadElement")) {
                    // 含 spread 实参(`[].concat(...arrays)`):把全部实参(spread 展开)建成数组,
                    // 运行时逐元素 concat。此前对 SpreadElement 调 compileExpression → 坏码整程序崩。
                    this.compileArrayExpressionWithSpread(args); // RET = 实参数组(boxed)
                    const caOff = this.ctx.allocLocal(`__concat_args_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, caOff, VReg.RET);
                    const caLenOff = this.ctx.allocLocal(`__concat_arglen_${this.nextLabelId()}`);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_array_length");
                    this.vm.store(VReg.FP, caLenOff, VReg.RET);
                    const caIdxOff = this.ctx.allocLocal(`__concat_argidx_${this.nextLabelId()}`);
                    this.vm.movImm(VReg.V0, 0);
                    this.vm.store(VReg.FP, caIdxOff, VReg.V0);
                    const cid = this.nextLabelId();
                    const oLoop = `_concat_oloop_${cid}`;
                    const oDone = `_concat_odone_${cid}`;
                    const elOff = this.ctx.allocLocal(`__concat_el_${cid}`);
                    this.vm.label(oLoop);
                    this.vm.load(VReg.V0, VReg.FP, caIdxOff);
                    this.vm.load(VReg.V1, VReg.FP, caLenOff);
                    this.vm.cmp(VReg.V0, VReg.V1);
                    this.vm.jge(oDone);
                    this.vm.load(VReg.A0, VReg.FP, caOff);
                    this.vm.load(VReg.A1, VReg.FP, caIdxOff);
                    this.vm.call("_array_get");
                    this.vm.store(VReg.FP, elOff, VReg.RET);
                    concatOneArg(elOff);
                    this.vm.load(VReg.V0, VReg.FP, caIdxOff);
                    this.vm.addImm(VReg.V0, VReg.V0, 1);
                    this.vm.store(VReg.FP, caIdxOff, VReg.V0);
                    this.vm.jmp(oLoop);
                    this.vm.label(oDone);
                } else {
                    // 每个实参
                    for (let ci = 0; ci < args.length; ci++) {
                        this.compileExpression(args[ci]);
                        const argOff = this.ctx.allocLocal(`__concat_arg_${this.nextLabelId()}`);
                        this.vm.store(VReg.FP, argOff, VReg.RET);
                        concatOneArg(argOff);
                    }
                }
                this.vm.load(VReg.RET, VReg.FP, accOff);
                // 装箱为 0x7FFE 数组:acc(_array_new_with_size/_array_push 产)可能是裸指针,
                // 未装箱则 typeof→"number"、JSON.stringify/console.log 误判为对象。数组结构
                // (length/下标/join)本就工作(那些路径容裸指针),但标签敏感消费者需正确 tag。
                this.vm.call("_box_arr_r"); // box->helper
                break;
            }
            case "fill":
                // [半支持修补] 见 compileArrayFill(抽成方法以免膨胀本大 switch,避免过分支阈值)。
                this.compileArrayFill(args);
                break;
            case "copyWithin":
                // [半支持修补] 见 compileArrayCopyWithin(同上,抽出保持 switch 紧凑)。
                this.compileArrayCopyWithin(args);
                break;
            case "shift":
                // arr.shift():移除并返回首元素(原地)。接收者已在 RET(switch 入口求值)。
                // 委托 live `_array_shift`(index.js,length@8/data_ptr@24);此前活跃表漏此
                // case → default no-op 返回接收者数组、数组不变。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_array_shift");
                break;
            case "unshift":
                // arr.unshift(a,b,c):前插全部参数,数组变 [a,b,c,...原],返回新长度(原地,
                // _array_ensure_cap 头块稳定故保存的数组指针跨多次前插仍有效)。
                // 倒序逐个 _array_unshift(c→b→a)即得正确顺序;末次(a)的返回值=最终长度。
                if (args.length > 0) {
                    const uid = this.nextLabelId();
                    const uArrOff = this.ctx.allocLocal(`__unshift_arr_${uid}`);
                    this.vm.store(VReg.FP, uArrOff, VReg.RET); // 保存接收者(装箱数组)
                    if (args.some((a) => a && a.type === "SpreadElement")) {
                        // spread 慢路径:arr.unshift(x, ...src, y)。逐参 compileExpression 会对
                        // SpreadElement 报 "Unhandled expression type" 并产坏码,故先把全部实参
                        // 编成一个展开后的 items 数组(ArrayExpression 处理 spread,gen2 安全),
                        // 再对 items **倒序**逐元素 _array_unshift 得正确前插顺序。返回值=最终长度。
                        const itemsOff = this.ctx.allocLocal(`__unshift_items_${uid}`);
                        const idxOff = this.ctx.allocLocal(`__unshift_idx_${uid}`);
                        this.compileExpression({ type: "ArrayExpression", elements: args });
                        this.vm.store(VReg.FP, itemsOff, VReg.RET);
                        this.vm.load(VReg.A0, VReg.FP, itemsOff);
                        this.vm.call("_array_length");
                        this.vm.subImm(VReg.V0, VReg.RET, 1); // idx = len-1
                        this.vm.store(VReg.FP, idxOff, VReg.V0);
                        const loopL = `_unshift_sloop_${uid}`;
                        const doneL = `_unshift_sdone_${uid}`;
                        this.vm.label(loopL);
                        this.vm.load(VReg.V0, VReg.FP, idxOff);
                        this.vm.cmpImm(VReg.V0, 0);
                        this.vm.jlt(doneL);
                        this.vm.load(VReg.A0, VReg.FP, itemsOff);
                        this.vm.load(VReg.A1, VReg.FP, idxOff);
                        this.vm.call("_array_get"); // RET = items[idx]
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.load(VReg.A0, VReg.FP, uArrOff);
                        this.vm.call("_array_unshift");
                        this.vm.load(VReg.V0, VReg.FP, idxOff);
                        this.vm.subImm(VReg.V0, VReg.V0, 1);
                        this.vm.store(VReg.FP, idxOff, VReg.V0);
                        this.vm.jmp(loopL);
                        this.vm.label(doneL);
                        // 返回最终长度(empty spread 亦正确)。_array_length 返裸 int,
                        // 装箱成 canonical number(否则打印/算术拿到裸位=垃圾)。
                        this.vm.load(VReg.A0, VReg.FP, uArrOff);
                        this.vm.call("_array_length");
                        this.intToFloat64Bits(VReg.RET);
                    } else {
                        for (let ui = args.length - 1; ui >= 0; ui--) {
                            this.compileExpression(args[ui]);
                            this.vm.mov(VReg.A1, VReg.RET);
                            this.vm.load(VReg.A0, VReg.FP, uArrOff);
                            this.vm.call("_array_unshift"); // RET = 新长度
                        }
                    }
                }
                break;
            case "splice": {
                // arr.splice(start, delCount?, ...items) -> removed 数组(原地)。接收者已在 RET。
                // start/delCount 编成裸 int(delCount 省略 → 大 sentinel,运行时钳到 len-start);
                // ...items 编成 ArrayExpression 数组(真 arg 节点作 elements,gen2 安全)。
                const id = this.nextLabelId();
                const spArrOff = this.ctx.allocLocal(`__splice_arr_${id}`);
                this.vm.store(VReg.FP, spArrOff, VReg.RET);
                const spStartOff = this.ctx.allocLocal(`__splice_start_${id}`);
                if (args.length > 0) { this.compileExpressionAsInt(args[0]); }
                else { this.vm.movImm(VReg.RET, 0); }
                this.vm.store(VReg.FP, spStartOff, VReg.RET);
                const spDelOff = this.ctx.allocLocal(`__splice_del_${id}`);
                if (args.length > 1) { this.compileExpressionAsInt(args[1]); }
                else { this.vm.movImm(VReg.RET, 0x7fffffff); } // 省略 delCount → 删到尾
                this.vm.store(VReg.FP, spDelOff, VReg.RET);
                // items 数组
                this.compileExpression({ type: "ArrayExpression", elements: args.slice(2) });
                this.vm.mov(VReg.A3, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, spArrOff);
                this.vm.load(VReg.A1, VReg.FP, spStartOff);
                this.vm.load(VReg.A2, VReg.FP, spDelOff);
                this.vm.call("_array_splice");
                break;
            }
            case "toSpliced": {
                // [ES2023] arr.toSpliced(start, delCount?, ...items) -> 新数组(非破坏)。
                // 同 splice 参数处理,call `_array_toSpliced`(内部全拷贝→splice 副本→返副本)。
                const id = this.nextLabelId();
                const tsArrOff = this.ctx.allocLocal(`__tospliced_arr_${id}`);
                this.vm.store(VReg.FP, tsArrOff, VReg.RET);
                const tsStartOff = this.ctx.allocLocal(`__tospliced_start_${id}`);
                if (args.length > 0) { this.compileExpressionAsInt(args[0]); }
                else { this.vm.movImm(VReg.RET, 0); }
                this.vm.store(VReg.FP, tsStartOff, VReg.RET);
                const tsDelOff = this.ctx.allocLocal(`__tospliced_del_${id}`);
                if (args.length > 1) { this.compileExpressionAsInt(args[1]); }
                else { this.vm.movImm(VReg.RET, 0x7fffffff); }
                this.vm.store(VReg.FP, tsDelOff, VReg.RET);
                this.compileExpression({ type: "ArrayExpression", elements: args.slice(2) });
                this.vm.mov(VReg.A3, VReg.RET);
                this.vm.load(VReg.A0, VReg.FP, tsArrOff);
                this.vm.load(VReg.A1, VReg.FP, tsStartOff);
                this.vm.load(VReg.A2, VReg.FP, tsDelOff);
                this.vm.call("_array_toSpliced");
                break;
            }
            case "values":
                // arr.values() -> 一等数组迭代器(带 next()/Symbol.iterator,可 for-of/展开/
                // Array.from/手动 .next())。此前落 default 返回接收者数组——for-of 出值恰好正确
                // 但 `.next()`/`arr.values()` 作为迭代器对象缺失。kind 0 = values。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, 0);
                this.vm.call("_array_iterator_new");
                break;
            case "keys":
                // arr.keys() -> 一等数组迭代器(kind 1 = 索引)。此前 _array_keys 返即时数组
                // [0..len-1](可迭代但非真迭代器,无 .next())。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, 1);
                this.vm.call("_array_iterator_new");
                break;
            case "entries":
                // arr.entries() -> 一等数组迭代器(kind 2 = [i,v] 对)。此前 _array_entries 返即时数组。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, 2);
                this.vm.call("_array_iterator_new");
                break;
            default:
                return false;
        }
        return true;
    },

    // [半支持修补] arr.fill(value, start?, end?):此前调用不存在的 _array_fill(活跃运行时
    // 无该 label)→ 静默 no-op。编译期循环 _array_set,索引按 ES 语义归一(负数 +len、钳到
    // [0,len])。原地填充,返回接收者(调用点已把接收者求值到 RET)。
    compileArrayFill(args) {
        if (args.length === 0) return;
        const id = this.nextLabelId();
        const arrOff = this.ctx.allocLocal(`__fill_arr_${id}`);
        const valOff = this.ctx.allocLocal(`__fill_val_${id}`);
        const idxOff = this.ctx.allocLocal(`__fill_idx_${id}`);
        const endOff = this.ctx.allocLocal(`__fill_end_${id}`);
        const lenOff = this.ctx.allocLocal(`__fill_len_${id}`);
        this.vm.store(VReg.FP, arrOff, VReg.RET);
        this.compileExpression(args[0]); // value(boxed)
        this.vm.store(VReg.FP, valOff, VReg.RET);
        this.vm.load(VReg.A0, VReg.FP, arrOff);
        this.vm.call("_array_length");
        this.vm.store(VReg.FP, lenOff, VReg.RET);
        if (args.length >= 2) {
            this.compileExpressionAsInt(args[1]);
            this.emitRelativeIndex(lenOff, idxOff);
        } else {
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, idxOff, VReg.V0);
        }
        if (args.length >= 3) {
            this.compileExpressionAsInt(args[2]);
            this.emitRelativeIndex(lenOff, endOff);
        } else {
            this.vm.load(VReg.V0, VReg.FP, lenOff);
            this.vm.store(VReg.FP, endOff, VReg.V0);
        }
        const loopL = `_fill_loop_${id}`;
        const doneL = `_fill_done_${id}`;
        this.vm.label(loopL);
        this.vm.load(VReg.V0, VReg.FP, idxOff);
        this.vm.load(VReg.V1, VReg.FP, endOff);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(doneL);
        this.vm.load(VReg.A0, VReg.FP, arrOff);
        this.vm.load(VReg.A1, VReg.FP, idxOff);
        this.vm.load(VReg.A2, VReg.FP, valOff);
        this.vm.call("_array_set");
        this.vm.load(VReg.V0, VReg.FP, idxOff);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOff, VReg.V0);
        this.vm.jmp(loopL);
        this.vm.label(doneL);
        this.vm.load(VReg.RET, VReg.FP, arrOff); // 返回接收者
    },

    // [半支持修补] arr.copyWithin(target, start?, end?):此前无 case → 落 default 返 false → 崩。
    // 原地把 [start,end) 复制到 target(索引按 ES 归一)。count = min(end-start, len-target);
    // 重叠时按方向复制避免自覆盖。返回接收者(调用点已把接收者求值到 RET)。
    compileArrayCopyWithin(args) {
        const id = this.nextLabelId();
        const arrOff = this.ctx.allocLocal(`__cw_arr_${id}`);
        const lenOff = this.ctx.allocLocal(`__cw_len_${id}`);
        const tgtOff = this.ctx.allocLocal(`__cw_tgt_${id}`);
        const fromOff = this.ctx.allocLocal(`__cw_from_${id}`);
        const endOff = this.ctx.allocLocal(`__cw_end_${id}`);
        const cntOff = this.ctx.allocLocal(`__cw_cnt_${id}`);
        const toOff = this.ctx.allocLocal(`__cw_to_${id}`);
        const stepOff = this.ctx.allocLocal(`__cw_step_${id}`);
        const fcOff = this.ctx.allocLocal(`__cw_fc_${id}`);
        const valOff = this.ctx.allocLocal(`__cw_val_${id}`);
        this.vm.store(VReg.FP, arrOff, VReg.RET);
        this.vm.load(VReg.A0, VReg.FP, arrOff);
        this.vm.call("_array_length");
        this.vm.store(VReg.FP, lenOff, VReg.RET);
        // target
        if (args.length >= 1) {
            this.compileExpressionAsInt(args[0]);
            this.emitRelativeIndex(lenOff, tgtOff);
        } else {
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, tgtOff, VReg.V0);
        }
        // start
        if (args.length >= 2) {
            this.compileExpressionAsInt(args[1]);
            this.emitRelativeIndex(lenOff, fromOff);
        } else {
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, fromOff, VReg.V0);
        }
        // end
        if (args.length >= 3) {
            this.compileExpressionAsInt(args[2]);
            this.emitRelativeIndex(lenOff, endOff);
        } else {
            this.vm.load(VReg.V0, VReg.FP, lenOff);
            this.vm.store(VReg.FP, endOff, VReg.V0);
        }
        // count = min(end - from, len - target)
        this.vm.load(VReg.V0, VReg.FP, endOff);
        this.vm.load(VReg.V1, VReg.FP, fromOff);
        this.vm.sub(VReg.V0, VReg.V0, VReg.V1); // end - from
        this.vm.store(VReg.FP, cntOff, VReg.V0);
        this.vm.load(VReg.V0, VReg.FP, lenOff);
        this.vm.load(VReg.V1, VReg.FP, tgtOff);
        this.vm.sub(VReg.V0, VReg.V0, VReg.V1); // len - target
        this.vm.load(VReg.V1, VReg.FP, cntOff);
        const useV0L = `_cw_usev0_${id}`;
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jle(useV0L);   // V0 <= cnt → count = V0
        this.vm.load(VReg.V0, VReg.FP, cntOff);
        this.vm.label(useV0L);
        this.vm.store(VReg.FP, cntOff, VReg.V0);
        const doneL = `_cw_done_${id}`;
        // count <= 0 → 完成
        this.vm.load(VReg.V0, VReg.FP, cntOff);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jle(doneL);
        // fc = from + count
        this.vm.load(VReg.V0, VReg.FP, fromOff);
        this.vm.load(VReg.V1, VReg.FP, cntOff);
        this.vm.add(VReg.V0, VReg.V0, VReg.V1);
        this.vm.store(VReg.FP, fcOff, VReg.V0);
        // 方向:from < target && target < fc → 后向,否则前向
        const fwdL = `_cw_fwd_${id}`;
        const copyL = `_cw_copy_${id}`;
        this.vm.load(VReg.V0, VReg.FP, fromOff);
        this.vm.load(VReg.V1, VReg.FP, tgtOff);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(fwdL); // from >= target → 前向
        this.vm.load(VReg.V0, VReg.FP, tgtOff);
        this.vm.load(VReg.V1, VReg.FP, fcOff);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(fwdL); // target >= fc → 前向
        // 后向:to = target+count-1; from = fc-1; step = -1
        this.vm.load(VReg.V0, VReg.FP, tgtOff);
        this.vm.load(VReg.V1, VReg.FP, cntOff);
        this.vm.add(VReg.V0, VReg.V0, VReg.V1);
        this.vm.addImm(VReg.V0, VReg.V0, -1);
        this.vm.store(VReg.FP, toOff, VReg.V0);
        this.vm.load(VReg.V0, VReg.FP, fcOff);
        this.vm.addImm(VReg.V0, VReg.V0, -1);
        this.vm.store(VReg.FP, fromOff, VReg.V0);
        this.vm.movImm(VReg.V0, -1);
        this.vm.store(VReg.FP, stepOff, VReg.V0);
        this.vm.jmp(copyL);
        this.vm.label(fwdL);
        // 前向:to = target; step = +1 (from 不变)
        this.vm.load(VReg.V0, VReg.FP, tgtOff);
        this.vm.store(VReg.FP, toOff, VReg.V0);
        this.vm.movImm(VReg.V0, 1);
        this.vm.store(VReg.FP, stepOff, VReg.V0);
        this.vm.label(copyL);
        const loopL = `_cw_loop_${id}`;
        this.vm.label(loopL);
        this.vm.load(VReg.V0, VReg.FP, cntOff);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jle(doneL);
        // val = arr[from]
        this.vm.load(VReg.A0, VReg.FP, arrOff);
        this.vm.load(VReg.A1, VReg.FP, fromOff);
        this.vm.call("_array_get");
        this.vm.store(VReg.FP, valOff, VReg.RET);
        // arr[to] = val
        this.vm.load(VReg.A0, VReg.FP, arrOff);
        this.vm.load(VReg.A1, VReg.FP, toOff);
        this.vm.load(VReg.A2, VReg.FP, valOff);
        this.vm.call("_array_set");
        // from += step; to += step; count--
        this.vm.load(VReg.V0, VReg.FP, fromOff);
        this.vm.load(VReg.V1, VReg.FP, stepOff);
        this.vm.add(VReg.V0, VReg.V0, VReg.V1);
        this.vm.store(VReg.FP, fromOff, VReg.V0);
        this.vm.load(VReg.V0, VReg.FP, toOff);
        this.vm.load(VReg.V1, VReg.FP, stepOff);
        this.vm.add(VReg.V0, VReg.V0, VReg.V1);
        this.vm.store(VReg.FP, toOff, VReg.V0);
        this.vm.load(VReg.V0, VReg.FP, cntOff);
        this.vm.addImm(VReg.V0, VReg.V0, -1);
        this.vm.store(VReg.FP, cntOff, VReg.V0);
        this.vm.jmp(loopL);
        this.vm.label(doneL);
        this.vm.load(VReg.RET, VReg.FP, arrOff); // 返回接收者
    },

    // [半支持修补] 把 RET 中的裸 int32 索引按 ES 相对索引语义归一后存入 outOff:
    // 负数 +len;再钳到 [0, len]。供 fill/copyWithin 的 start/end/target 复用。
    emitRelativeIndex(lenOff, outOff) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const posL = `_relidx_pos_${id}`;
        const doneL = `_relidx_done_${id}`;
        vm.load(VReg.V1, VReg.FP, lenOff);
        vm.cmpImm(VReg.RET, 0);
        vm.jge(posL);
        vm.add(VReg.RET, VReg.RET, VReg.V1); // RET += len
        vm.cmpImm(VReg.RET, 0);
        vm.jge(posL);
        vm.movImm(VReg.RET, 0);              // 仍 < 0 → 0
        vm.label(posL);
        vm.load(VReg.V1, VReg.FP, lenOff);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jle(doneL);                        // RET <= len 保留
        vm.mov(VReg.RET, VReg.V1);            // RET > len → len
        vm.label(doneL);
        vm.store(VReg.FP, outOff, VReg.RET);
    },

    // 编译 arr.some(callback) -> boolean
    // 注：ArrayCallbackCompiler(builtin_array_callbacks.js) 从未被 mix 进原型，
    // 故 some/every 在编译产物里从来没实现过；此处补齐在活跃 mixin 中。
    compileArraySome(arrayExpr, callbackExpr, thisArgExpr = null) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__some_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8); // 数组 length 在 offset 8
        const lenOffset = this.ctx.allocLocal(`__some_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__some_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "some");

        const idxOffset = this.ctx.allocLocal(`__some_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        const elemOffset = this.ctx.allocLocal(`__some_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("some_loop");
        const endLabel = this.ctx.newLabel("some_end");
        const trueLabel = this.ctx.newLabel("some_true");
        const returnLabel = this.ctx.newLabel("some_return");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        this.vm.mov(VReg.A0, VReg.RET);   // 回调结果 RET->A0（_to_boolean 读 A0）
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(trueLabel);

        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(trueLabel);
        this.vm.lea(VReg.V0, "_js_true");
        this.vm.load(VReg.RET, VReg.V0, 0);
        this.vm.jmp(returnLabel);

        this.vm.label(endLabel);
        this.vm.lea(VReg.V0, "_js_false");
        this.vm.load(VReg.RET, VReg.V0, 0);

        this.vm.label(returnLabel);
    },

    // 编译 arr.sort(comparator) -> 原地排序后的数组
    // 冒泡排序：稳定、原地（依赖数组指针稳定，写回 arrayExpr 的原数组头）。
    // 比较器返回值经 _syscall_arg 归一化为整数；>0 交换（升序）。
    compileArraySort(arrayExpr, callbackExpr) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__sort_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 长度（unbox 后读 @8）
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8);
        const lenOffset = this.ctx.allocLocal(`__sort_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        // 比较器闭包
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__sort_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);

        const iOffset = this.ctx.allocLocal(`__sort_i_${this.nextLabelId()}`);
        const jOffset = this.ctx.allocLocal(`__sort_j_${this.nextLabelId()}`);
        const aOffset = this.ctx.allocLocal(`__sort_a_${this.nextLabelId()}`);
        const bOffset = this.ctx.allocLocal(`__sort_b_${this.nextLabelId()}`);

        const loopI = this.ctx.newLabel("sort_i");
        const endI = this.ctx.newLabel("sort_i_end");
        const loopJ = this.ctx.newLabel("sort_j");
        const endJ = this.ctx.newLabel("sort_j_end");
        const noSwap = this.ctx.newLabel("sort_noswap");

        // i = 0
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, iOffset, VReg.V0);

        this.vm.label(loopI);
        // if i >= len-1: done
        this.vm.load(VReg.V0, VReg.FP, iOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.subImm(VReg.V1, VReg.V1, 1);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endI);

        // j = 0
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, jOffset, VReg.V0);

        this.vm.label(loopJ);
        // limit = len-1-i; if j >= limit: end inner
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.subImm(VReg.V1, VReg.V1, 1);
        this.vm.load(VReg.V2, VReg.FP, iOffset);
        this.vm.sub(VReg.V1, VReg.V1, VReg.V2);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endJ);

        // a = arr[j]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, jOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, aOffset, VReg.RET);
        // b = arr[j+1]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.mov(VReg.A1, VReg.V0);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, bOffset, VReg.RET);

        // cmp = comparator(a, b)
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, aOffset);
        this.vm.load(VReg.A1, VReg.FP, bOffset);
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup(2);

        // 归一化比较结果为整数
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_syscall_arg");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jle(noSwap); // <= 0：不交换

        // 交换 arr[j] <-> arr[j+1]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, jOffset);
        this.vm.load(VReg.A2, VReg.FP, bOffset);
        this.vm.call("_subscript_set");
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.mov(VReg.A1, VReg.V0);
        this.vm.load(VReg.A2, VReg.FP, aOffset);
        this.vm.call("_subscript_set");

        this.vm.label(noSwap);
        // j++
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, jOffset, VReg.V0);
        this.vm.jmp(loopJ);

        this.vm.label(endJ);
        // i++
        this.vm.load(VReg.V0, VReg.FP, iOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, iOffset, VReg.V0);
        this.vm.jmp(loopI);

        this.vm.label(endI);
        // 返回排序后的数组
        this.vm.load(VReg.RET, VReg.FP, arrOffset);
    },

    // 编译 arr.sort() 无比较器 -> 按元素 ToString 的字典序原地排序。
    // 冒泡排序骨架同 compileArraySort，仅把「调用比较器」换成
    // 「_valueToStr 各自装箱成稳定堆串 → _strcmp 比字节」。装箱是关键：
    // _valueToStr 数字路径可能复用静态缓冲，直接连调两次会互相覆盖；
    // 装箱(同 join 的 _js_box_string)得到各自独立堆串，脱壳取 content 供 _strcmp。
    compileArraySortDefault(arrayExpr) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__dsort_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 长度（unbox 后读 @8）
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8);
        const lenOffset = this.ctx.allocLocal(`__dsort_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        const iOffset = this.ctx.allocLocal(`__dsort_i_${this.nextLabelId()}`);
        const jOffset = this.ctx.allocLocal(`__dsort_j_${this.nextLabelId()}`);
        const aOffset = this.ctx.allocLocal(`__dsort_a_${this.nextLabelId()}`);
        const bOffset = this.ctx.allocLocal(`__dsort_b_${this.nextLabelId()}`);
        const saOffset = this.ctx.allocLocal(`__dsort_sa_${this.nextLabelId()}`);

        const loopI = this.ctx.newLabel("dsort_i");
        const endI = this.ctx.newLabel("dsort_i_end");
        const loopJ = this.ctx.newLabel("dsort_j");
        const endJ = this.ctx.newLabel("dsort_j_end");
        const noSwap = this.ctx.newLabel("dsort_noswap");

        // i = 0
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, iOffset, VReg.V0);

        this.vm.label(loopI);
        // if i >= len-1: done
        this.vm.load(VReg.V0, VReg.FP, iOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.subImm(VReg.V1, VReg.V1, 1);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endI);

        // j = 0
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, jOffset, VReg.V0);

        this.vm.label(loopJ);
        // limit = len-1-i; if j >= limit: end inner
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.subImm(VReg.V1, VReg.V1, 1);
        this.vm.load(VReg.V2, VReg.FP, iOffset);
        this.vm.sub(VReg.V1, VReg.V1, VReg.V2);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endJ);

        // a = arr[j]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, jOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, aOffset, VReg.RET);
        // b = arr[j+1]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.mov(VReg.A1, VReg.V0);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, bOffset, VReg.RET);

        // sa = box(ToString(a))  —— 稳定堆串
        this.vm.load(VReg.A0, VReg.FP, aOffset);
        this.vm.call("_valueToStr");
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_box_string");
        this.vm.store(VReg.FP, saOffset, VReg.RET);
        // sb = box(ToString(b))
        this.vm.load(VReg.A0, VReg.FP, bOffset);
        this.vm.call("_valueToStr");
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_box_string");
        // A1 = sb content ptr（脱壳低 48 位）
        this.vm.emitMaskLoad(VReg.V4);
        this.vm.andMaskReg(VReg.A1, VReg.RET, VReg.V4);
        // A0 = sa content ptr
        this.vm.load(VReg.V0, VReg.FP, saOffset);
        this.vm.andMaskReg(VReg.A0, VReg.V0, VReg.V4);
        // cmp = strcmp(sa, sb)；> 0 交换（升序字典序）
        this.vm.call("_strcmp");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jle(noSwap);

        // 交换 arr[j] <-> arr[j+1]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, jOffset);
        this.vm.load(VReg.A2, VReg.FP, bOffset);
        this.vm.call("_subscript_set");
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.mov(VReg.A1, VReg.V0);
        this.vm.load(VReg.A2, VReg.FP, aOffset);
        this.vm.call("_subscript_set");

        this.vm.label(noSwap);
        // j++
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, jOffset, VReg.V0);
        this.vm.jmp(loopJ);

        this.vm.label(endJ);
        // i++
        this.vm.load(VReg.V0, VReg.FP, iOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, iOffset, VReg.V0);
        this.vm.jmp(loopI);

        this.vm.label(endI);
        // 返回排序后的数组
        this.vm.load(VReg.RET, VReg.FP, arrOffset);
    },

    // 编译 arr.every(callback) -> boolean
    compileArrayEvery(arrayExpr, callbackExpr, thisArgExpr = null) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__every_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8);
        const lenOffset = this.ctx.allocLocal(`__every_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__every_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "every");

        const idxOffset = this.ctx.allocLocal(`__every_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        const elemOffset = this.ctx.allocLocal(`__every_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("every_loop");
        const endLabel = this.ctx.newLabel("every_end");
        const falseLabel = this.ctx.newLabel("every_false");
        const returnLabel = this.ctx.newLabel("every_return");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(falseLabel);

        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(falseLabel);
        this.vm.lea(VReg.V0, "_js_false");
        this.vm.load(VReg.RET, VReg.V0, 0);
        this.vm.jmp(returnLabel);

        this.vm.label(endLabel);
        this.vm.lea(VReg.V0, "_js_true");
        this.vm.load(VReg.RET, VReg.V0, 0);

        this.vm.label(returnLabel);
    },

    // 编译 arr.find(callback) -> element or undefined
    compileArrayFind(arrayExpr, callbackExpr, thisArgExpr = null) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__find_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8);
        const lenOffset = this.ctx.allocLocal(`__find_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__find_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "find");

        const idxOffset = this.ctx.allocLocal(`__find_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        const elemOffset = this.ctx.allocLocal(`__find_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("find_loop");
        const endLabel = this.ctx.newLabel("find_end");
        const foundLabel = this.ctx.newLabel("find_found");
        const returnLabel = this.ctx.newLabel("find_return");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        this.vm.mov(VReg.A0, VReg.RET);   // 回调结果搬 A0
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(foundLabel);

        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(foundLabel);
        this.vm.load(VReg.RET, VReg.FP, elemOffset);
        this.vm.jmp(returnLabel);

        this.vm.label(endLabel);
        // 未找到返回 undefined 的**值**（原版 lea 只取地址=真值 → `!find()` 恒 false，
        // 自举 moduleOrder.find 恒判"已存在"从不 push 主模块）。
        this.vm.lea(VReg.V0, "_js_undefined");
        this.vm.load(VReg.RET, VReg.V0, 0);

        this.vm.label(returnLabel);
    },

    // [#35] arr.findLast(cb)/findLastIndex(cb) —— find/findIndex 的反向遍历版
    // (wantIndex=false 返回元素/undefined,true 返回下标/-1)
    compileArrayFindLast(arrayExpr, callbackExpr, wantIndex, thisArgExpr = null) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__findL_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8);
        this.vm.subImm(VReg.V1, VReg.V1, 1); // 从 len-1 起
        const idxOffset = this.ctx.allocLocal(`__findL_idx_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, idxOffset, VReg.V1);

        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__findL_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "findL");
        const elemOffset = this.ctx.allocLocal(`__findL_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("findL_loop");
        const endLabel = this.ctx.newLabel("findL_end");
        const foundLabel = this.ctx.newLabel("findL_found");
        const returnLabel = this.ctx.newLabel("findL_return");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jlt(endLabel);

        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(foundLabel);

        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.subImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(foundLabel);
        if (wantIndex) {
            this.vm.load(VReg.RET, VReg.FP, idxOffset);
        } else {
            this.vm.load(VReg.RET, VReg.FP, elemOffset);
        }
        this.vm.jmp(returnLabel);

        this.vm.label(endLabel);
        if (wantIndex) {
            this.vm.movImm(VReg.RET, -1);
        } else {
            this.vm.lea(VReg.V0, "_js_undefined");
            this.vm.load(VReg.RET, VReg.V0, 0);
        }

        this.vm.label(returnLabel);
        if (wantIndex) {
            this.boxIntAsNumber(VReg.RET);
        }
    },

    // 编译 arr.findIndex(callback) -> index or -1
    compileArrayFindIndex(arrayExpr, callbackExpr, thisArgExpr = null) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__findIdx_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V1, VReg.RET, 8);
        const lenOffset = this.ctx.allocLocal(`__findIdx_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V1);

        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__findIdx_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "findIdx");

        const idxOffset = this.ctx.allocLocal(`__findIdx_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        const elemOffset = this.ctx.allocLocal(`__findIdx_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("findIdx_loop");
        const endLabel = this.ctx.newLabel("findIdx_end");
        const foundLabel = this.ctx.newLabel("findIdx_found");
        const returnLabel = this.ctx.newLabel("findIdx_return");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(foundLabel);

        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(foundLabel);
        this.vm.load(VReg.RET, VReg.FP, idxOffset);
        this.vm.jmp(returnLabel);

        this.vm.label(endLabel);
        this.vm.movImm(VReg.RET, -1);

        this.vm.label(returnLabel);
        this.boxIntAsNumber(VReg.RET);
    },

    // 编译 arr.forEach(callback) - 支持 Array 和 TypedArray
    compileArrayForEach(arrayExpr, callbackExpr, thisArgExpr = null) {
        // 先编译数组和回调
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__forEach_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__forEach_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        const thisArgSlot = this.emitThisArgSlot(thisArgExpr, "forEach");

        // 获取数组长度
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        this.vm.mov(VReg.V0, VReg.RET);
        const lenOffset = this.ctx.allocLocal(`__forEach_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V0);

        // 初始化索引
        const idxOffset = this.ctx.allocLocal(`__forEach_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        // 元素临时存储
        const elemOffset = this.ctx.allocLocal(`__forEach_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("forEach_loop");
        const endLabel = this.ctx.newLabel("forEach_end");

        this.vm.label(loopLabel);

        // 比较索引和长度
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // 获取当前元素 - 使用 _subscript_get 统一处理 Array 和 TypedArray
        this.vm.load(VReg.A0, VReg.FP, arrOffset); // arr
        this.vm.load(VReg.A1, VReg.FP, idxOffset); // index
        this.vm.call("_subscript_get");

        // 保存元素值
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // 加载闭包并 push
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);

        // 设置参数
        this.vm.load(VReg.A0, VReg.FP, elemOffset); // element
        this.vm.load(VReg.A1, VReg.FP, idxOffset); // index (raw)
        this.vm.scvtf(0, VReg.A1);                  // int → double
        this.vm.fmovToInt(VReg.A1, 0);              // → 装箱 JS number（回调 i 才是数字而非裸整数≈0）
        this.vm.load(VReg.A2, VReg.FP, arrOffset); // array

        // 弹出闭包到 S0
        this.vm.pop(VReg.S0);

        // 调用闭包
        this.emitClosureCallAfterSetup();

        // 索引++
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        this.vm.jmp(loopLabel);
        this.vm.label(endLabel);

        this.vm.movImm(VReg.RET, 0); // forEach 返回 undefined
    },

    // 闭包调用的核心逻辑（S0 = 闭包对象，参数已在 A0-A5 中）
    // 求值可选 thisArg(回调方法第 2 参)一次,存入新 FP 槽,并把槽偏移暂存到实例字段
    // _pendingThisArgSlot,供**紧接着的**那次 emitClosureCallAfterSetup 消费(消费即清)。
    // 无 thisArg:清字段并**不发射任何指令、不分配槽、不推进 labelId**(无 thisArg 路径逐
    // 字节不变)。须在回调已求值之后调用(求值序:接收者→回调→thisArg,同 node)。
    // 字段传递而非显式实参:避免改动每个回调方法里(结构各异的)间接调用点,降低回归面;
    // 单个回调方法内 set→loop 内唯一一次 call 之间无其它闭包调用,故不会跨方法泄漏。
    emitThisArgSlot(thisArgExpr, tag) {
        if (!thisArgExpr) { this._pendingThisArgSlot = null; return null; }
        this.compileExpression(thisArgExpr);
        const slot = this.ctx.allocLocal(`__${tag}_thisarg_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, slot, VReg.RET);
        this._pendingThisArgSlot = slot;
        return slot;
    },

    // 回调间接调用。若 _pendingThisArgSlot 非空,则在调用前把 A5(隐藏的 this 寄存器,见
    // compileMethodCall)载入该 thisArg,使回调体内 this 绑定之;随即清空字段(消费一次)。
    // 无 pending(常态)时不发射任何额外指令 → 字节与今日一致,保护热回调路径与自举定点。
    emitClosureCallAfterSetup(argcN = 3) {
        const vm = this.vm;
        const CLOSURE_MAGIC = 0xc105;
        const ASYNC_CLOSURE_MAGIC = 0xa51c;
        const thisArgSlot = this._pendingThisArgSlot != null ? this._pendingThisArgSlot : null;
        this._pendingThisArgSlot = null; // 消费一次,避免泄漏到后续闭包调用

        const notClosureLabel = this.ctx.newLabel("cb_not_closure");
        const callLabel = this.ctx.newLabel("cb_do_call");
        const asyncLabel = this.ctx.newLabel("cb_async");
        const doneLabel = this.ctx.newLabel("cb_done");

        // S0 可能是 NaN-boxed 函数(0x7FFF) / 装箱 Proxy(0x7FFD) / 闭包对象裸指针 /
        // 纯函数指针。无条件掩码脱壳(裸指针高16=0 恒等;此前仅 0x7FFF 去壳 → 装箱
        // proxy 带 tag 解引用 [S0+0] 段错 → [1,2].map(proxyCallable) 崩)。
        vm.emitMaskLoad(VReg.S1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.S1);

        // 加载 magic
        vm.load(VReg.S1, VReg.S0, 0);

        // 检查是否是 async 闭包
        vm.movImm(VReg.S2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jeq(asyncLabel);

        // 检查是否是普通闭包
        vm.movImm(VReg.S2, CLOSURE_MAGIC);
        vm.cmp(VReg.S1, VReg.S2);
        vm.jne(notClosureLabel);

        // 是闭包：加载函数指针
        vm.load(VReg.S1, VReg.S0, 8);
        vm.jmp(callLabel);

        vm.label(asyncLabel);
        // async 闭包暂不支持在 forEach 回调中使用
        vm.jmp(doneLabel);

        vm.label(notClosureLabel);
        {
            // [Proxy 回调] 可调用 Proxy(type@0==8)→ _validate_callable 合成闭包块
            // {0xc105, tramp, proxyRaw}(in/out=S0,A0-A5/S1/S2 保持)→ 按闭包分派。
            const rawFnLabel = this.ctx.newLabel("cb_raw_fn");
            vm.movImm(VReg.S2, 8); // TYPE_PROXY
            vm.cmp(VReg.S1, VReg.S2);
            vm.jne(rawFnLabel);
            // _validate_callable 的 proxy 判别要求**装箱 0x7FFD 形态**(裸指针落 raw 路
            // 会被当纯函数指针返回 → [proxy+8]=装箱 target 被当 fnptr 跳转 → 段错)。
            vm.movImm64(VReg.S2, 0x7ffd000000000000n);
            vm.or(VReg.S0, VReg.S0, VReg.S2);
            vm.call("_validate_callable"); // S0 → 合成闭包块
            vm.load(VReg.S1, VReg.S0, 8);  // tramp 地址
            vm.jmp(callLabel);
            vm.label(rawFnLabel);
            // 直接是函数指针
            vm.mov(VReg.S1, VReg.S0);
            vm.movImm(VReg.S0, 0);
        }

        vm.label(callLabel);
        // 有 thisArg 时绑定 this(A5);无则不发射,字节与今日一致。
        if (thisArgSlot != null) {
            vm.load(VReg.A5, VReg.FP, thisArgSlot);
        }
        vm.setCallArgcImm(argcN, VReg.V5, VReg.V6); // [argc ABI]
        vm.callIndirect(VReg.S1);

        vm.label(doneLabel);
    },

    // 编译 arr.map(callback) - 支持 Array 和 TypedArray
    compileArrayMap(arrayExpr, callbackExpr, thisArgExpr = null) {
        // 编译数组
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__map_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 保存数组类型（用于创建同类型的结果数组）
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V0, VReg.RET, 0); // 加载类型标签（unbox 后的裸指针）
        this.vm.andImm(VReg.V0, VReg.V0, 0xff); // 取低 8 位
        const typeOffset = this.ctx.allocLocal(`__map_type_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, typeOffset, VReg.V0);

        // 获取数组长度
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        this.vm.mov(VReg.V0, VReg.RET); // 长度
        const lenOffset = this.ctx.allocLocal(`__map_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V0);

        // 根据类型创建新数组
        // 检查是否是 TypedArray (类型 >= 0x40)
        this.vm.load(VReg.V1, VReg.FP, typeOffset);
        this.vm.cmpImm(VReg.V1, 0x40);
        const createTypedArray = this.ctx.newLabel("map_create_ta");
        const createDone = this.ctx.newLabel("map_create_done");
        this.vm.jge(createTypedArray);

        // 创建普通 Array（标准布局 [type,length,capacity,elems@24]）：
        // 用 _array_new_with_size(length)，替掉原来手写 _alloc+16 字节头（缺 capacity）——
        // 后者与 _subscript_set/get 的标准 24 字节头布局不一致 → 元素写/读错位、map 结果
        // 全为 0（与已修的 filter 同类 bug）。
        this.vm.load(VReg.A0, VReg.FP, lenOffset);
        this.vm.call("_array_new_with_size");
        this.vm.jmp(createDone);

        // 创建 TypedArray
        this.vm.label(createTypedArray);
        this.vm.load(VReg.A0, VReg.FP, typeOffset); // type
        this.vm.load(VReg.A1, VReg.FP, lenOffset); // length
        this.vm.call("_typed_array_new");

        this.vm.label(createDone);
        const newArrOffset = this.ctx.allocLocal(`__map_newarr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);

        // 编译回调
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__map_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "map");

        // 初始化索引
        const idxOffset = this.ctx.allocLocal(`__map_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        // 元素临时存储
        const elemOffset = this.ctx.allocLocal(`__map_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("map_loop");
        const endLabel = this.ctx.newLabel("map_end");

        this.vm.label(loopLabel);

        // 比较索引和长度
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // 获取当前元素 - 使用 _subscript_get 统一处理
        this.vm.load(VReg.A0, VReg.FP, arrOffset); // arr
        this.vm.load(VReg.A1, VReg.FP, idxOffset); // index
        this.vm.call("_subscript_get");

        // 保存元素值
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // 准备闭包调用
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);

        // 设置参数
        this.vm.load(VReg.A0, VReg.FP, elemOffset); // element
        this.vm.load(VReg.A1, VReg.FP, idxOffset); // index (raw)
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset); // array

        // 弹出闭包并调用
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        // 存储结果到新数组 - 使用 _subscript_set 统一处理
        this.vm.mov(VReg.A2, VReg.RET); // value (返回值)
        this.vm.load(VReg.A0, VReg.FP, newArrOffset); // arr
        this.vm.load(VReg.A1, VReg.FP, idxOffset); // index
        this.vm.call("_subscript_set");

        // 索引++
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        this.vm.jmp(loopLabel);
        this.vm.label(endLabel);

        // 返回新数组:普通数组装箱 0x7FFE(for-of tag 检测,同 filter);TypedArray 结果保持
        // 裸指针(TA 以裸指针流通,打印/下标按头字节识别——误装 0x7FFE 会让 _print_array
        // 把 buffer@24 当 data_ptr 解引 → 段错误;与 filter 末段 TA 处理对齐)。
        this.vm.load(VReg.RET, VReg.FP, newArrOffset);
        this.vm.load(VReg.V1, VReg.FP, typeOffset);
        this.vm.cmpImm(VReg.V1, 0x40);
        const mapBoxDone = this.ctx.newLabel("map_box_done");
        this.vm.jge(mapBoxDone);
        this.vm.call("_box_arr_r"); // box->helper
        this.vm.label(mapBoxDone);
    },

    // 编译 arr.flatMap(callback) —— map 后把返回的数组展平一层。
    // 结果用 _array_new_with_size(0)+_array_push 增长构建(同 filter,标准布局)。
    // 回调返回数组(tag 0x7ffe)→ 逐元素 push;否则整体 push 一次。
    compileArrayFlatMap(arrayExpr, callbackExpr) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__flatmap_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 源数组长度
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        const lenOffset = this.ctx.allocLocal(`__flatmap_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.RET);

        // 空结果数组(装箱前是裸指针)
        this.vm.movImm(VReg.A0, 0);
        this.vm.call("_array_new_with_size");
        const newArrOffset = this.ctx.allocLocal(`__flatmap_newarr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);

        // 回调闭包
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__flatmap_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);

        const idxOffset = this.ctx.allocLocal(`__flatmap_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        const elemOffset = this.ctx.allocLocal(`__flatmap_elem_${this.nextLabelId()}`);
        const mapOffset = this.ctx.allocLocal(`__flatmap_mapped_${this.nextLabelId()}`);
        const jOffset = this.ctx.allocLocal(`__flatmap_j_${this.nextLabelId()}`);
        const len2Offset = this.ctx.allocLocal(`__flatmap_len2_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("flatmap_loop");
        const endLabel = this.ctx.newLabel("flatmap_end");
        const notArrLabel = this.ctx.newLabel("flatmap_notarr");
        const innerLabel = this.ctx.newLabel("flatmap_inner");
        const innerEndLabel = this.ctx.newLabel("flatmap_inner_end");
        const nextLabel = this.ctx.newLabel("flatmap_next");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // elem = src[idx]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // mapped = cb(elem, idx, arr)
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();
        this.vm.store(VReg.FP, mapOffset, VReg.RET);

        // 数组？高16 == 0x7ffe → 展平一层
        this.vm.shrImm(VReg.V0, VReg.RET, 48);
        this.vm.cmpImm(VReg.V0, 0x7ffe);
        this.vm.jne(notArrLabel);

        // len2 = length(mapped); j=0..len2: newArr = push(newArr, mapped[j])
        this.vm.load(VReg.A0, VReg.FP, mapOffset);
        this.vm.call("_array_length");
        this.vm.store(VReg.FP, len2Offset, VReg.RET);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, jOffset, VReg.V0);

        this.vm.label(innerLabel);
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.load(VReg.V1, VReg.FP, len2Offset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(innerEndLabel);
        this.vm.load(VReg.A0, VReg.FP, mapOffset);
        this.vm.load(VReg.A1, VReg.FP, jOffset);
        this.vm.call("_subscript_get");
        this.vm.mov(VReg.A1, VReg.RET);
        this.vm.load(VReg.A0, VReg.FP, newArrOffset);
        this.vm.call("_array_push");
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);
        this.vm.load(VReg.V0, VReg.FP, jOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, jOffset, VReg.V0);
        this.vm.jmp(innerLabel);
        this.vm.label(innerEndLabel);
        this.vm.jmp(nextLabel);

        // 非数组:整体 push 一次
        this.vm.label(notArrLabel);
        this.vm.load(VReg.A1, VReg.FP, mapOffset);
        this.vm.load(VReg.A0, VReg.FP, newArrOffset);
        this.vm.call("_array_push");
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);

        this.vm.label(nextLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(endLabel);
        this.vm.load(VReg.RET, VReg.FP, newArrOffset);
        this.vm.call("_box_arr_r"); // box->helper
        return;
    },

    // 编译 arr.filter(callback) - 支持 Array 和 TypedArray
    compileArrayFilter(arrayExpr, callbackExpr, thisArgExpr = null) {
        // 结果用 _array_new_with_size(0)+_array_push 构建（已验证可靠、标准布局），
        // 替掉原来手写 _alloc+[0]=1+_subscript_set 的非标准布局——后者结果 length 对
        // 但元素读 NULL、下标越界即崩（filter 结果被 [i] 访问必崩），是自举
        // createModuleMeta 的 `body.filter(...)[i]` 段错误根因。
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__filter_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 源类型字节(裸指针@0 低 8 位):>=0x40 即 TypedArray → 结果转同型(node 语义,
        // filter 保留接收者类型)。普通数组(<0x40)结果保持普通数组。
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V0, VReg.RET, 0);
        this.vm.andImm(VReg.V0, VReg.V0, 0xff);
        const typeOffset = this.ctx.allocLocal(`__filter_type_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, typeOffset, VReg.V0);

        // 源数组长度
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        const lenOffset = this.ctx.allocLocal(`__filter_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.RET);

        // 建空结果数组（标准布局，装箱）
        this.vm.movImm(VReg.A0, 0);
        this.vm.call("_array_new_with_size");
        const newArrOffset = this.ctx.allocLocal(`__filter_newarr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);

        // 回调
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__filter_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "filter");

        const idxOffset = this.ctx.allocLocal(`__filter_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        const elemOffset = this.ctx.allocLocal(`__filter_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("filter_loop");
        const skipLabel = this.ctx.newLabel("filter_skip");
        const endLabel = this.ctx.newLabel("filter_end");

        this.vm.label(loopLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // elem = src[idx]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // cb(elem, idx, arr)
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, elemOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(skipLabel);

        // 保留：newArr = _array_push(newArr, elem)（捕获扩容后新装箱指针）
        this.vm.load(VReg.A1, VReg.FP, elemOffset);
        this.vm.load(VReg.A0, VReg.FP, newArrOffset);
        this.vm.call("_array_push");
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);

        this.vm.label(skipLabel);
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);

        this.vm.label(endLabel);
        this.vm.load(VReg.RET, VReg.FP, newArrOffset);
        // 装箱为 0x7FFE 数组 JSValue——_array_new_with_size 返回裸指针，_array_push 保留
        // 输入标签（此处输入无标签 0x0000），故链末仍是裸指针；未装箱则 for-of 的
        // tag 检测(>>48==0x7ffe)失败落入 Symbol.iterator 路径而崩。
        this.vm.call("_box_arr_r"); // box->helper
        // TypedArray 源:把普通数组结果转成同型 TypedArray(_typed_array_from 逐元素按类型
        // 强转存,含 Uint8Clamped 饱和)。普通数组源跳过。
        const filtEnd = this.ctx.newLabel("filter_ret");
        // x64:V0 与 RET 同为 RAX。用 V0 读 typeOffset 会毁掉 _box_arr_r 刚装箱的结果——
        // 普通数组(type<0x40)随即 jlt 跳到 filtEnd,RET 已变成类型字节(1)→ filter 返回
        // 数字 4e-324 而非数组(typeof number、后续 .length/下标段错)。x64 改用不与 RET
        // 别名的 V5 作类型比较暂存;arm64 上 V0≠RET,保持 V0 → 逐字节不变、自举定点不动。
        const typeReg = this.vm.backend.name === "x64" ? VReg.V5 : VReg.V0;
        this.vm.load(typeReg, VReg.FP, typeOffset);
        this.vm.cmpImm(typeReg, 0x40);
        this.vm.jlt(filtEnd);
        this.vm.mov(VReg.A1, VReg.RET);            // 普通数组结果(boxed)
        this.vm.load(VReg.A0, VReg.FP, typeOffset); // type
        this.vm.call("_typed_array_from");
        this.vm.label(filtEnd);
        return;
    },

    // 旧手写实现（保留死代码引用，已不走到）
    _compileArrayFilter_legacy(arrayExpr, callbackExpr) {
        // 编译数组
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__filter_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 保存数组类型（RET 是装箱数组，需先 unbox）
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_js_unbox");
        this.vm.load(VReg.V0, VReg.RET, 0);
        this.vm.andImm(VReg.V0, VReg.V0, 0xff);
        const typeOffset = this.ctx.allocLocal(`__filter_type_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, typeOffset, VReg.V0);

        // 获取数组长度
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        this.vm.mov(VReg.V0, VReg.RET);
        const lenOffset = this.ctx.allocLocal(`__filter_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.V0);

        // 根据类型创建新数组（最大可能大小）
        this.vm.load(VReg.V1, VReg.FP, typeOffset);
        this.vm.cmpImm(VReg.V1, 0x40);
        const createTypedArray = this.ctx.newLabel("filter_create_ta");
        const createDone = this.ctx.newLabel("filter_create_done");
        this.vm.jge(createTypedArray);

        // 创建普通 Array
        this.vm.load(VReg.V0, VReg.FP, lenOffset);
        this.vm.shl(VReg.A0, VReg.V0, 3);
        this.vm.addImm(VReg.A0, VReg.A0, 16);
        this.vm.call("_alloc");
        this.vm.mov(VReg.S1, VReg.RET);
        this.vm.movImm(VReg.V1, 1);
        this.vm.store(VReg.S1, 0, VReg.V1);
        this.vm.movImm(VReg.V1, 0);
        this.vm.store(VReg.S1, 8, VReg.V1);
        this.vm.mov(VReg.RET, VReg.S1);
        this.vm.jmp(createDone);

        // 创建 TypedArray
        this.vm.label(createTypedArray);
        this.vm.load(VReg.A0, VReg.FP, typeOffset);
        this.vm.load(VReg.A1, VReg.FP, lenOffset);
        this.vm.call("_typed_array_new");
        // 重置长度为 0 (会在添加时递增)
        // 注意：_typed_array_new 后 V0 可能被修改，需要重新设置
        this.vm.mov(VReg.V0, VReg.RET); // 保存新数组指针
        this.vm.movImm(VReg.V1, 0);
        this.vm.store(VReg.V0, 8, VReg.V1);
        this.vm.mov(VReg.RET, VReg.V0); // 恢复 RET

        this.vm.label(createDone);
        const newArrOffset = this.ctx.allocLocal(`__filter_newarr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, newArrOffset, VReg.RET);

        // 编译回调
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__filter_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);

        // 初始化索引
        const idxOffset = this.ctx.allocLocal(`__filter_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, 0);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        // 元素临时存储
        const elemOffset = this.ctx.allocLocal(`__filter_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("filter_loop");
        const addLabel = this.ctx.newLabel("filter_add");
        const skipLabel = this.ctx.newLabel("filter_skip");
        const endLabel = this.ctx.newLabel("filter_end");

        this.vm.label(loopLabel);

        // 比较索引和长度
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // 获取当前元素 - 使用 _subscript_get 统一处理
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");

        // 保存当前元素
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // 准备闭包调用
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);

        // 设置参数
        this.vm.load(VReg.A0, VReg.FP, elemOffset); // element
        this.vm.load(VReg.A1, VReg.FP, idxOffset); // index (raw)
        this.vm.scvtf(0, VReg.A1); this.vm.fmovToInt(VReg.A1, 0); // index → 装箱 JS number
        this.vm.load(VReg.A2, VReg.FP, arrOffset); // array

        // 弹出闭包并调用
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup();

        // 检查返回值是否为 truthy（回调可能返回 JS bool / 任意值，
        // 用 _to_boolean 完整判真值，而非与整数 0 比较）
        this.vm.mov(VReg.A0, VReg.RET);
        this.vm.call("_to_boolean");
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jeq(skipLabel);

        // 添加元素到新数组 - 使用 _subscript_set 统一处理
        this.vm.label(addLabel);
        this.vm.load(VReg.A0, VReg.FP, newArrOffset); // arr
        this.vm.load(VReg.A1, VReg.A0, 8); // 当前长度作为 index
        this.vm.load(VReg.A2, VReg.FP, elemOffset); // value

        // 存储元素
        this.vm.call("_subscript_set");

        // 更新长度（在存储之后）
        this.vm.load(VReg.V0, VReg.FP, newArrOffset);
        this.vm.load(VReg.V1, VReg.V0, 8); // 读取当前长度
        this.vm.addImm(VReg.V1, VReg.V1, 1);
        this.vm.store(VReg.V0, 8, VReg.V1);

        this.vm.label(skipLabel);
        // 索引++
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        this.vm.jmp(loopLabel);
        this.vm.label(endLabel);

        // 返回新数组（装箱为 JS 数组 0x7FFE，供 for-of/typeof/下标等识别）
        this.vm.load(VReg.RET, VReg.FP, newArrOffset);
        this.vm.call("_box_arr_r"); // box->helper
    },

    // 编译 arr.reduce(callback, initialValue?)
    compileArrayReduce(arrayExpr, callbackExpr, initialValueExpr) {
        // 编译数组
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__reduce_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // 获取数组长度——用 _array_length（内部脱壳）。原来直接读 [RET+8] 是对**装箱**
        // 数组指针(0x7ffe tag)解引用 → 高位 0x7ffe 使地址巨大 → load 段错误崩溃。
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        const lenOffset = this.ctx.allocLocal(`__reduce_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.RET);

        // 初始化累加器
        const accOffset = this.ctx.allocLocal(`__reduce_acc_${this.nextLabelId()}`);
        if (initialValueExpr) {
            this.compileExpression(initialValueExpr);
            this.vm.store(VReg.FP, accOffset, VReg.RET);
        } else {
            // 无初始值时，使用第一个元素作为初始值
            // 使用 _subscript_get 统一处理 Array 和 TypedArray
            this.vm.load(VReg.A0, VReg.FP, arrOffset);
            this.vm.movImm(VReg.A1, 0);
            this.vm.call("_subscript_get");
            this.vm.store(VReg.FP, accOffset, VReg.RET);
        }

        // 编译回调
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__reduce_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);

        // 初始化索引（如果有初始值从 0 开始，否则从 1 开始）
        const idxOffset = this.ctx.allocLocal(`__reduce_idx_${this.nextLabelId()}`);
        this.vm.movImm(VReg.V0, initialValueExpr ? 0 : 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        // 元素临时存储（在循环外分配）
        const elemOffset = this.ctx.allocLocal(`__reduce_elem_${this.nextLabelId()}`);

        const loopLabel = this.ctx.newLabel("reduce_loop");
        const endLabel = this.ctx.newLabel("reduce_end");

        this.vm.label(loopLabel);

        // 比较索引和长度
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.load(VReg.V1, VReg.FP, lenOffset);
        this.vm.cmp(VReg.V0, VReg.V1);
        this.vm.jge(endLabel);

        // 获取当前元素 - 使用 _subscript_get 统一处理 Array 和 TypedArray
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");

        // 保存当前元素
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // 准备闭包调用
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);

        // 设置参数: callback(accumulator, currentValue, index, array)
        this.vm.load(VReg.A0, VReg.FP, accOffset); // accumulator
        this.vm.load(VReg.A1, VReg.FP, elemOffset); // currentValue
        this.vm.load(VReg.A2, VReg.FP, idxOffset); // index (raw)
        this.vm.scvtf(0, VReg.A2); this.vm.fmovToInt(VReg.A2, 0); // index → 装箱 JS number
        this.vm.load(VReg.A3, VReg.FP, arrOffset); // array

        // 弹出闭包并调用
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup(4);

        // 更新累加器
        this.vm.store(VReg.FP, accOffset, VReg.RET);

        // 索引++
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.addImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);

        this.vm.jmp(loopLabel);
        this.vm.label(endLabel);

        // 返回累加器
        this.vm.load(VReg.RET, VReg.FP, accOffset);
    },

    // 编译 arr.reduceRight(callback, initialValue?) —— reduce 的镜像:从 len-1 递减到 0。
    // 无初值时以末元素为初值、索引从 len-2 起;回调签名同 reduce(acc, cur, idx, arr)。
    compileArrayReduceRight(arrayExpr, callbackExpr, initialValueExpr) {
        this.compileExpression(arrayExpr);
        const arrOffset = this.ctx.allocLocal(`__rredr_arr_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, arrOffset, VReg.RET);

        // len = _array_length(arr)
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.call("_array_length");
        const lenOffset = this.ctx.allocLocal(`__rredr_len_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, lenOffset, VReg.RET);

        // 累加器初值
        const accOffset = this.ctx.allocLocal(`__rredr_acc_${this.nextLabelId()}`);
        const idxOffset = this.ctx.allocLocal(`__rredr_idx_${this.nextLabelId()}`);
        if (initialValueExpr) {
            this.compileExpression(initialValueExpr);
            this.vm.store(VReg.FP, accOffset, VReg.RET);
            // idx = len - 1
            this.vm.load(VReg.V0, VReg.FP, lenOffset);
            this.vm.subImm(VReg.V0, VReg.V0, 1);
            this.vm.store(VReg.FP, idxOffset, VReg.V0);
        } else {
            // 无初值:acc = arr[len-1],idx = len-2
            this.vm.load(VReg.V0, VReg.FP, lenOffset);
            this.vm.subImm(VReg.V0, VReg.V0, 1);
            this.vm.store(VReg.FP, idxOffset, VReg.V0);
            this.vm.load(VReg.A0, VReg.FP, arrOffset);
            this.vm.mov(VReg.A1, VReg.V0);
            this.vm.call("_subscript_get");
            this.vm.store(VReg.FP, accOffset, VReg.RET);
            this.vm.load(VReg.V0, VReg.FP, idxOffset);
            this.vm.subImm(VReg.V0, VReg.V0, 1);
            this.vm.store(VReg.FP, idxOffset, VReg.V0);
        }

        // 回调
        this.compileExpression(callbackExpr);
        const cbOffset = this.ctx.allocLocal(`__rredr_cb_${this.nextLabelId()}`);
        this.vm.store(VReg.FP, cbOffset, VReg.RET);

        const elemOffset = this.ctx.allocLocal(`__rredr_elem_${this.nextLabelId()}`);
        const loopLabel = this.ctx.newLabel("rredr_loop");
        const endLabel = this.ctx.newLabel("rredr_end");

        this.vm.label(loopLabel);
        // idx < 0 → 结束
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.cmpImm(VReg.V0, 0);
        this.vm.jlt(endLabel);

        // 当前元素 arr[idx]
        this.vm.load(VReg.A0, VReg.FP, arrOffset);
        this.vm.load(VReg.A1, VReg.FP, idxOffset);
        this.vm.call("_subscript_get");
        this.vm.store(VReg.FP, elemOffset, VReg.RET);

        // callback(acc, cur, idx, arr)
        this.vm.load(VReg.V6, VReg.FP, cbOffset);
        this.vm.push(VReg.V6);
        this.vm.load(VReg.A0, VReg.FP, accOffset);
        this.vm.load(VReg.A1, VReg.FP, elemOffset);
        this.vm.load(VReg.A2, VReg.FP, idxOffset);
        this.vm.scvtf(0, VReg.A2); this.vm.fmovToInt(VReg.A2, 0); // idx → 装箱 number
        this.vm.load(VReg.A3, VReg.FP, arrOffset);
        this.vm.pop(VReg.S0);
        this.emitClosureCallAfterSetup(4);
        this.vm.store(VReg.FP, accOffset, VReg.RET);

        // idx--
        this.vm.load(VReg.V0, VReg.FP, idxOffset);
        this.vm.subImm(VReg.V0, VReg.V0, 1);
        this.vm.store(VReg.FP, idxOffset, VReg.V0);
        this.vm.jmp(loopLabel);
        this.vm.label(endLabel);

        this.vm.load(VReg.RET, VReg.FP, accOffset);
    },
};

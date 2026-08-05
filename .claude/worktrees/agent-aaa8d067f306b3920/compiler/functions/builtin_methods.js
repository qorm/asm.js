// asm.js 编译器 - 内置类型方法编译
// 编译 Math、Array、Map、Set、Date、RegExp 等内置类型的方法

import { VReg } from "../../vm/index.js";

// 内置方法编译方法混入
export const BuiltinMethodCompiler = {
    // 编译 RegExp 方法调用
    // obj.test(str), obj.exec(str) → 纯 JS shim __RE_test/__RE_exec(批次D)。
    // 原 _regexp_test/_regexp_exec 是壳(子串搜索/恒 null)。正常路径在
    // compileCallExpression 的 REGEXP 分派已拦截,此处为 objType 分派的兜底,保持一致。
    compileRegExpMethod(obj, method, args) {
        if (method !== "test" && method !== "exec") return false;
        this.compileExpression({
            type: "CallExpression",
            callee: { type: "Identifier", name: "__RE_" + method },
            arguments: [obj, args.length > 0 ? args[0] : { type: "Literal", value: "" }],
        });
        return true;
    },

    // 编译 String 方法调用
    // str.toUpperCase(), str.toLowerCase(), str.charAt(i), str.trim() 等
    compileStringMethod(obj, method, args) {
        // 先编译字符串表达式
        this.compileExpression(obj);
        this.vm.push(VReg.RET); // 保存原始字符串

        switch (method) {
            case "toUpperCase":
                // str.toUpperCase() - 返回新字符串
                // 直接传递字符串给 _str_toUpperCase，它会处理 unboxing
                this.vm.pop(VReg.A0);
                this.vm.call("_str_toUpperCase");
                return true;

            case "toLowerCase":
                // str.toLowerCase() - 返回新字符串
                // 直接传递字符串给 _str_toLowerCase，它会处理 unboxing
                this.vm.pop(VReg.A0);
                this.vm.call("_str_toLowerCase");
                return true;

            case "charAt":
                // str.charAt(index) - 返回单字符字符串
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    // 索引是浮点数表示，转为整数 (使用 VM 统一接口)
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A1, 0);
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_charAt");
                return true;

            case "at":
                // str.at(index) - 支持负索引；_str_at 内部自行 _to_int32,故传 NaN-boxed 索引
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.A1, 0x7FF8000000000000n); // 0 (boxed)
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_at");
                return true;

            case "codePointAt":
                // str.codePointAt(index):ASCII/BMP 与 charCodeAt 等价(asm.js UTF-8
                // 字节语义下,astral 码点索引本属深水,不追)。此前无 case → default 崩溃。
                // 别名到 charCodeAt(同接收者/索引处理),把崩溃变 ASCII 正确。
            case "charCodeAt":
                // str.charCodeAt(index) - 返回字符编码
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    // 索引是浮点数表示，转为整数 (使用 VM 统一接口)
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A1, 0);
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_charCodeAt");
                // _str_charCodeAt 已返回标准 JS number（float64 位），无需装箱
                return true;

            case "trim":
                // str.trim() - 去除首尾空白
                this.vm.pop(VReg.A0);
                this.vm.call("_getStrContent");
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.call("_str_trim");
                return true;

            case "slice":
                // str.slice(start, end) —— slice 语义(负→从末尾、start>end→空)。
                // substring 语义不同(负→0、swap),见下方独立 case。
                // 先获取字符串内容指针
                this.vm.pop(VReg.A0);
                this.vm.call("_getStrContent");
                this.vm.push(VReg.RET); // 保存内容指针

                // 编译 start 参数
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    // x64: RET(RAX) 与 A0(RDI) 是不同寄存器, _to_int32 读 A0, 需显式搬运;
                    // arm64: RET(X0)==A0(X0) 同寄存器, 加 mov 会改字节, 故守卫仅 x64。
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    // 确保是 Int32 (NaN-boxed) - 使用 V1 避免覆盖 RET (V0 和 RET 都映射到 X0)
                    this.vm.call("_to_int32");
                    // 截断为低32位再装箱（负数的高位会与tag冲突）
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.push(VReg.RET); // 保存 start (boxed)
                } else {
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n); // 0 (boxed)
                    this.vm.push(VReg.V1);
                }

                // 编译 end 参数
                if (args.length > 1) {
                    this.compileExpression(args[1]);
                    // x64: 同上, RET->A0 显式搬运
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    // 确保是 Int32 (NaN-boxed) - 使用 V1 避免覆盖 RET
                    this.vm.call("_to_int32");
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.mov(VReg.A2, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.A2, 0x7ffb000000000000n); // JS_UNDEFINED
                }

                this.vm.pop(VReg.A1); // start
                this.vm.pop(VReg.A0); // str content
                this.vm.call("_str_slice");
                return true;

            case "substring":
                // str.substring(start[, end]) —— substring 语义:负→0、start>end 交换
                // (≠ slice)。_str_substring(A0=boxed str, A1=start, A2=end) 内部
                // getStrContent + clamp[0,len] + swap。接收者(装箱串)在栈顶,勿提前
                // getStrContent(_str_substring 自行处理)。此前与 slice 共用 _str_slice
                // 致 `"hello".substring(3,1)` 返 "" 而非交换后 "el"。
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_int32");
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.push(VReg.RET); // start(boxed),压在接收者之上
                } else {
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n); // 0(boxed)
                    this.vm.push(VReg.V1);
                }
                if (args.length > 1) {
                    this.compileExpression(args[1]);
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_int32");
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.mov(VReg.A2, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.A2, 0x7ffb000000000000n); // JS_UNDEFINED
                }
                this.vm.pop(VReg.A1); // start
                this.vm.pop(VReg.A0); // 接收者(装箱串,未 getStrContent)
                this.vm.call("_str_substring");
                return true;

            case "substr":
                // str.substr(start, length) —— 第二参是长度(非 end),负 start 从末尾计。
                // 接收者(装箱串)已在栈上(行首 push);_str_substr 内部自行 getStrContent。
                // A0=装箱串, A1=start(boxed int), A2=length(boxed 或 undefined)。
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_int32");
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.push(VReg.RET); // start (boxed)
                } else {
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n); // 0 (boxed)
                    this.vm.push(VReg.V1);
                }

                if (args.length > 1) {
                    this.compileExpression(args[1]);
                    if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_to_int32");
                    this.vm.movImm64(VReg.V1, 0xFFFFFFFFn);
                    this.vm.and(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.movImm64(VReg.V1, 0x7FF8000000000000n);
                    this.vm.or(VReg.RET, VReg.RET, VReg.V1);
                    this.vm.mov(VReg.A2, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.A2, 0x7ffb000000000000n); // JS_UNDEFINED
                }

                this.vm.pop(VReg.A1); // start
                this.vm.pop(VReg.A0); // str content
                this.vm.call("_str_substr");
                return true;

            case "replace":
            case "replaceAll":
                // str.replace/replaceAll(search, repl) —— 仅支持字符串 search（非正则）。
                // 接收者(装箱串)已在栈上;A0=str, A1=search(装箱串), A2=repl(装箱串)。
                // 缺参(<2)退化为返回原串,避免把 undefined 传给 _strconcat。
                if (args.length >= 2) {
                    // 函数替换:str.replace(search, fn) → 调 fn(matched) 取替换串(仅 replace 首个匹配)。
                    const replIsFn = args[1].type === "FunctionExpression" || args[1].type === "ArrowFunctionExpression";
                    this.compileExpression(args[0]);
                    this.vm.push(VReg.RET);          // search
                    this.compileExpression(args[1]);
                    this.vm.mov(VReg.A2, VReg.RET);  // repl(串或函数闭包)
                    this.vm.pop(VReg.A1);            // search
                    this.vm.pop(VReg.A0);            // str
                    if (replIsFn && method !== "replaceAll") {
                        this.vm.call("_str_replace_fn");
                    } else {
                        this.vm.call(method === "replaceAll" ? "_str_replaceAll" : "_str_replace");
                    }
                } else {
                    this.vm.pop(VReg.A0);
                    this.vm.mov(VReg.RET, VReg.A0);  // 原串
                }
                return true;

            case "indexOf":
                // str.indexOf(search, fromIndex?) - 返回索引或 -1
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_getStrContent");
                    if (args.length > 1) {
                        // fromIndex:先存 search content,编译第二参转裸 int 入 A2
                        this.vm.push(VReg.RET);
                        this.compileExpression(args[1]);
                        if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_int32");
                        this.vm.mov(VReg.A2, VReg.RET);
                        this.vm.pop(VReg.A1);
                    } else {
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.movImm(VReg.A2, 0);
                    }
                } else {
                    this.vm.lea(VReg.A1, "_str_empty");
                    this.vm.movImm(VReg.A2, 0);
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_indexOf");
                // 装箱返回值为 Number 对象
                this.boxIntAsNumber(VReg.RET);
                return true;

            case "lastIndexOf":
                // str.lastIndexOf(search) - 返回最后出现的索引或 -1。
                // 活跃 compileStringMethod 原缺此 case → 返 false → dispatch 落通用对象
                // 方法 _object_get("lastIndexOf") on string → 不可调用 → TypeError/崩。
                // 镜像 indexOf 调正确的 _str_lastIndexOf 运行时（本体字节正确，只是从没被 call）。
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_getStrContent");
                    this.vm.mov(VReg.A1, VReg.RET);
                    if (args.length > 1) {
                        // fromIndex:存 search content,编译第二参转裸 int32 入 A2
                        this.vm.push(VReg.A1);
                        this.compileExpression(args[1]);
                        if (this.vm.backend.name === "x64") this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_to_int32");
                        this.vm.mov(VReg.A2, VReg.RET);
                        this.vm.pop(VReg.A1);
                    } else {
                        this.vm.movImm(VReg.A2, 0x7FFFFFFF); // 哨兵:不钳(搜到末尾)
                    }
                } else {
                    this.vm.lea(VReg.A1, "_str_empty");
                    this.vm.movImm(VReg.A2, 0x7FFFFFFF);
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_lastIndexOf");
                this.boxIntAsNumber(VReg.RET);
                return true;

            case "concat":
                // str.concat(a, b, c, ...) - 逐参串接(此前只用 args[0],丢弃其余 → "a".concat("b","c")="ab")
                this.vm.pop(VReg.A0); // A0 = 接收者(装箱串)
                if (args.length === 0) {
                    this.vm.mov(VReg.RET, VReg.A0); // 无参:返回原串
                    return true;
                }
                for (let ci = 0; ci < args.length; ci++) {
                    this.vm.push(VReg.A0);             // 保存累加器(compileExpression 会破坏 A 寄存器)
                    this.compileExpression(args[ci]);  // RET = 本参(装箱串)
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.pop(VReg.A0);              // 恢复累加器
                    this.vm.call("_strconcat");        // RET = A0 + A1
                    this.vm.mov(VReg.A0, VReg.RET);   // 累加器 = 结果
                }
                this.vm.mov(VReg.RET, VReg.A0);
                return true;

            case "includes":
                // str.includes(search[, pos]) - 返回布尔值
                if (args.length >= 2) {
                    // 带 position:receiver.substring(pos) 取尾串再 includes(尾串, search)。
                    // 镜像 startsWith(pos) 修法,复用 _str_substring,不碰热路径。此前忽略 pos。
                    const incSearch = this.ctx.allocLocal(`__inc_search_${this.nextLabelId()}`);
                    this.compileExpression(args[0]);          // search
                    this.vm.store(VReg.FP, incSearch, VReg.RET);
                    this.compileExpression(args[1]);          // pos
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.pop(VReg.A0);                      // receiver
                    this.vm.movImm64(VReg.A2, 0x7ffb000000000000n); // undefined → 到尾
                    this.vm.call("_str_substring");           // RET = 尾串
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, incSearch);
                    this.vm.call("_str_includes");
                    return true;
                }
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.lea(VReg.A1, "_str_empty");
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_includes");
                return true;

            case "startsWith":
                // str.startsWith(search[, pos]) - 返回布尔值
                if (args.length >= 2) {
                    // 带 position:receiver.substring(pos) 取尾串,再 startsWith(tail, search)。
                    // 复用测试过的 _str_substring/_str_startsWith,不碰其热路径。此前忽略 pos。
                    // 求值序 search→pos(ES 左到右)。
                    const swSearch = this.ctx.allocLocal(`__sw_search_${this.nextLabelId()}`);
                    this.compileExpression(args[0]);          // search
                    this.vm.store(VReg.FP, swSearch, VReg.RET);
                    this.compileExpression(args[1]);          // pos(boxed number)
                    this.vm.mov(VReg.A1, VReg.RET);
                    this.vm.pop(VReg.A0);                      // receiver(boxed str)
                    this.vm.movImm64(VReg.A2, 0x7ffb000000000000n); // undefined → 到尾
                    this.vm.call("_str_substring");           // RET = tail
                    this.vm.mov(VReg.A0, VReg.RET);           // A0 = tail
                    this.vm.load(VReg.A1, VReg.FP, swSearch);  // A1 = search
                    this.vm.call("_str_startsWith");
                    return true;
                }
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.lea(VReg.A1, "_str_empty");
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_startsWith");
                return true;

            case "endsWith":
                // str.endsWith(search[, endPos]) - 返回布尔值
                if (args.length >= 2) {
                    // 带 endPosition:receiver.substring(0, endPos) 取前缀再 endsWith(前缀, search)。
                    // 复用 _str_substring,不碰热路径。此前忽略 endPos。求值序 search→endPos。
                    const ewSearch = this.ctx.allocLocal(`__ew_search_${this.nextLabelId()}`);
                    this.compileExpression(args[0]);          // search
                    this.vm.store(VReg.FP, ewSearch, VReg.RET);
                    this.compileExpression(args[1]);          // endPos
                    this.vm.mov(VReg.A2, VReg.RET);           // end = endPos
                    this.vm.pop(VReg.A0);                      // receiver
                    this.vm.movImm64(VReg.A1, 0x7FF8000000000000n); // start = 0(boxed)
                    this.vm.call("_str_substring");           // RET = 前缀 [0,endPos)
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.load(VReg.A1, VReg.FP, ewSearch);
                    this.vm.call("_str_endsWith");
                    return true;
                }
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.lea(VReg.A1, "_str_empty");
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_endsWith");
                return true;

            case "repeat":
                // str.repeat(count) - 重复字符串
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    // 索引是浮点数表示，转为整数
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm(VReg.A1, 0);
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_repeat");
                return true;

            case "padStart":
                // str.padStart(targetLen, padString)
                if (args.length >= 2) {
                    this.compileExpression(args[0]);
                    // targetLen 需要转换为整数
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.push(VReg.RET);
                    this.compileExpression(args[1]);
                    this.vm.mov(VReg.A2, VReg.RET);
                    this.vm.pop(VReg.A1);
                    this.vm.pop(VReg.A0);
                    this.vm.call("_str_padStart");
                } else if (args.length === 1) {
                    this.compileExpression(args[0]);
                    // targetLen 需要转换为整数
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.mov(VReg.A1, VReg.RET);
                    // 默认填充串为一个空格(装箱 0x7FFC 串,同 2 参路径;此前 lea 未定义
                    // 标签 `_str_space` → 链接错误 `Unknown label`,单参 padStart/padEnd 全崩)。
                    this.vm.lea(VReg.A2, this.asm.addString(" "));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.A2, VReg.A2, VReg.V1);
                    this.vm.pop(VReg.A0);
                    this.vm.call("_str_padStart");
                } else {
                    this.vm.pop(VReg.RET);
                }
                return true;

            case "padEnd":
                // str.padEnd(targetLen, padString)
                if (args.length >= 2) {
                    this.compileExpression(args[0]);
                    // targetLen 需要转换为整数
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.push(VReg.RET);
                    this.compileExpression(args[1]);
                    this.vm.mov(VReg.A2, VReg.RET);
                    this.vm.pop(VReg.A1);
                    this.vm.pop(VReg.A0);
                    this.vm.call("_str_padEnd");
                } else if (args.length === 1) {
                    this.compileExpression(args[0]);
                    // targetLen 需要转换为整数
                    this.vm.fmovToFloat(0, VReg.RET);
                    this.vm.fcvtzs(VReg.RET, 0);
                    this.vm.mov(VReg.A1, VReg.RET);
                    // 默认填充串为一个空格(装箱 0x7FFC 串,同 2 参路径;此前 lea 未定义
                    // 标签 `_str_space` → 链接错误 `Unknown label`,单参 padStart/padEnd 全崩)。
                    this.vm.lea(VReg.A2, this.asm.addString(" "));
                    this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                    this.vm.or(VReg.A2, VReg.A2, VReg.V1);
                    this.vm.pop(VReg.A0);
                    this.vm.call("_str_padEnd");
                } else {
                    this.vm.pop(VReg.RET);
                }
                return true;

            case "split":
                // str.split() —— 无分隔符(或 undefined):返回 [str](整串单元素),
                // **非**逐字符切(那是 split("") 的语义)。此前无参落 _str_empty → 误逐字符切。
                if (args.length === 0) {
                    const s0id = this.nextLabelId();
                    const s0str = this.ctx.allocLocal(`__split0_str_${s0id}`);
                    const s0arr = this.ctx.allocLocal(`__split0_arr_${s0id}`);
                    this.vm.pop(VReg.RET);                 // 接收者(装箱串)
                    this.vm.store(VReg.FP, s0str, VReg.RET);
                    this.vm.movImm(VReg.A0, 1);
                    this.vm.call("_array_new_with_size");  // RET = 裸数组头(len=1)
                    this.vm.store(VReg.FP, s0arr, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, s0arr); // 裸头
                    this.vm.movImm(VReg.A1, 0);
                    this.vm.load(VReg.A2, VReg.FP, s0str);
                    this.vm.call("_array_set");
                    this.vm.load(VReg.RET, VReg.FP, s0arr);
                    this.vm.call("_box_arr_r"); // box->helper
                    return true;
                }
                // str.split(separator[, limit]) - 返回数组
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.lea(VReg.A1, "_str_empty");
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_split"); // RET = boxed 数组
                if (args.length >= 2) {
                    // [limit] 截断到 limit 个元素:_array_slice(unbox, 0, limit) 再装箱。
                    // limit>len 自然不截、limit=0 得空数组。此前忽略 limit(记偏差已消)。
                    const splitResSlot = this.ctx.allocLocal(`__splitres_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, splitResSlot, VReg.RET);
                    this.compileExpressionAsInt(args[1]);
                    const splitLimSlot = this.ctx.allocLocal(`__splitlim_${this.nextLabelId()}`);
                    this.vm.store(VReg.FP, splitLimSlot, VReg.RET);
                    this.vm.load(VReg.A0, VReg.FP, splitResSlot);
                    this.vm.call("_js_unbox");
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.movImm(VReg.A1, 0);
                    this.vm.load(VReg.A2, VReg.FP, splitLimSlot);
                    this.vm.call("_array_slice");
                    this.vm.call("_box_arr_r"); // box->helper
                }
                return true;

            case "trimStart":
            case "trimLeft":
                // str.trimStart()
                this.vm.pop(VReg.A0);
                this.vm.call("_str_trimStart");
                return true;

            case "trimEnd":
            case "trimRight":
                // str.trimEnd()
                this.vm.pop(VReg.A0);
                this.vm.call("_str_trimEnd");
                return true;

            case "normalize":
                // str.normalize([form]):asm.js 字节模型下 ASCII/已规范化即恒等,返回原串。
                // 此前未实现 → 通用派发崩。偏差:不做真 NFC/NFD 组合字重排(纯文本正确)。
                this.vm.pop(VReg.A0);
                this.vm.mov(VReg.RET, VReg.A0);
                return true;

            case "localeCompare":
                // str.localeCompare(other):asm.js 无 ICU,退化为逐字节(码点)比较返回 -1/0/1。
                // 此前未实现 → 通用派发崩。偏差:不做 locale 敏感排序/重音折叠(ASCII/普通文本对齐 node)。
                if (args.length > 0) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET);
                } else {
                    this.vm.movImm64(VReg.A1, 0x7ffb000000000000n); // undefined
                }
                this.vm.pop(VReg.A0);
                this.vm.call("_str_localeCompare");
                return true;
        }

        // 未处理的方法，弹出栈
        this.vm.pop(VReg.V0);
        return false;
    },
};
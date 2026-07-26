// asm.js 编译器 - 成员访问编译
// 编译对象属性、数组索引访问

import { VReg } from "../../vm/index.js";

// [Stage A 内置方法引用] 方法名 → 运行时 helper 标签。作**值读取**(非调用)时把
// `arr.<m>`/`str.<m>` 解析为经 _aref_generic 蹦床调该 helper 的函数值。首批仅收 helper
// 型且**忽略多余实参**的方法(蹦床把接收者插到 A0、用户实参上移一位,不处理可选参默认;
// 需默认值的 slice/indexOf/join 等待后续按方法定制 helper 批次)。方法调用仍走静态派发。
const ArefMethodRef = {
    // 直连 helper 型:helper 自身正确处理装箱实参/undefined 缺参,generic 蹦床可直接透传。
    // 需**裸 int** 下标/fromIndex 的方法(indexOf/charAt/at/array slice/lastIndexOf 等)不在此
    // (蹦床传装箱值 → helper 读裸 int 得垃圾),待 Batch 2b 经定制 wrapper helper 转换后接入。
    array: {
        push: "_array_push",
        pop: "_array_pop",
        reverse: "_array_reverse",
        // Batch 2b:经 wrapper 把装箱下标/fromIndex 转裸 int(缺省 0)
        at: "_aref_arr_at",
        indexOf: "_aref_arr_indexOf",
        slice: "_aref_arr_slice", // Batch 2c:start 缺省 0、end 缺省 INT_MAX
        // Batch 3:回调型(运行时驱动回调)
        forEach: "_array_forEach_rt",
        map: "_array_map_rt",
        filter: "_array_filter_rt",
        some: "_array_some_rt",
        every: "_array_every_rt",
        reduce: "_array_reduce_rt",
        reduceRight: "_array_reduceRight_rt",
    },
    string: {
        toUpperCase: "_str_toUpperCase",
        toLowerCase: "_str_toLowerCase",
        trim: "_str_trim",
        slice: "_str_slice",
        substring: "_str_substring",
        at: "_str_at",
        includes: "_str_includes",
        charCodeAt: "_str_charCodeAt", // Batch 2c:自归一化下标+装箱结果,直连
        // Batch 2b:经 wrapper 转裸 int 下标/fromIndex
        charAt: "_aref_str_charAt",
        indexOf: "_aref_str_indexOf",
    },
};

// [构造器全局值] TypedArray 族 + ArrayBuffer 标识符 → 闭包 type 码(0x70 = ArrayBuffer 伪类型)。
// 编译期物化为 24B 闭包(magic/fnptr=_ta_ctor_tramp/type@16),`new TA(...)` 值路径与
// `.prototype` 静态读由此驱动(test262 TA include 依赖 ArrayBuffer.prototype 特性探测)。
const TA_CTOR_TAGS = {
    Int8Array: 0x40, Int16Array: 0x41, Int32Array: 0x42, BigInt64Array: 0x43,
    Uint8Array: 0x50, Uint16Array: 0x51, Uint32Array: 0x52, BigUint64Array: 0x53,
    Uint8ClampedArray: 0x54, Float32Array: 0x60, Float64Array: 0x61,
    ArrayBuffer: 0x70,
};

// [内建静态一等值] 命名空间静态方法作**值读取**(非调用)时包成闭包(emitBuiltinFnClosure
// 直连 helper,无接收者绑定)并按 builtin memoize(emitMemoizedBuiltinRef)。调用仍走
// compileCallExpression 的静态派发(compileMathMethod 等),不经此表 → 调用字节不变。
// 收录条件:helper 以 A0(canonical 值)收首参、返 canonical 值——Math 直连族
// (floor/ceil/trunc/round/abs 站点即此约定);sqrt/三角族站点先 coerce 后 NaN 归一,
// 但 canonical 数值参下 coerce 是恒等、NaN 归一仅打印修饰,直连近似可接受(记偏差:
// 经引用调用得 NaN 时打印位形可能异于直调;boxed-int 边角由 helper 自身容忍)。
// 多参/内联折叠者(min/max/pow/atan2/hypot/imul/random)不收(无单 helper 或需 argc)。
const NamespaceStaticRef = {
    Math: {
        floor: "_math_floor",
        ceil: "_math_ceil",
        trunc: "_math_trunc",
        round: "_math_round",
        abs: "_math_abs",
        sqrt: "_math_sqrt",
        cbrt: "_math_cbrt",
        log: "_math_log",
        log2: "_math_log2",
        log10: "_math_log10",
        log1p: "_math_log1p",
        exp: "_math_exp",
        expm1: "_math_expm1",
        sin: "_math_sin",
        cos: "_math_cos",
        tan: "_math_tan",
        asin: "_math_asin",
        acos: "_math_acos",
        atan: "_math_atan",
        sinh: "_math_sinh",
        cosh: "_math_cosh",
        tanh: "_math_tanh",
        asinh: "_math_asinh",
        acosh: "_math_acosh",
        atanh: "_math_atanh",
        fround: "_math_fround",
        clz32: "_math_clz32",
    },
    Object: {
        // 直连 helper(A0=boxed obj → RET=boxed array):调用位同约定(functions.js)。
        keys: "_object_keys",
        values: "_object_values",
        entries: "_object_entries",
        getOwnPropertyNames: "_object_gopn", // 对象路径委托 _object_keys;array/string 额外含 "length"
    },
    Date: {
        now: "_date_now", // 0 参 → canonical number
    },
    Array: {
        isArray: "_isarray_ref", // wrapper:A1=1(Array 标识)后尾跳 _instanceof
    },
};

// 成员访问编译方法混入
export const MemberCompiler = {
    // 私有名改写：#x -> "#ClassName#x"。# 不是合法标识符字符，用户属性键永远撞不上；
    // ClassName 前缀保证跨类同名 #x 互不可见（含继承：子类访问父类 #x 天然不可见）。
    // 运行时不做 brand check（偏差：错误类实例访问得 undefined 而非 TypeError）。
    manglePrivateName(name) {
        const cls = (this.ctx && this.ctx.className) ? this.ctx.className : "";
        return "#" + cls + name;
    },

    getMemberPropertyName(property) {
        if (!property) return null;
        // 可选链私有访问 `o?.#x`:解析器把属性建成普通 Identifier{name:"#x"}(非
        // PrivateIdentifier),若原样返回 "#x" 则读未改写键 → 查不到 → undefined。名以
        // "#" 起头即私有,统一按 manglePrivateName 改写为 "#ClassName#x"。
        if (property.type === "Identifier") {
            return property.name && property.name[0] === "#"
                ? this.manglePrivateName(property.name)
                : property.name;
        }
        if (property.type === "PrivateIdentifier") return this.manglePrivateName(property.name);
        // 仅字符串字面量算属性名；数字字面量是数组下标，必须走 subscript 路径
        if ((property.type === "Literal" || property.type === "StringLiteral") &&
            typeof property.value === "string") return String(property.value);
        // well-known Symbol 计算键归一为静态字符串键 "Symbol.xxx"(存/读一致):
        // 运行时创建的 async generator 把 Symbol.asyncIterator 存字符串键 "Symbol.asyncIterator",
        // for await 的 RIGHT[Symbol.asyncIterator] 计算读需同键才命中(否则走动态 _js_prop_key
        // 符号键 → 查不到 async-gen 的迭代器 → 空迭代)。iterator 行为不变。
        if (property.type === "MemberExpression" &&
            property.object && property.object.type === "Identifier" && property.object.name === "Symbol" &&
            property.property && property.property.type === "Identifier" &&
            (property.property.name === "iterator" || property.property.name === "asyncIterator")) {
            return "Symbol." + property.property.name;
        }
        return null;
    },

    emitBoxedStringKey(name, destReg = VReg.A1) {
        const propLabel = this.asm.addString(name);
        this.vm.lea(destReg, propLabel);
        // A1 目标(绝大多数键装箱站点)走共享 helper,单 bl 取代 movImm64+or(省 ~8B/站点)。
        // _tag_key_a1 clobber(V1+LR)与本内联(V1)一致的子集,语义等价。其它目标寄存器
        // (A0/A2 等少数站点)保留内联。
        if (destReg === VReg.A1) {
            this.vm.call("_tag_key_a1");
            return;
        }
        this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        this.vm.or(destReg, destReg, VReg.V1);
    },

    // [P2/A2] 属性读站点缓存(融合 getter)。前置:RET = 已求值的 boxed 对象。
    // 发射后:RET = 属性值(getter 已解)。站点只发一个 call(_object_get_ic
    // = _object_get + _maybe_getter 融合),比旧形态(push/双 call/pop)更少的
    // op 与字节;站点数据段 16B 槽 {cached_shape@0, cached_index@8}:形状模式
    // (形状相等 ⟹ 键序相等,省 count/props 防御)与无形状 legacy 模式(缓存下标
    // + 键自验证)双模,慢路回填两字段——永不需失效。
    // (首版逐站点内联快路实测:产物 +54%、发射成本 +3.4s,已回退为出线式。)
    // NO_IC=1 编译时禁用(对拍口;env 仅 node 驱动构建可见,编译产物内恒空)。
    emitObjectGetIC(propName) {
        const vm = this.vm;
        // engineNoIC:route B 片段编译时置位。IC 站点回填(_object_get_ic 慢路
        // store 站点槽)会写只读 RX 片段页 → SIGBUS,故片段走无站点写回形态。
        // (process.env 在编译产物内恒空,故不能仅靠 NO_IC;用编译器实例标志。)
        if (process.env.NO_IC || this.engineNoIC) {
            vm.push(VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            this.emitBoxedStringKey(propName, VReg.A1);
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.pop(VReg.A1);
            vm.call("_maybe_getter");
            return;
        }
        const siteLabel = this.ctx.newLabel("icg_site");
        // [A3.5] 站点槽 24B:{obj_shape=0(legacy 模式), holder=0(占位),
        // index=大于任何 count 的初值} → 首次必落慢路回填
        this.asm.addDataLabel(siteLabel);
        this.asm.addDataQword(0);
        this.asm.addDataQword(0);
        this.asm.addDataQword(0x7fffffff);
        vm.mov(VReg.A0, VReg.RET);
        this.emitBoxedStringKey(propName, VReg.A1);
        vm.lea(VReg.A2, siteLabel);
        vm.call("_object_get_ic");
    },

    // [P2] 属性写站点缓存。前置:A0 = boxed obj、A2 = value 已就位。
    // 发射 key→A1、site→A3、call _object_set_ic(语义 = _object_set,含写屏障)。
    // 注意顺序:emitBoxedStringKey 写 V1(x64 上 V1=RCX=A3),site 必须最后 lea。
    emitObjectSetIC(propName) {
        const vm = this.vm;
        // engineNoIC:route B 片段——IC 站点回填写只读 RX 片段页 → SIGBUS,故走无站点
        // 写回的 _object_set(语义等价,含写屏障),与 emitObjectGetIC 读路径对称。
        if (process.env.NO_IC || this.engineNoIC) {
            this.emitBoxedStringKey(propName, VReg.A1);
            vm.call("_object_set");
            return;
        }
        const siteLabel = this.ctx.newLabel("ics_site");
        // [A3] 站点槽 16B:{cached_shape=0(legacy 模式), cached_index=大于任何
        // count 的初值} → 首次必落慢路回填
        this.asm.addDataLabel(siteLabel);
        this.asm.addDataQword(0);
        this.asm.addDataQword(0x7fffffff);
        this.emitBoxedStringKey(propName, VReg.A1);
        vm.lea(VReg.A3, siteLabel);
        vm.call("_object_set_ic");
    },

    // [内建静态一等值] memoized 内建函数引用:惰性全局槽 _builtinref_<key>(GC 根,
    // _funcclosure_ 模式)缓存 emitBuiltinFnClosure 产的闭包 → `Math.floor === Math.floor`
    // 为 true 且每 builtin 仅建一次。首次执行建闭包存槽,后续直接读。
    emitMemoizedBuiltinRef(slotKey, runtimeLabel) {
        const label = "_builtinref_" + slotKey;
        if (!this._addedBuiltinRefLabels) this._addedBuiltinRefLabels = new Set();
        if (!this._addedBuiltinRefLabels.has(label)) {
            this.asm.addDataLabel(label);
            this.asm.addDataQword(0);
            this._addedBuiltinRefLabels.add(label);
        }
        const doneL = this.ctx.newLabel("bref_done");
        this.vm.lea(VReg.V0, label);
        this.vm.load(VReg.RET, VReg.V0, 0);
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(doneL);
        this.emitBuiltinFnClosure(runtimeLabel); // RET = 装箱闭包
        this.vm.lea(VReg.V0, label);
        this.vm.store(VReg.V0, 0, VReg.RET);
        this.vm.label(doneL);
    },

    // 生成一个指向运行时函数的闭包对象（供内置函数作为一等值传递）
    emitBuiltinFnClosure(runtimeLabel) {
        this.vm.movImm(VReg.A0, 16);
        this.vm.call("_alloc");
        this.vm.mov(VReg.S0, VReg.RET);
        this.vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        this.vm.store(VReg.S0, 0, VReg.V1);
        this.vm.lea(VReg.V1, runtimeLabel);
        this.vm.store(VReg.S0, 8, VReg.V1);
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.call("_js_box_function");
    },

    // [构造器全局值] TA 族/ArrayBuffer 构造器闭包(memoized,_taref_<name>):
    // 24B {magic@0, fnptr@8=_ta_ctor_tramp, type@16}。memoize 保证 `Int8Array === Int8Array`
    // 且每构造器仅建一次。type@16 由蹦床读取(见 runtime generateCtorSupport)。
    emitCtorClosureRef(slotKey, typeTag) {
        const label = "_taref_" + slotKey;
        if (!this._addedTaRefLabels) this._addedTaRefLabels = new Set();
        if (!this._addedTaRefLabels.has(label)) {
            this.asm.addDataLabel(label);
            this.asm.addDataQword(0);
            this._addedTaRefLabels.add(label);
        }
        const doneL = this.ctx.newLabel("taref_done");
        this.vm.lea(VReg.V0, label);
        this.vm.load(VReg.RET, VReg.V0, 0);
        this.vm.cmpImm(VReg.RET, 0);
        this.vm.jne(doneL);
        this.vm.movImm(VReg.A0, 24);
        this.vm.call("_alloc");
        this.vm.mov(VReg.S0, VReg.RET);
        this.vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        this.vm.store(VReg.S0, 0, VReg.V1);
        this.vm.lea(VReg.V1, "_ta_ctor_tramp");
        this.vm.store(VReg.S0, 8, VReg.V1);
        this.vm.movImm(VReg.V1, typeTag);
        this.vm.store(VReg.S0, 16, VReg.V1);
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.call("_js_box_function");
        this.vm.lea(VReg.V0, label);
        this.vm.store(VReg.V0, 0, VReg.RET);
        this.vm.label(doneL);
    },

    // [Stage A] 内置方法引用闭包:{magic@0=0xc105, fnptr@8=_aref_generic, helper@16=<helper 标签>}。
    // 供 `const f=arr.push`/`typeof [].map`/`arr.map.call(recv,cb)` 等把内置方法当一等值。
    // 蹦床 _aref_generic 从 @16 取 helper、把接收者(this,A5)插到 A0 后尾调,故不绑定接收者。
    emitBuiltinMethodRefClosure(helperLabel) {
        this.vm.movImm(VReg.A0, 24);
        this.vm.call("_alloc");
        this.vm.mov(VReg.S0, VReg.RET);
        this.vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        this.vm.store(VReg.S0, 0, VReg.V1);
        this.vm.lea(VReg.V1, "_aref_generic");
        this.vm.store(VReg.S0, 8, VReg.V1);
        this.vm.lea(VReg.V1, helperLabel);
        this.vm.store(VReg.S0, 16, VReg.V1);
        this.vm.mov(VReg.A0, VReg.S0);
        this.vm.call("_js_box_function");
    },

    // 编译 this 表达式
    compileThisExpression(expr) {
        // this 存储在 __this 局部变量中
        const offset = this.ctx.getLocal("__this");
        if (offset) {
            this.vm.load(VReg.RET, VReg.FP, offset);
        } else {
            // 如果没有 __this，返回 undefined (0)
            this.vm.movImm(VReg.RET, 0);
        }
    },

    // 编译标识符
    // with(obj) 标识符解析:自内向外逐个 with 对象查 [[HasProperty]](本切片用自有属性
    // _object_has);命中则 RET = obj[name],否则回退普通词法解析。
    _compileWithIdentifier(expr) {
        const name = expr.name;
        const doneL = this.ctx.newLabel("with_done");
        for (let i = this.ctx.withScopes.length - 1; i >= 0; i--) {
            const missL = this.ctx.newLabel("with_miss");
            const slot = this.ctx.withScopes[i];
            this.vm.load(VReg.A0, VReg.FP, slot);
            this.emitBoxedStringKey(name, VReg.A1);
            this.vm.call("_object_has"); // 裸 0/1
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(missL);
            this.vm.load(VReg.A0, VReg.FP, slot);
            this.emitBoxedStringKey(name, VReg.A1);
            this.vm.call("_object_get"); // RET = obj[name]
            this.vm.jmp(doneL);
            this.vm.label(missL);
        }
        // 全 miss → 普通词法解析(标志防重入 with 分支)
        this._inWithResolve = true;
        this.compileIdentifier(expr);
        this._inWithResolve = false;
        this.vm.label(doneL);
    },

    compileIdentifier(expr) {
        const name = expr.name;

        // 特殊值：this —— 模板字面量插值 `${this.x}` 的解析器把 this 解析成
        // Identifier("this") 而非 ThisExpression，导致按普通变量查找失败 → this=NULL
        // → this.x 读 0、this.x++ 野写 _object_set(NULL)。this 是保留字，Identifier
        // "this" 必是 this 表达式，统一按 this 处理。
        if (name === "this") {
            this.compileThisExpression(expr);
            return;
        }

        // with(obj) 作用域链注入:body 内标识符先查 with 对象属性(有则用,无则回退词法)。
        // 仅当存在活跃 with 作用域时进入(编译器不用 with → 无 with 代码逐字节不变)。
        // _inWithResolve 标志防止 miss 回退时无限递归(回退走普通解析,跳过本分支)。
        if (this.ctx.withScopes && this.ctx.withScopes.length > 0 && !this._inWithResolve) {
            this._compileWithIdentifier(expr);
            return;
        }

        // 特殊值：undefined
        if (name === "undefined") {
            // 加载预定义的 undefined 常量值
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            return;
        }

        // 特殊值：null —— 发 tagged null(_js_null=0x7FFA),与 NullLiteral 路径一致。
        // [2026-07-14] 此前发**裸 0**,令 null 与数值 0.0(位同为裸 0)运行时不可分辨,
        // 逼得 `??`/`??=` 用 `cmpImm(RET,0)` 兜底 null → 误把 `0 ?? x`(尤其参数/未知
        // 类型的数值 0)判成 nullish。改 tagged 后 null 恒 0x7FFA,数值 0 不再被误判。
        if (name === "null") {
            this.vm.movImm64(VReg.RET, 0x7ffa000000000000n); // was lea+load _js const
            return;
        }

        // 特殊值：NaN (Not-a-Number)
        // NaN 标识符:发真 IEEE NaN 位。不能用规范 NaN 0x7FF8000000000000——high16
        // =0x7FF8 与 NaN-boxing 的 int32 tag(0)冲突,会被打印/分派当作装箱 int 0
        // (打印成 "0")。改用 signaling-NaN 位 0x7FF0000000000001:high16=0x7FF0
        // < 0x7FF8 → 走 raw-float 路径,_floatToString 检出 NaN → 打印 "NaN";
        // fcmp 对它 unordered → Math.max/min NaN 传播、比较语义天然正确(#44 同款
        // Infinity 修法的姊妹修复;此前发 0 → `Math.max(1,NaN,3)` 误得 3)。
        if (name === "NaN") {
            this.vm.movImm64(VReg.RET, 0x7FF0000000000001n);
            return;
        }

        // 特殊值：Infinity
        // [#44] 原发射为 0:`x === Infinity` 对零值恒真、`n < Infinity` 恒假、
        // `Infinity > 1e308` 为假——JSON 把零值属性打成 null 亦源于此。改发真
        // +Inf 位(0x7FF0<<48,raw float):比较/算术/coerce 天然正确;-Infinity
        // 经一元负浮点路径得 0xFFF0<<48。(console.log 名字有字符串特例不经此。)
        if (name === "Infinity") {
            this.vm.movImm64(VReg.RET, 0x7ff0000000000000n);
            return;
        }

        // 检查是否是内置构造函数（用于 instanceof）
        if (name === "Array") {
            this.vm.movImm(VReg.RET, 1); // Array 构造函数标识 = 1
            return;
        }
        if (name === "Object") {
            this.vm.movImm(VReg.RET, 2); // Object 构造函数标识 = 2
            return;
        }
        // [bug8] 裸 Function 构造器哨兵 = 3(用于 `x instanceof Function`)。
        // `new Function(...)` 在 NewExpression 里已单独改派 __makeFunction,不经此。
        if (name === "Function" && !(this.ctx.getLocal && this.ctx.getLocal("Function")) &&
            !(this.ctx.getFunction && this.ctx.getFunction("Function"))) {
            this.vm.movImm(VReg.RET, 3);
            return;
        }
        // 裸全局 process：返回 _process_global（装箱为对象）
        // 编译器源码大量用裸 process.cwd()/process.platform 而不 import
        if (name === "process") {
            this.vm.lea(VReg.V0, "_process_global");
            this.vm.load(VReg.RET, VReg.V0, 0); // 裸对象指针
            // 装箱为 JS 对象 0x7FFD（否则 typeof/成员访问失败）
            this.vm.call("_box_obj_r"); // box->helper
            return;
        }
        // 裸全局 globalThis：返回 _global_this（运行时在 _process_init 创建），装箱为对象
        if (name === "globalThis") {
            this.vm.lea(VReg.V0, "_global_this");
            this.vm.load(VReg.RET, VReg.V0, 0); // 裸对象指针
            this.vm.call("_box_obj_r"); // box->helper
            return;
        }
        if (name === "Boolean") { this.emitBuiltinFnClosure("_builtin_boolean"); return; }
        if (name === "Number") { this.emitBuiltinFnClosure("_builtin_number"); return; }
        if (name === "String") { this.emitBuiltinFnClosure("_builtin_string"); return; }
        // Symbol 一等值(批次D):typeof Symbol === "function"、可传递后调用
        if (name === "Symbol") { this.emitBuiltinFnClosure("_symbol_new"); return; }
        if (name === "JSON") {
            this.vm.call("_object_new");
            this.vm.call("_box_obj_r"); // box->helper
            return;
        }
        // [构造器全局值] TypedArray 族/ArrayBuffer → 24B 闭包(memoized),`new TA(...)`
        // 值路径(经 _ta_construct→_ta_ctor_tramp)与 typeof X === "function" 由此成立。
        // 直接 `new Int8Array(...)` 仍走 compileNewExpression 静态特判(字节不变);遮蔽守卫同 Function。
        if (TA_CTOR_TAGS[name] !== undefined &&
            !(this.ctx.getLocal && this.ctx.getLocal(name)) &&
            !(this.ctx.getFunction && this.ctx.getFunction(name))) {
            this.emitCtorClosureRef(name, TA_CTOR_TAGS[name]);
            return;
        }

        const offset = this.ctx.getLocal(name);
        const globalLabel = this.ctx.getMainCapturedVar(name);
        const hasFunc = this.ctx.hasFunction(name);
        if (offset) {
            // [解箱① P4.1] 浮点累加器驻留 FP 寄存器:值在 d_reg,直接 fmov 取 float64 位
            const fpReg = this.ctx.getFpAccum(name);
            if (fpReg > 0) {
                this.vm.fmovToInt(VReg.RET, fpReg);
                return;
            }
            // 检查是否是装箱变量
            const isBoxed = this.ctx.boxedVars && this.ctx.boxedVars.has(name);
            if (isBoxed) {
                // 装箱变量：先加载 box 指针，再解引用获取值
                this.vm.load(VReg.RET, VReg.FP, offset); // 加载 box 指针
                // [批次D TDZ] 词法先于声明的读:声明前槽里是 SENTINEL(块入口写入,
                // box 尚未创建),必须在解引用前守卫,否则 deref SENTINEL 直接崩
                if (expr._tdz) this.emitUninitializedBindingGuard(name, VReg.RET);
                this.vm.load(VReg.RET, VReg.RET, 0); // 解引用获取值
                this.emitUninitializedBindingGuard(name, VReg.RET);
            } else {
                this.vm.load(VReg.RET, VReg.FP, offset);
                // [批次D TDZ] 仅 blockscope.js 标记的先读后声明点发守卫,正常读零税
                if (expr._tdz) this.emitUninitializedBindingGuard(name, VReg.RET);
                // [解箱①] 裸 int 驻留变量在通用 JSValue 上下文(console.log/return/传参/
                // 下标/比较)读出:slot 是裸 int,物化为 float64 位模式的 JS Number。
                // 整数/浮点操作数路径已在各自入口提前裸 load 返回,不经此。
                if (this.ctx.isRawIntVar(name)) this.intToFloat64Bits(VReg.RET);
            }
        } else {
            // 检查是否是主程序被捕获的变量（从全局位置访问）
            if (globalLabel) {
                // 从全局位置加载 box 指针
                this.vm.lea(VReg.RET, globalLabel);
                this.vm.load(VReg.RET, VReg.RET, 0); // 加载 box 指针
                this.vm.load(VReg.RET, VReg.RET, 0); // 解引用获取值
                this.emitUninitializedBindingGuard(name, VReg.RET);
            } else if (this.ctx.hasFunction(name)) {
                // 顶层类：从 _classinfo_<symbol> 全局槽读取类信息对象
                // （闭包 stub 是空实现，静态成员/prototype 都在类信息对象上）
                const declNode = this.ctx.getFunction ? this.ctx.getFunction(name) : null;
                if (declNode && declNode.type === "ClassDeclaration") {
                    const classSymbol = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(name)) || name;
                    this.vm.lea(VReg.RET, `_classinfo_${classSymbol}`);
                    this.vm.load(VReg.RET, VReg.RET, 0);
                    return;
                }
                const funcLabel = this.getFunctionLabel(name);
                if (funcLabel) {
                    // 函数声明作值:memoize 到全局槽 _funcclosure_<symbol> → 稳定身份(`f===f`
                    // 为 true),使闭包属性侧表(按裸指针键)对声明函数生效。首次建闭包 {magic,
                    // funcLabel} + 装箱存槽,后续引用复用同一装箱值。槽是 GC 根 → 闭包常驻。
                    const fcSymbol = (this.ctx.getFunctionSymbol && this.ctx.getFunctionSymbol(name)) || name;
                    const slotLabel = this.ensureFuncClosureSlot(fcSymbol);
                    const haveLabel = this.ctx.newLabel("funccl_have");
                    this.vm.lea(VReg.V0, slotLabel);
                    this.vm.load(VReg.RET, VReg.V0, 0); // 已 memoized 的装箱值(0=未建)
                    this.vm.cmpImm(VReg.RET, 0);
                    this.vm.jne(haveLabel);
                    // 首建
                    this.vm.movImm(VReg.A0, 16);
                    this.vm.call("_alloc");
                    this.vm.mov(VReg.S0, VReg.RET);
                    this.vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
                    this.vm.store(VReg.S0, 0, VReg.V1);
                    this.vm.lea(VReg.V1, funcLabel);
                    this.vm.store(VReg.S0, 8, VReg.V1);
                    this.vm.mov(VReg.A0, VReg.S0);
                    this.vm.call("_js_box_function"); // RET = 装箱
                    this.vm.lea(VReg.V0, slotLabel);
                    this.vm.store(VReg.V0, 0, VReg.RET); // memoize
                    this.vm.label(haveLabel);
                    // RET = memoized 装箱函数
                } else {
                    // 函数标签不存在，返回 undefined
                    this.vm.movImm(VReg.RET, 0);
                }
            } else if (this.getImportBindingForLocal && this._currentModuleAst &&
                       this.getImportBindingForLocal(this._currentModuleAst, name)) {
                // 兜底：未被闭包分析装箱的导入绑定存在 _main 局部槽，
                // 模块函数体看不见——运行时直接从源模块 namespace 取值
                const ib = this.getImportBindingForLocal(this._currentModuleAst, name);
                this.vm.movImm(VReg.A0, ib.sourceModuleIndex);
                const impNameLabel = this.asm.addString(ib.importedName || name);
                this.vm.lea(VReg.A1, impNameLabel);
                this.vm.call("_get_module_export");
            } else if (name === "print") {
                // 内置函数 print - 生成一个包装闭包
                // 创建一个简单闭包对象 { magic, func_ptr }
                this.vm.movImm(VReg.A0, 16);
                this.vm.call("_alloc");
                this.vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
                this.vm.store(VReg.RET, 0, VReg.V1);
                this.vm.lea(VReg.V1, "_print_wrapper");
                this.vm.store(VReg.RET, 8, VReg.V1);
            } else {
                this.vm.movImm(VReg.RET, 0);
            }
        }
    },

    // 编译成员表达式 (obj.prop 或 arr[idx])
    // 类节点的 constructor 形参(供 Class.length)。body 是 MethodDefinition 数组。
    _classCtorParams(classNode) {
        const items = (classNode && classNode.body && classNode.body.length !== undefined) ? classNode.body : [];
        for (let i = 0; i < items.length; i = i + 1) {
            const m = items[i];
            if (m && m.kind === "constructor" && m.value) return m.value.params || [];
        }
        return [];
    },

    // 把接收者表达式静态解析到函数 AST 节点 + 默认名(绑定名/方法名):
    //   标识符 → 函数声明/类声明,或 const 绑定的箭头·函数表达式·类表达式;
    //   obj.method(obj 为 const 绑定的对象字面量)→ 该属性的函数值。
    // 返回 { node, fallbackName } 或 null。
    _resolveFnNode(objExpr) {
        if (objExpr.type === "Identifier") {
            const nm = objExpr.name;
            const decl = this.ctx.getFunction ? this.ctx.getFunction(nm) : null;
            if (decl && (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration")) {
                return { node: decl, fallbackName: nm };
            }
            const init = (this.ctx.varInitExprs && this.ctx.varInitExprs[nm]) || null;
            if (init && (init.type === "ArrowFunctionExpression" ||
                init.type === "FunctionExpression" || init.type === "ClassExpression")) {
                return { node: init, fallbackName: nm };
            }
            return null;
        }
        if (objExpr.type === "MemberExpression" && !objExpr.computed &&
            objExpr.object && objExpr.object.type === "Identifier" &&
            objExpr.property && objExpr.property.type === "Identifier") {
            const objInit = (this.ctx.varInitExprs && this.ctx.varInitExprs[objExpr.object.name]) || null;
            if (objInit && objInit.type === "ObjectExpression") {
                const pn = objExpr.property.name;
                const props = objInit.properties || [];
                for (let i = 0; i < props.length; i = i + 1) {
                    const p = props[i];
                    if (p && p.key && p.key.name === pn && p.value &&
                        (p.value.type === "FunctionExpression" || p.value.type === "ArrowFunctionExpression")) {
                        return { node: p.value, fallbackName: pn };
                    }
                }
            }
        }
        return null;
    },

    // 若接收者表达式静态解析到用户函数/类/方法,返回 { name, length }(编译期已知),否则 null。
    //   .name  = 函数自身名(命名函数表达式)优先,否则绑定名/方法名;类同理。
    //   .length = 首个默认/剩余形参之前的形参个数(node 语义)。
    _fnNameLength(objExpr) {
        const r = this._resolveFnNode(objExpr);
        if (!r) return null;
        const node = r.node;
        let ownName;
        let params;
        if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
            ownName = (node.id && node.id.name) ? node.id.name : r.fallbackName;
            params = this._classCtorParams(node);
        } else {
            ownName = (node.id && node.id.name) ? node.id.name : r.fallbackName;
            params = node.params || [];
        }
        let arity = 0;
        for (let i = 0; i < params.length; i = i + 1) {
            const t = params[i].type;
            if (t === "AssignmentPattern" || t === "SpreadElement" || t === "RestElement") break;
            arity = arity + 1;
        }
        return { name: ownName, length: arity };
    },

    compileMemberExpression(expr) {
        // 可选成员访问 obj?.prop：obj 为 null/undefined 则整表达式短路 undefined
        if (expr.optional) {
            const skipLabel = this.ctx.newLabel("optmem_skip");
            const endLabel = this.ctx.newLabel("optmem_end");
            this.compileExpression(expr.object);
            this.vm.cmpImm(VReg.RET, 0);
            this.vm.jeq(skipLabel);
            this.vm.mov(VReg.V1, VReg.RET);
            this.vm.shrImm(VReg.V1, VReg.V1, 48);
            this.vm.cmpImm(VReg.V1, 0x7FFA);
            this.vm.jeq(skipLabel);
            this.vm.cmpImm(VReg.V1, 0x7FFB);
            this.vm.jeq(skipLabel);
            // 非空:去 optional 标记后按普通成员访问重新分派——类型感知(数组 .length/
            // 字符串下标/对象键各走 intrinsic),不再一律 _object_get(此前 arr?.length 落
            // 0 的根因)。短路时(skip)object 之后的成员/下标不求值,语义正确;object 本身
            // 被重新求值(标识符/简单成员无副作用;副作用对象表达式双求值,记偏差)。
            expr.optional = false;
            this.compileMemberExpression(expr);
            expr.optional = true; // 复原(AST 可能复用)
            this.vm.jmp(endLabel);
            this.vm.label(skipLabel);
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            this.vm.label(endLabel);
            return;
        }
        if (expr.computed) {
            // computed 中的 Identifier 是变量（obj[i]），不是属性名——
            // 只有字符串字面量 obj["k"] / Symbol.iterator 才是静态键
            const staticKey =
                (expr.property.type === "Literal" || expr.property.type === "StringLiteral") &&
                    typeof expr.property.value === "string"
                    ? String(expr.property.value)
                    : (expr.property.type === "MemberExpression"
                        ? this.getMemberPropertyName(expr.property)
                        : null);
            const computedPropName = staticKey;
            if (computedPropName !== null) {
                this.compileExpression(expr.object);
                this.emitObjectGetIC(computedPropName); // [P2] 站点缓存(getter 已融合)
                return;
            }

            // 数组元素访问：arr[idx]
            // 检查对象类型以选择正确的处理方式
            const objType = this.inferObjectType ? this.inferObjectType(expr.object) : "unknown";

            // 字符串索引：使用 _str_charAt
            if (objType === "String") {
                if (expr.property.type === "Literal" && typeof expr.property.value === "number") {
                    // 静态索引："str"[0]。走 _str_index_char:越界返 undefined(str[i] 语义)
                    const idx = Math.trunc(expr.property.value);
                    this.compileExpression(expr.object);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.movImm(VReg.A1, idx);
                    this.vm.call("_str_index_char");
                } else {
                    // 动态索引："str"[i]。索引经 _syscall_arg 归一化为裸 int——它稳健处理
                    // 裸 float64 位 / 0x7ff8 装箱 int / 堆 Number 指针各表示。原用
                    // numberToIntInPlace(=f2i,读 [src+8] 当堆 Number 对象指针)对裸 float
                    // 位(如 s[p] 里 p=1.0)读越界 → 未转的 float 位当字符偏移 → 段错(崩溃修复)。
                    // [求值序] 非纯操作数按规范序(对象→键);皆纯保持原序字节不变。
                    if (this.isPureExpr(expr.object) && this.isPureExpr(expr.property)) {
                        this.compileExpression(expr.property);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_syscall_arg");  // RET = 裸 int 索引
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.object);
                        this.vm.mov(VReg.A0, VReg.RET); // A0 = 字符串
                        this.vm.pop(VReg.A1);           // A1 = 裸 int 索引
                    } else {
                        this.compileExpression(expr.object);
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.property);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_syscall_arg");  // RET = 裸 int 索引
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.pop(VReg.A0);           // A0 = 字符串
                    }
                    this.vm.call("_str_index_char"); // 越界返 undefined(str[i] 语义)
                }
            } else if (expr.property.type === "Literal" && typeof expr.property.value === "number" &&
                       Math.trunc(expr.property.value) === expr.property.value) {
                // 静态索引：arr[0]（仅整数字面量;o[2.5] 若在此被 Math.trunc 截成 2
                // 会与 o[2] 塌键 [#39],非整数字面量走下方动态路径按 float 位传运行时）
                const idx = Math.trunc(expr.property.value);
                this.compileExpression(expr.object);
                // A0 保持装箱(勿提前 _js_unbox):_subscript_get 靠 A0 的 0x7FFC 标签分派
                // 字符串 charAt。提前 unbox 会剥掉标签 → String(x)[i]/unknown 类型字符串
                // 下标误判为数组越界读 undefined。_subscript_get 内部对数组/对象自行 unbox
                // (裸指针/装箱皆可),A1=裸 idx 经 _syscall_arg 直通,故安全。
                this.vm.mov(VReg.A0, VReg.RET);
                this.vm.movImm(VReg.A1, idx);
                this.vm.call("_subscript_get");
            } else if (expr.property.type === "Literal" && typeof expr.property.value === "string") {
                // 对象静态字符串属性：({a:1})["a"]
                const propName = expr.property.value;
                const propLabel = this.asm.addString(propName);
                this.compileExpression(expr.object);
                this.vm.mov(VReg.A0, VReg.RET); // A0 = boxed JSValue object
                // Box the property key label as a JSValue string
                this.vm.lea(VReg.A1, propLabel);
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A1, VReg.A1, VReg.V1);
                this.vm.call("_object_get");
            } else {
                // 动态下标：arr[i] / obj[key]
                // [支柱② L3] 整数索引:内联数组下标读快路——运行时判 array 标签(0x7FFE)
                // + block type==1(排除 TypedArray/对象),命中直接 ldr 元素,免 call
                // _subscript_get(每访问省一次全函数调用+动态分派)。未命中尾跳 helper;
                // 越界返 undefined(0x7ffb,同 _subscript_get_arr_oob 语义)。非整数索引
                // (obj["k"] 等字符串键语义不同)不入此路,走下方原通用分派。
                const idxIsInt = this.isIntExpression(expr.property) ||
                    (expr.property.type === "Identifier" && this.ctx.isRawIntVar(expr.property.name));
                if (idxIsInt) {
                    // [求值序] 非纯操作数按规范序(对象→键);皆纯保持原序字节不变。
                    if (this.isPureExpr(expr.object) && this.isPureExpr(expr.property)) {
                        this.compileExpressionAsInt(expr.property); // RET = 裸 int 索引
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.object);        // RET = boxed 对象
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.pop(VReg.V1);                        // V1 = 裸 int 索引
                    } else {
                        this.compileExpression(expr.object);        // RET = boxed 对象
                        this.vm.push(VReg.RET);
                        this.compileExpressionAsInt(expr.property); // RET = 裸 int 索引
                        this.vm.mov(VReg.V1, VReg.RET);              // V1 = 裸 int 索引
                        this.vm.pop(VReg.A0);                        // A0 = boxed 对象
                    }
                    const slow = this.ctx.newLabel("subget_slow");
                    const undef = this.ctx.newLabel("subget_undef");
                    const done = this.ctx.newLabel("subget_done");
                    this.vm.mov(VReg.V0, VReg.A0);
                    this.vm.shrImm(VReg.V0, VReg.V0, 48);
                    this.vm.cmpImm(VReg.V0, 0x7FFE);
                    this.vm.jne(slow);                          // 非 array 标签 → 慢路
                    this.vm.emitMaskLoad(VReg.V0);
                    this.vm.andMaskReg(VReg.V2, VReg.A0, VReg.V0);     // V2 = 数组 block
                    this.vm.load(VReg.V3, VReg.V2, 0);
                    this.vm.andImm(VReg.V3, VReg.V3, 0xff);
                    this.vm.cmpImm(VReg.V3, 1);                 // TYPE_ARRAY?(排除 typed)
                    this.vm.jne(slow);
                    this.vm.load(VReg.V3, VReg.V2, 8);          // length
                    this.vm.cmpImm(VReg.V1, 0);
                    this.vm.jlt(undef);
                    this.vm.cmp(VReg.V1, VReg.V3);
                    this.vm.jge(undef);
                    this.vm.load(VReg.V0, VReg.V2, 24);         // data_ptr
                    this.vm.shl(VReg.V4, VReg.V1, 3);
                    this.vm.add(VReg.V4, VReg.V0, VReg.V4);
                    this.vm.load(VReg.RET, VReg.V4, 0);         // 元素(boxed JSValue)
                    this.vm.jmp(done);
                    this.vm.label(slow);
                    this.vm.mov(VReg.A1, VReg.V1);              // 裸 int 索引(慢路 _syscall_arg 直通)
                    this.vm.call("_subscript_get");
                    this.vm.jmp(done);
                    this.vm.label(undef);
                    this.vm.movImm64(VReg.RET, 0x7ffb000000000000n);
                    this.vm.label(done);
                } else {
                    // 非整数索引:键保持原始 JSValue，交给 _subscript_get 运行时分派
                    // [求值序] 非纯操作数按规范序(对象→键);皆纯保持原序字节不变。
                    if (this.isPureExpr(expr.object) && this.isPureExpr(expr.property)) {
                        this.compileExpression(expr.property);
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.object);
                        this.vm.pop(VReg.V1);

                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.mov(VReg.A1, VReg.V1);
                    } else {
                        this.compileExpression(expr.object);
                        this.vm.push(VReg.RET);
                        this.compileExpression(expr.property);
                        this.vm.mov(VReg.A1, VReg.RET);
                        this.vm.pop(VReg.A0);
                    }
                    this.vm.call("_subscript_get");
                }
            }
        } else {
            const propName = this.getMemberPropertyName(expr.property);

            // [#66 Phase2] super.prop 读:从父类 prototype 沿链取属性/访问器,再以
            // 当前实例(this)解 getter。ctx.superClass 记父类名;父 prototype =
            // [[classinfo+32]+24](props_ptr → props[1].val 裸 proto),取法同
            // functions.js super.method(714-723);_object_get 沿父链找属性/getter
            // 标记,_maybe_getter 以 this 调 getter(数据属性原样返回)。
            // (计算键 super[expr] 仍走上方 computed 路径 → 未处理,记为偏差。)
            if (expr.object && expr.object.type === "SuperExpression" && this.ctx.superClass) {
                const thisOffset = this.ctx.getLocal("__this");
                this.emitLoadSuperClassInfo(VReg.S1); // S1 = 父类信息对象(raw);表达式父类走全局
                if (!this.ctx.inStaticMethod) {
                    this.vm.load(VReg.S1, VReg.S1, 32); // props_ptr
                    this.vm.load(VReg.S1, VReg.S1, 24); // 父 prototype 对象(raw) = props[1].val
                } // 静态方法:S1 已是父类对象,静态成员直接在其上
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.A0, VReg.S1, VReg.V1);
                this.vm.movImm64(VReg.V1, 0x7ffd000000000000n);
                this.vm.or(VReg.A0, VReg.A0, VReg.V1); // A0 = 装箱父 prototype
                this.emitBoxedStringKey(propName, VReg.A1);
                this.vm.call("_object_get"); // RET = 属性值(或 getter 标记)
                this.vm.mov(VReg.A0, VReg.RET);
                if (thisOffset) this.vm.load(VReg.A1, VReg.FP, thisOffset); // this = 当前实例
                else this.vm.movImm(VReg.A1, 0);
                this.vm.call("_maybe_getter");
                return;
            }

            // [#66 Phase3] X.prototype 一致性:类信息对象里 prototype(props[1].val)以
            // 裸指针存储,直接读回 typeof "number" 且与 getPrototypeOf(返 0x7FFD 装箱)
            // !==(ES_SUPPORT:73)。用户类 X.prototype 成员读出口装箱 0x7FFD,使
            // getPrototypeOf(new X())===X.prototype。内部 new/super 直读 classinfo、
            // 不经此路径仍取裸(不受影响);运行时对象 helper 皆脱壳,装箱值透明兼容
            // (Object.assign(X.prototype,mixin) 等)。局部同名遮蔽时退回通用路径。
            if (propName === "prototype" && expr.object && expr.object.type === "Identifier") {
                const protoDecl = this.ctx.getFunction ? this.ctx.getFunction(expr.object.name) : null;
                if (protoDecl && protoDecl.type === "ClassDeclaration") {
                    this.compileExpression(expr.object); // RET = 类信息对象(raw)
                    this.emitObjectGetIC("prototype");    // RET = prototype(raw)
                    this.vm.call("_box_obj_r"); // box->helper
                    return;
                }
            }

            // [Stage A] Object.prototype.<m> 作**值读取**:发接收者无绑定的内置方法引用
            // 闭包({0xc105, _aref_generic, helper}),蹦床把 this(A5)插到 A0 后调 helper —— 
            // 使 `const t = Object.prototype.toString; t.call(x)` 等提取形态可调可传
            // (typeof 亦得 "function")。仅静态链 Object.prototype 且 Object 未被局部遮蔽时
            // 触发;直接调用形态(….call(x) 整链)仍走 functions.js 既有内联,不经此。
            // [#32 守卫] typeof==="string" 判命中,防字典原型链污染(propName 为用户串)。
            if (expr.object && expr.object.type === "MemberExpression" && !expr.object.computed &&
                expr.object.object && expr.object.object.type === "Identifier" &&
                expr.object.object.name === "Object" &&
                expr.object.property && expr.object.property.name === "prototype" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Object"))) {
                const _opHelpers = {
                    toString: "_object_proto_toString",
                    hasOwnProperty: "_aref_obj_hasOwn",
                    valueOf: "_aref_obj_valueOf",
                    isPrototypeOf: "_is_prototype_of",
                    propertyIsEnumerable: "_object_propertyIsEnumerable",
                };
                const _oph = _opHelpers[propName];
                if (typeof _oph === "string") {
                    this.emitBuiltinMethodRefClosure(_oph);
                    return;
                }
            }

            // [test262 S1 泛型数组方法] Array.prototype.<m> 作值读取:发接收者无绑定的
            // 内置方法引用闭包({0xc105, _aref_generic, _agen_<m>})。使
            // `Array.prototype.map.call(arrayLike, fn)`/`.apply`/提取存变量等泛型调用
            // 形态可用(ES 要求数组方法泛型)。_agen_* 是纯新增运行时分派层:真数组
            // 恒等直通既有 _array_*_rt/_aref_arr_* 路径,字符串/类数组对象快照成真数组
            // 后同路委托(runtime/types/array/index.js:generateAgenGeneric)。
            // 仅静态链 Array.prototype 且 Array 未被局部遮蔽时触发;编译器源不含此
            // 模式,自举字节不变。[#32 守卫] typeof==="string" 判命中防原型链污染。
            if (expr.object && expr.object.type === "MemberExpression" && !expr.object.computed &&
                expr.object.object && expr.object.object.type === "Identifier" &&
                expr.object.object.name === "Array" &&
                expr.object.property && expr.object.property.name === "prototype" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Array"))) {
                const _apHelpers = {
                    forEach: "_agen_forEach",
                    map: "_agen_map",
                    filter: "_agen_filter",
                    some: "_agen_some",
                    every: "_agen_every",
                    reduce: "_agen_reduce",
                    reduceRight: "_agen_reduceRight",
                    indexOf: "_agen_indexOf",
                    lastIndexOf: "_agen_lastIndexOf",
                    includes: "_agen_includes",
                    join: "_agen_join",
                    slice: "_agen_slice",
                    at: "_agen_at",
                };
                const _aph = _apHelpers[propName];
                if (typeof _aph === "string") {
                    this.emitBuiltinMethodRefClosure(_aph);
                    return;
                }
            }

            // [#58] Math 常量(E/PI):编译期折成 raw f64 位常量直入 RET。
            // 原先 Math.X 非方法访问落通用 _object_get → Math 无此对象 → 得 0。
            // 显式 === 链(非 {} 查表:用户标识符做字典键有原型链污染风险,#32)。
            // 用户遮蔽(局部 Math)时退回通用路径。
            // 只收 E/PI:更多常量(LN2/SQRT2/…)会把自举产物尺寸推过 16KB 页界,
            // 触发既有(与本改动无关的)字符串池排序潜伏非确定性 → gen3≠gen4 振荡;
            // E/PI 足够小不移动布局(产物尺寸与不加时一致),保持原生逐字节自复现。
            // 其余常量记为偏差,待该潜伏问题独立修复后再补。
            if (expr.object.type === "Identifier" && expr.object.name === "Math" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Math"))) {
                let mathConstBits = null;
                if (propName === "E") mathConstBits = 0x4005bf0a8b145769n;
                else if (propName === "PI") mathConstBits = 0x400921fb54442d18n;
                if (mathConstBits !== null) {
                    this.vm.movImm64(VReg.RET, mathConstBits);
                    return;
                }
            }

            // [内建静态一等值] `Math.floor` 等命名空间静态作值读取 → memoized 闭包
            // (typeof "function"、可存变量/传回调、`Math.floor===Math.floor` 真)。
            // 调用位不经此(compileCallExpression 先分派),用户遮蔽(局部同名)退回通用。
            // [#32 守卫] typeof==="string" 判命中(防 toString/constructor 原型链污染)。
            // [#32 双层守卫] 外层表名显式白名单(NamespaceStaticRef["toString"] 经原型链返
            // Function.toString,其 .name 恰是字符串 → 单靠内层 typeof 判会误发射);内层
            // typeof==="string" 判 helper 命中。
            if (expr.object && expr.object.type === "Identifier" &&
                (expr.object.name === "Math" || expr.object.name === "Object" ||
                    expr.object.name === "Date" || expr.object.name === "Array") &&
                !(this.ctx.getLocal && this.ctx.getLocal(expr.object.name))) {
                const _nsTable = NamespaceStaticRef[expr.object.name];
                const _nsHelper = _nsTable ? _nsTable[propName] : null;
                if (typeof _nsHelper === "string") {
                    this.emitMemoizedBuiltinRef(
                        expr.object.name.toLowerCase() + "_" + propName, _nsHelper);
                    return;
                }
            }

            // Number.MAX_SAFE_INTEGER 等常量(纯 float64 位直发,不入字符串池,与 Math
            // E/PI 同法)。此前 `Number.X` 成员访问落 miss → 恒 0。仅收录**正规**浮点位
            // (避开 high16=0 的 denormal MIN_VALUE:与裸指针区间冲突,单列不做)。
            if (expr.object.type === "Identifier" && expr.object.name === "Number" &&
                !(this.ctx.getLocal && this.ctx.getLocal("Number"))) {
                let numConstBits = null;
                if (propName === "MAX_SAFE_INTEGER") numConstBits = 0x433fffffffffffffn;      // 2^53-1
                else if (propName === "MIN_SAFE_INTEGER") numConstBits = 0xc33fffffffffffffn; // -(2^53-1)
                else if (propName === "MAX_VALUE") numConstBits = 0x7fefffffffffffffn;
                else if (propName === "EPSILON") numConstBits = 0x3cb0000000000000n;          // 2^-52
                else if (propName === "POSITIVE_INFINITY") numConstBits = 0x7ff0000000000000n;
                else if (propName === "NEGATIVE_INFINITY") numConstBits = 0xfff0000000000000n;
                else if (propName === "NaN") numConstBits = 0x7ff0000000000001n;              // 与 NaN 标识符同位
                if (numConstBits !== null) {
                    this.vm.movImm64(VReg.RET, numConstBits);
                    return;
                }
            }

            // Symbol.iterator 等 well-known 占位符号(批次D):懒创建、进程内唯一
            // (数据段槽 _symwk_* 常驻 GC 根区)。显式 === 链而非 {} 查表——
            // 用户标识符做字典键有原型链污染风险(gen1,#32)。
            // 注意:obj[Symbol.iterator] 计算键路径仍走既有静态字符串键
            // "Symbol.iterator"(getMemberPropertyName),此处只处理值读取。
            if (expr.object.type === "Identifier" && expr.object.name === "Symbol" &&
                !this.ctx.getLocal("Symbol") &&
                (propName === "iterator" || propName === "asyncIterator" ||
                 propName === "hasInstance" || propName === "toPrimitive" ||
                 propName === "toStringTag")) {
                this.vm.lea(VReg.A0, "_symwk_" + propName);
                const wkDescLabel = this.asm.addString("Symbol." + propName);
                this.vm.lea(VReg.A1, wkDescLabel);
                this.vm.movImm64(VReg.V1, 0x7ffc000000000000n);
                this.vm.or(VReg.A1, VReg.A1, VReg.V1);
                this.vm.call("_symbol_wellknown");
                return;
            }

            // [构造器 .prototype] X.prototype(X∈TA 族/ArrayBuffer)→ _get_ctor_proto 单例对象。
            // ArrayBuffer.prototype 为空对象:test262 TA include 的 resize/transferToImmutable
            // 特性探测安全返 undefined(此前 undefined.resize 抛异常 → TA 区 288 项全灭)。
            if (propName === "prototype" && expr.object.type === "Identifier" &&
                TA_CTOR_TAGS[expr.object.name] !== undefined &&
                !(this.ctx.getLocal && this.ctx.getLocal(expr.object.name))) {
                this.vm.movImm(VReg.A0, TA_CTOR_TAGS[expr.object.name]);
                this.vm.call("_get_ctor_proto");
                return;
            }

            // TypedArray 属性:静态 X.BYTES_PER_ELEMENT(常量)、实例 ta.BYTES_PER_ELEMENT /
            // ta.byteLength(运行时按 type 字节算 elemSize / length*elemSize)。
            if (propName === "BYTES_PER_ELEMENT" || propName === "byteLength") {
                const TA_BPE = { Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1,
                    Int16Array: 2, Uint16Array: 2, Int32Array: 4, Uint32Array: 4,
                    Float32Array: 4, BigInt64Array: 8, BigUint64Array: 8, Float64Array: 8 };
                // 静态 Int32Array.BYTES_PER_ELEMENT → 常量 number。
                if (propName === "BYTES_PER_ELEMENT" && expr.object.type === "Identifier" &&
                    TA_BPE[expr.object.name] !== undefined && !this.ctx.getLocal(expr.object.name)) {
                    this.vm.movImm(VReg.RET, TA_BPE[expr.object.name]);
                    this.vm.scvtf(0, VReg.RET);
                    this.vm.fmovToInt(VReg.RET, 0);
                    return;
                }
                const objType = this.inferObjectType ? this.inferObjectType(expr.object) : "unknown";
                if (objType === "TypedArray") {
                    this.compileExpression(expr.object);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call(propName === "byteLength" ? "_ta_bytelength" : "_ta_elem_size");
                    this.vm.scvtf(0, VReg.RET);   // 转 canonical float number
                    this.vm.fmovToInt(VReg.RET, 0);
                    return;
                }
                // ArrayBuffer.byteLength → 头 byteLength@8(_arraybuffer_bytelength)。
                if (propName === "byteLength" && objType === "ArrayBuffer") {
                    this.compileExpression(expr.object);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_arraybuffer_bytelength");
                    this.vm.scvtf(0, VReg.RET);   // 裸 int → canonical float number
                    this.vm.fmovToInt(VReg.RET, 0);
                    return;
                }
            }

            // [Design B] TypedArray.buffer / .byteOffset。buffer 返回包裹 ArrayBuffer
            // (别名内联数据,DataView 经其可读写同一内存);全视图 byteOffset 恒 0。
            if (propName === "buffer" || propName === "byteOffset") {
                const taObjType = this.inferObjectType ? this.inferObjectType(expr.object) : "unknown";
                if (taObjType === "TypedArray") {
                    if (propName === "buffer") {
                        this.compileExpression(expr.object);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_ta_buffer");
                    } else {
                        // byteOffset:视图 = data_ptr - buffer.data_ptr;内联 = 0。
                        this.compileExpression(expr.object);
                        this.vm.mov(VReg.A0, VReg.RET);
                        this.vm.call("_ta_byteoffset");
                        this.vm.scvtf(0, VReg.RET);   // 裸 int → canonical number
                        this.vm.fmovToInt(VReg.RET, 0);
                    }
                    return;
                }
            }

            // 用户函数/类的 .name / .length 反射(编译期已知,静态解析访问点)。仅当接收者标识符
            // 静态解析到函数声明/类/const 绑定的箭头·函数表达式·类表达式时触发;数组/对象/字符串
            // 等其它接收者的 .length/.name 走下方通用路径 → 普通函数值 codegen 逐字节不变。
            // asm.js 函数是闭包/裸函数指针、无属性容器,故 fn.name/fn.length 用访问点静态解析,
            // 不改闭包表示;运行时传递的函数值(参数/成员链)不静态可知则回落(undefined/通用)。
            if ((propName === "name" || propName === "length") && expr.object &&
                (expr.object.type === "Identifier" || expr.object.type === "MemberExpression")) {
                const _fm = this._fnNameLength(expr.object);
                if (_fm) {
                    // [t671] 先查闭包属性侧表:defineProperty(fn,"length"/"name",{value})
                    // 的覆盖须被读回(容器命中即用);miss(undefined)回落编译期静态值。
                    const fmDone = this.ctx.newLabel("fnnl_done");
                    this.compileExpression(expr.object);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.emitBoxedStringKey(propName, VReg.A1);
                    this.vm.call("_closure_prop_get");
                    this.vm.shrImm(VReg.V1, VReg.RET, 48);
                    this.vm.cmpImm(VReg.V1, 0x7FFB); // undefined → 静态回落
                    this.vm.jne(fmDone);
                    if (propName === "name") {
                        this.vm.lea(VReg.A0, this.asm.addString(_fm.name));
                        this.vm.call("_js_box_string");
                    } else {
                        this.vm.movImm(VReg.RET, _fm.length);
                        this.intToFloat64Bits(VReg.RET);
                    }
                    this.vm.label(fmDone);
                    return;
                }
            }

            // 用户函数自定义属性读 fn.x(x 非 name/length/prototype):接收者静态解析到**函数**
            // (非类——类有自己的静态成员机制)时,经闭包属性侧表(_closure_prop_get)读。asm.js
            // 函数无属性容器,侧表按裸指针身份挂;无侧表/键 miss 返 undefined。仅函数接收者触发,
            // 其它类型(含类)走通用路径逐字节不变。
            if (propName !== "prototype" && expr.object &&
                (expr.object.type === "Identifier" || expr.object.type === "MemberExpression")) {
                const _fnr = this._resolveFnNode(expr.object);
                if (_fnr && (_fnr.node.type === "FunctionDeclaration" ||
                    _fnr.node.type === "FunctionExpression" || _fnr.node.type === "ArrowFunctionExpression")) {
                    this.compileExpression(expr.object);
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.emitBoxedStringKey(propName, VReg.A1);
                    this.vm.call("_closure_prop_get");
                    return;
                }
            }

            // 特殊处理 .length 属性 - 可能是数组或字符串
            if (propName === "length") {
                const objType = this.inferObjectType ? this.inferObjectType(expr.object) : "unknown";
                this.compileExpression(expr.object);

                if (objType === "Array" || objType === "TypedArray") {
                    // 数组和 TypedArray：调用对应的封装方法获取长度
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_unbox"); // unbox JSValue 得到裸指针
                    if (objType === "TypedArray") {
                        this.vm.call("_typed_array_length");
                    } else {
                        this.vm.call("_array_length");
                    }
                    // 转为标准 JS number（float64 位）——装箱 Number 会让
                    // 比较/减法等把指针当数值（如 len < maxLen - 1）
                    this.vm.scvtf(0, VReg.RET);
                    this.vm.fmovToInt(VReg.RET, 0);
                } else {
                    // 字符串或未知类型：运行时按值形态分派（数组/TypedArray/字符串）
                    this.vm.mov(VReg.A0, VReg.RET);
                    this.vm.call("_js_length");
                    this.vm.scvtf(0, VReg.RET);
                    this.vm.fmovToInt(VReg.RET, 0);
                }
            } else if (propName === "size") {
                // Map/Set 的 .size 存于对象偏移 8（整数计数）；其它对象退回普通 "size" 属性读。
                // 原无此分支 → map.size 走通用 _object_get 把 Map 当对象遍历 → 崩溃。
                // asm.addFloat64 每 emit 一个浮点常量都读 this.floats.size(Map) → gen1 codegen 崩溃根因。
                const containerLbl = this.ctx.newLabel("size_container");
                const sizeEndLbl = this.ctx.newLabel("size_end");
                this.compileExpression(expr.object);
                this.vm.push(VReg.RET);                        // 保存 boxed obj
                this.vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
                this.vm.and(VReg.V0, VReg.RET, VReg.V1);       // 裸指针
                this.vm.loadByte(VReg.V2, VReg.V0, 0);         // 类型字节
                this.vm.cmpImm(VReg.V2, 4);                    // TYPE_MAP
                this.vm.jeq(containerLbl);
                this.vm.cmpImm(VReg.V2, 5);                    // TYPE_SET
                this.vm.jeq(containerLbl);
                // 非容器：普通属性读。**必须走 getter 感知路径**(emitObjectGetIC 融合
                // _maybe_getter),否则用户类 `get size(){...}` 经裸 _object_get 返 getter
                // 描述符对象 → 打印 "[object Object]"、`get size(){return 7}` 也返对象。
                this.vm.pop(VReg.RET);          // boxed obj → RET(emitObjectGetIC 入参)
                this.emitObjectGetIC("size");
                this.vm.jmp(sizeEndLbl);
                this.vm.label(containerLbl);
                this.vm.pop(VReg.V0);                          // boxed obj
                this.vm.movImm64(VReg.V1, 0x0000FFFFFFFFFFFFn);
                this.vm.and(VReg.V0, VReg.V0, VReg.V1);        // 裸指针
                this.vm.load(VReg.RET, VReg.V0, 8);            // size 计数（整数）
                this.vm.scvtf(0, VReg.RET);
                this.vm.fmovToInt(VReg.RET, 0);
                this.vm.label(sizeEndLbl);
            } else {
                // 特殊处理 import.meta.url
                if (expr.object.type === "MetaProperty" && propName === "url") {
                    // [layout-determinism] 只嵌入 basename(cwd 无关、node/asm.js 一致):sourcePath 在 node 是
                    // path.resolve 的绝对路径(含 cwd)、asm.js 是相对路径 → 嵌入串分歧 → __data 布局分歧
                    // (g1≠g2 + cwd 路径长度敏感的雷区根因)。自举二进制不依赖该嵌入值(cwd 分支优先)。
                    const _spb = String(this.sourcePath || ".").replace(/\\/g, "/");
                    const _base = _spb.slice(_spb.lastIndexOf("/") + 1) || ".";
                    const url = "file://" + _base + "/module.js";
                    const label = this.asm.addString(url);
                    this.vm.lea(VReg.A0, label);
                    this.vm.call("_js_box_string");
                    return;
                }

                // [Stage A 内置方法引用] `arr.push`/`"x".toUpperCase` 等作**值读取**(非调用)
                // 时,返回内置方法闭包(经 _aref_generic 蹦床调运行时 helper),使
                // `typeof [].push==="function"`、`const f=arr.push; f.call(arr,9)` 成立。
                // 方法**调用** `arr.push(9)` 走 compileCallExpression 的静态派发、不经此路径,
                // 故纯增量、不改调用语义。运行时判接收者 tag:数组(0x7FFE)/字符串(0x7FFC)
                // 且方法名命中表 → 建闭包;否则(对象/基元/用户同名属性)退回通用属性读。
                // 首批仅收 helper 型且忽略多余实参的方法(避免可选参默认值问题)。
                // [#32 守卫] 用 typeof==="string" 判命中——`ArefMethodRef.array[propName]` 对
                // propName="toString"/"constructor"/"hasOwnProperty" 等会经原型链返回
                // Object.prototype 方法(函数),裸真值判会误当 helper → lea(函数)崩。
                const _ah = ArefMethodRef.array[propName];
                const _sh = ArefMethodRef.string[propName];
                const arefHelper = typeof _ah === "string" ? _ah : null;
                const strefHelper = typeof _sh === "string" ? _sh : null;
                if (arefHelper || strefHelper) {
                    const id = this.nextLabelId();
                    const endL = this.ctx.newLabel("aref_end");
                    const recvSlot = this.ctx.allocLocal(`__aref_recv_${id}`);
                    this.compileExpression(expr.object);          // RET = 接收者
                    this.vm.store(VReg.FP, recvSlot, VReg.RET);
                    this.vm.load(VReg.V1, VReg.FP, recvSlot);      // 用 V1 取 tag(避 x64 V0==RET 别名)
                    this.vm.shrImm(VReg.V1, VReg.V1, 48);
                    if (arefHelper) {
                        const buildArrL = this.ctx.newLabel("aref_arr");
                        this.vm.cmpImm(VReg.V1, 0x7FFE);
                        this.vm.jeq(buildArrL);
                        if (strefHelper) {
                            const buildStrL = this.ctx.newLabel("aref_str");
                            this.vm.cmpImm(VReg.V1, 0x7FFC);
                            this.vm.jeq(buildStrL);
                            // fallback
                            this.vm.load(VReg.RET, VReg.FP, recvSlot);
                            this.emitObjectGetIC(propName);
                            this.vm.jmp(endL);
                            this.vm.label(buildStrL);
                            this.emitBuiltinMethodRefClosure(strefHelper);
                            this.vm.jmp(endL);
                        } else {
                            // fallback
                            this.vm.load(VReg.RET, VReg.FP, recvSlot);
                            this.emitObjectGetIC(propName);
                            this.vm.jmp(endL);
                        }
                        this.vm.label(buildArrL);
                        this.emitBuiltinMethodRefClosure(arefHelper);
                        this.vm.jmp(endL);
                    } else {
                        // 仅字符串方法
                        const buildStrL = this.ctx.newLabel("aref_str");
                        this.vm.cmpImm(VReg.V1, 0x7FFC);
                        this.vm.jeq(buildStrL);
                        this.vm.load(VReg.RET, VReg.FP, recvSlot);
                        this.emitObjectGetIC(propName);
                        this.vm.jmp(endL);
                        this.vm.label(buildStrL);
                        this.emitBuiltinMethodRefClosure(strefHelper);
                    }
                    this.vm.label(endL);
                    return;
                }

                this.compileExpression(expr.object);
                this.emitObjectGetIC(propName); // [P2] 站点缓存(getter 已融合)
            }
        }
    },
    // 编译元属性 (如 import.meta)
    compileMetaProperty(expr) {
        const meta = expr.meta.name;
        const prop = expr.property.name;

        if (meta === "import" && prop === "meta") {
            // 返回空对象。原为手写 16 字节头(只写 type,count/props_ptr 全垃圾)——
            // 读属性会扫垃圾 props、MRU(obj+40) 更在块外。改走 _object_new(完整 48 头)。
            this.vm.call("_object_new");
            return;
        }
        if (meta === "new" && prop === "target") {
            // new.target:现仅解析支持 + 求值为 undefined(安全最小实现)。完整语义(new
            // 调用检测 / 构造器内取**最派生**类)需跨 lane 基建:`this.constructor`(Agent B
            // 的 class-info identity,现返 undefined)、类值一致装箱(现类标识符是裸 classinfo,
            // typeof/真值不一致)、most-derived 经 super 透传。任一裸/装箱 classinfo 方案都
            // 有硬伤:裸 → `new Sub()` 在抽象基类 `if(new.target===Base)throw` 下**误抛**(取
            // 词法 Base 而非最派生 Sub)、且 typeof 得 "number"/真值为假;装箱 → `===类名`
            // 失败。故取 undefined:不崩、不误抛、令含 new.target 的源码可编译运行;
            // 抽象基类 `new Sub()` 正常构造(=== 走 false 分支)。完整实现押后。
            this.vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
            return;
        }
        this.vm.movImm(VReg.RET, 0);
    },
};

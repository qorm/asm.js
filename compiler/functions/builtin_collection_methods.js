// asm.js 编译器 - Map/Set/Date 方法编译
// 从 builtin_methods.js 按功能拆出(2026-07-14)。方法经 this 解析,与主 mixin 同一原型。

import { VReg } from "../../vm/index.js";

export const BuiltinCollectionMethodCompiler = {
    // 编译 Map 方法调用
    // obj.set(key, value), obj.get(key), obj.has(key), obj.delete(key), obj.size
    compileMapMethod(obj, method, args) {
        // 先编译 Map 对象
        this.compileExpression(obj);
        this.vm.push(VReg.RET); // 保存 Map 指针

        switch (method) {
            case "set":
                // map.set(key, value)
                if (args.length >= 2) {
                    this.compileExpression(args[1]);
                    this.vm.push(VReg.RET); // 保存 value
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // key
                    this.vm.pop(VReg.A2); // value
                    this.vm.pop(VReg.A0); // map
                    this.vm.call("_map_set");
                    return true;
                }
                break;

            case "get":
                // map.get(key)
                if (args.length >= 1) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // key
                    this.vm.pop(VReg.A0); // map
                    this.vm.call("_map_get");
                    return true;
                }
                break;

            case "has":
                // map.has(key)
                if (args.length >= 1) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // key
                    this.vm.pop(VReg.A0); // map
                    this.vm.call("_map_has");
                    return true;
                }
                break;

            case "delete":
                // map.delete(key)
                if (args.length >= 1) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // key
                    this.vm.pop(VReg.A0); // map
                    this.vm.call("_map_delete");
                    return true;
                }
                break;

            case "size":
                // map.size - 直接从头部读取 length 字段 (统一头部结构 +8)
                this.vm.pop(VReg.RET);
                this.vm.load(VReg.RET, VReg.RET, 8);
                return true;

            case "clear":
                // map.clear() - 走运行时（需同时重置 head/tail 并清零哈希桶数组）
                this.vm.pop(VReg.A0);
                this.vm.call("_map_clear");
                return true;

            case "forEach":
                // map.forEach(cb(value, key, map)) - 编译期回调循环遍历插入序链表
                if (args.length >= 1) {
                    this.compileMapForEach(args[0], args[1]); // map(boxed)已在栈顶
                    return true;
                }
                break;

            case "keys":
                // map.keys() -> 键数组(迭代器实现为真数组,可 for-of/展开/Array.from)
                this.vm.pop(VReg.A0);
                this.vm.call("_map_keys");
                return true;

            case "values":
                // map.values() -> 值数组
                this.vm.pop(VReg.A0);
                this.vm.call("_map_values");
                return true;

            case "entries":
                // map.entries() -> [[k,v]...] 数组
                this.vm.pop(VReg.A0);
                this.vm.call("_map_entries");
                return true;
        }

        this.vm.pop(VReg.RET); // 恢复栈
        return false;
    },

    // Map.forEach:遍历插入序链表(head@16 → node.next@16,以裸 0 结尾),
    // 对每个节点以 (value@8, key@0, map) 调用回调。只读遍历(不改桶/不 rehash),
    // 循环状态存 FP 槽,每轮在调用后重载(调用毁 caller-saved)。进入时 map(boxed)在栈顶。
    compileMapForEach(callbackExpr, thisArgExpr = null) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const mapOffset = this.ctx.allocLocal(`__mapfe_map_${id}`); // boxed map(回调实参 & 遍历基址)
        const curOffset = this.ctx.allocLocal(`__mapfe_cur_${id}`); // 当前裸节点指针
        const cbOffset = this.ctx.allocLocal(`__mapfe_cb_${id}`);

        // map(boxed)在栈顶(compileMapMethod 序言 push)
        vm.pop(VReg.RET);
        vm.store(VReg.FP, mapOffset, VReg.RET);
        // 回调
        this.compileExpression(callbackExpr);
        vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "mapfe");
        // cur = map.head:脱壳裸指针后 load @16
        vm.load(VReg.RET, VReg.FP, mapOffset);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V0, VReg.V0, 16); // head
        vm.store(VReg.FP, curOffset, VReg.V0);

        const loopL = this.ctx.newLabel("mapfe_loop");
        const endL = this.ctx.newLabel("mapfe_end");
        vm.label(loopL);
        vm.load(VReg.V0, VReg.FP, curOffset);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(endL);

        // 加载闭包并 push(与 array.forEach 同序)
        vm.load(VReg.V6, VReg.FP, cbOffset);
        vm.push(VReg.V6);
        // A0 = value(@8),A1 = key(@0),A2 = map(boxed)。arm64 上 V0≡A0≡RET,不能用
        // V0 当节点指针暂存(会覆盖 A0);用 S1(callee 保存,本段本就随 emitClosureCall
        // 一起被视作 scratch),且 A0 最后加载。
        vm.load(VReg.S1, VReg.FP, curOffset); // S1 = 节点裸指针
        vm.load(VReg.A1, VReg.S1, 0);         // key
        vm.load(VReg.A2, VReg.FP, mapOffset); // map(boxed)
        vm.load(VReg.A0, VReg.S1, 8);         // value(A0 最后加载)
        vm.pop(VReg.S0); // 闭包
        this.emitClosureCallAfterSetup();

        // cur = node.next(@16)——调用毁寄存器,从 FP 槽重载节点指针
        vm.load(VReg.V0, VReg.FP, curOffset);
        vm.load(VReg.V0, VReg.V0, 16);
        vm.store(VReg.FP, curOffset, VReg.V0);
        vm.jmp(loopL);
        vm.label(endL);
        vm.movImm(VReg.RET, 0); // forEach 返回 undefined
    },

    // Set.forEach:遍历插入序链表(head@16 → node.next@8,裸 0 结尾),对每个节点
    // 以 (value@0, value@0, set) 调用回调(Set 的 forEach 把 value 传两次)。结构镜像
    // compileMapForEach,唯 Set 节点布局 value@0/next@8(Map 是 key@0/value@8/next@16)。
    compileSetForEach(callbackExpr, thisArgExpr = null) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const setOffset = this.ctx.allocLocal(`__setfe_set_${id}`); // boxed set(回调实参 & 基址)
        const curOffset = this.ctx.allocLocal(`__setfe_cur_${id}`); // 当前裸节点指针
        const cbOffset = this.ctx.allocLocal(`__setfe_cb_${id}`);

        // set(boxed)在栈顶(compileSetMethod 序言 push)
        vm.pop(VReg.RET);
        vm.store(VReg.FP, setOffset, VReg.RET);
        // 回调
        this.compileExpression(callbackExpr);
        vm.store(VReg.FP, cbOffset, VReg.RET);
        this.emitThisArgSlot(thisArgExpr, "setfe");
        // cur = set.head:脱壳后 load @16
        vm.load(VReg.RET, VReg.FP, setOffset);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.V0, VReg.V0, 16); // head
        vm.store(VReg.FP, curOffset, VReg.V0);

        const loopL = this.ctx.newLabel("setfe_loop");
        const endL = this.ctx.newLabel("setfe_end");
        vm.label(loopL);
        vm.load(VReg.V0, VReg.FP, curOffset);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(endL);

        // 加载闭包并 push(与 array/map.forEach 同序)
        vm.load(VReg.V6, VReg.FP, cbOffset);
        vm.push(VReg.V6);
        // A0 = value(@0),A1 = value(同,Set 语义),A2 = set(boxed)。A0≡V0≡RET,故用
        // S1 暂存节点指针、A0 最后加载(同 compileMapForEach 的别名规避)。
        vm.load(VReg.S1, VReg.FP, curOffset); // S1 = 节点裸指针
        vm.load(VReg.A1, VReg.S1, 0);         // value(第二实参)
        vm.load(VReg.A2, VReg.FP, setOffset); // set(boxed)
        vm.load(VReg.A0, VReg.S1, 0);         // value(第一实参,A0 最后加载)
        vm.pop(VReg.S0); // 闭包
        this.emitClosureCallAfterSetup();

        // cur = node.next(@8)——调用毁寄存器,从 FP 槽重载节点指针
        vm.load(VReg.V0, VReg.FP, curOffset);
        vm.load(VReg.V0, VReg.V0, 8);
        vm.store(VReg.FP, curOffset, VReg.V0);
        vm.jmp(loopL);
        vm.label(endL);
        vm.movImm(VReg.RET, 0); // forEach 返回 undefined
    },

    // 编译 Set 方法调用
    // obj.add(value), obj.has(value), obj.delete(value), obj.size
    compileSetMethod(obj, method, args) {
        // 先编译 Set 对象
        this.compileExpression(obj);
        this.vm.push(VReg.RET); // 保存 Set 指针

        switch (method) {
            case "add":
                // set.add(value)
                if (args.length >= 1) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // value
                    this.vm.pop(VReg.A0); // set
                    this.vm.call("_set_add");
                    return true;
                }
                break;

            case "has":
                // set.has(value)
                if (args.length >= 1) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // value
                    this.vm.pop(VReg.A0); // set
                    this.vm.call("_set_has");
                    return true;
                }
                break;

            case "delete":
                // set.delete(value)
                if (args.length >= 1) {
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // value
                    this.vm.pop(VReg.A0); // set
                    this.vm.call("_set_delete");
                    return true;
                }
                break;

            case "size":
                // set.size - 直接从头部读取 length 字段 (统一头部结构 +8)
                this.vm.pop(VReg.RET);
                this.vm.load(VReg.RET, VReg.RET, 8);
                return true;

            case "clear":
                // set.clear()
                this.vm.pop(VReg.A0);
                this.vm.call("_set_clear");
                return true;

            case "forEach":
                // set.forEach(cb(value, value, set)) - 此前无 case → 落通用派发查
                // "forEach" miss → 崩(基础 `set.forEach(v=>...)` 段错误根因)。
                if (args.length >= 1) {
                    this.compileSetForEach(args[0], args[1]); // set(boxed)已在栈顶
                    return true;
                }
                break;

            case "keys":
            case "values":
                // set.keys()/.values() -> 值数组（语义相同）
                this.vm.pop(VReg.A0);
                this.vm.call("_set_values");
                return true;

            case "entries":
                // set.entries() -> [[v,v]...] 数组
                this.vm.pop(VReg.A0);
                this.vm.call("_set_entries");
                return true;

            // ES2025 Set 组合方法：a.<op>(b)，A0=a A1=b
            // 返回新 Set:union/intersection/difference/symmetricDifference
            // 返回布尔:isSubsetOf/isSupersetOf/isDisjointFrom
            // 两端皆经 _set_coerce_arg 品牌守卫(b 可为 Set-like 对象,防 SIGSEGV)。
            case "union":
            case "intersection":
            case "difference":
            case "symmetricDifference":
            case "isSubsetOf":
            case "isSupersetOf":
            case "isDisjointFrom": {
                if (args.length >= 1) {
                    const setCombinatorLabel = {
                        union: "_set_union",
                        intersection: "_set_intersection",
                        difference: "_set_difference",
                        symmetricDifference: "_set_symdiff",
                        isSubsetOf: "_set_issubset",
                        isSupersetOf: "_set_issuperset",
                        isDisjointFrom: "_set_isdisjoint",
                    }[method];
                    // 1) 编译 b,用 _set_coerce_arg 转裸 Set
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A0, VReg.RET);   // A0 = b(候选值)
                    this.vm.call("_set_coerce_arg");    // RET = 裸 Set b
                    this.vm.mov(VReg.A1, VReg.RET);    // A1 = 裸 Set b
                    // 2) 取 a(boxed),用 _set_coerce_arg 转裸 Set;先 push A1 防被 call 毁
                    this.vm.pop(VReg.A0);              // A0 = a(boxed,接收者)
                    this.vm.push(VReg.A1);             // [sp] = 裸 Set b(save across call)
                    this.vm.call("_set_coerce_arg");    // RET = 裸 Set a
                    this.vm.mov(VReg.A0, VReg.RET);    // A0 = 裸 Set a
                    this.vm.pop(VReg.A1);              // A1 = 裸 Set b(restore)
                    this.vm.call(setCombinatorLabel);
                    return true;
                }
                break;
            }
        }

        this.vm.pop(VReg.RET); // 恢复栈
        return false;
    },

    // 编译 Date 方法调用
    // obj.getTime(), obj.toString(), obj.valueOf(), obj.toISOString()
    compileDateMethod(obj, method, args) {
        // [Date 补全] setter 家族(UTC 变体同语义,本运行时全 UTC):
        //   读现 ms → 拆字段 → 替换目标 → 反向历法(civil_to_days)重组 → 写回 → 返回新 ms。
        //   part: 0=year 1=month(0基) 2=date 3=hours 4=minutes 5=seconds 6=ms
        const SETTER_PARTS = {
            setFullYear: 0, setUTCFullYear: 0, setMonth: 1, setUTCMonth: 1,
            setDate: 2, setUTCDate: 2, setHours: 3, setUTCHours: 3,
            setMinutes: 4, setUTCMinutes: 4, setSeconds: 5, setUTCSeconds: 5,
            setMilliseconds: 6, setUTCMilliseconds: 6,
        };
        // 各 setter 的可选后续参数上限(日期族 year/month/date 与时间族 h/m/s/ms
        // 各成一组,不跨组):setFullYear(y,m,d)/setHours(h,mi,s,ms) 等。
        const SETTER_MAX = {
            setFullYear: 3, setUTCFullYear: 3, setMonth: 2, setUTCMonth: 2,
            setDate: 1, setUTCDate: 1, setHours: 4, setUTCHours: 4,
            setMinutes: 3, setUTCMinutes: 3, setSeconds: 2, setUTCSeconds: 2,
            setMilliseconds: 1, setUTCMilliseconds: 1,
        };
        // [Date 加固] 日历族判别界 B(float64 位):|v| > B → 组合必 NaN,fcmp 守 §1.2。
        // year/month 对齐 V8 MakeDay 原始实参范围拒收(|year|≤1e6、|month|≤1e7,见
        // v8/src/date/date.cc kMinYear/kMaxYear/kMinMonth/kMaxMonth)——超界及对消后
        // 落界的由 _date_set_parts 组合后 TimeClip 兜底(如 ym=275303 合法);
        // date 无原值界(MakeDay 仅查 isfinite),1e9 仅防 int64 溢出,clip 兜底。
        const SETTER_MAG_BITS = [
            0x412e848000000000n, // 0 year: 1e6(V8 kMaxYear)
            0x416312d000000000n, // 1 month: 1e7(V8 kMaxMonth)
            0x41cdcd6500000000n, // 2 date: 1e9(int64 界;合法 |d|≤2e8 由 clip 兜底)
            0x4202a05f20000000n, // 3 hours: 1e10(合法 |h|≤4.8e9;int64 界 ~2.5e12)
            0x426d1a94a2000000n, // 4 minutes: 1e12(合法 |mi|≤2.88e11;int64 界 ~1.5e14)
            0x42d6bcc41e900000n, // 5 seconds: 1e14(合法 |s|≤1.728e13;int64 界 ~9.2e15)
            0x4376345785d8a000n, // 6 ms: 1e17(合法 |v|≤1.728e16;int64 界 ~9.2e18)
        ];
        // [Date 加固] 零参 setter(含 setTime):字段缺省 = undefined → ToNumber NaN →
        // timestamp 写 canonical NaN(0x7ff0…01,同 _dp_invalid)并返回 NaN——对齐 aref 路
        // _aref_date_sp* 零参语义(count 按 1、arg0=padded undefined → _nan 支路)。
        // 此前 args.length>=1 门把零参漏到通用对象方法调用:静态接收者野扫/取到 undefined
        // 再调用,unknown 接收者 emitTagDispatchMethod type-7 分支静默错值。
        if ((method in SETTER_PARTS || method === "setTime") && args.length === 0) {
            this.compileExpression(obj); // RET = date(装箱 0x7ffd)
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.A0, VReg.RET, VReg.V1); // 裸 date 指针(RET==A0 别名,同 setTime 路)
            this.vm.movImm64(VReg.V1, 0x7ff0000000000001n); // canonical NaN
            this.vm.store(VReg.A0, 8, VReg.V1); // [[DateValue]] = NaN
            this.vm.mov(VReg.RET, VReg.V1); // RET = NaN(number)
            return true;
        }
        if (method in SETTER_PARTS && args.length >= 1) {
            const part = SETTER_PARTS[method];
            const count = Math.min(args.length, SETTER_MAX[method]);
            if (count === 1) {
                // 单字段:沿用 _date_set_part(与既有 codegen 一致)
                const id = this.nextLabelId();
                const nanLbl = this.ctx.newLabel("dset_nan");
                const okLbl = this.ctx.newLabel("dset_ok");
                const invLbl = part !== 0 ? this.ctx.newLabel("dset_inv") : null;
                this.compileExpression(obj); // RET = date(boxed)
                // [Date 加固] Invalid 接收者预检(镜像 aref _aref_date_sp* 的 S2 语义):
                // part 1..6 强转前读 t,指数全 1 → 标志=1;强转照做(保副作用),统一分流
                // RET=NaN【不写回】(valueOf 内 setTime 修复的 [[DateValue]] 必须保留)。
                // part=0(setFullYear 族)NaN→+0 重组例外,不预检(_date_set_part 内
                // fcvtzs(NaN)=0 → 纪元字段天然满足,与 aref/红队顺序矩阵一致)。
                let invOff = 0;
                if (part !== 0) {
                    const freshLbl = this.ctx.newLabel("dset_fresh");
                    invOff = this.ctx.allocLocal(`__dset_inv_${id}`);
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V2, VReg.RET, VReg.V1); // V2 = 裸 ptr(x64 V2==A2,此处无活值;RET 保留)
                    this.vm.load(VReg.V2, VReg.V2, 8); // V2 = ts 位
                    this.vm.shrImm(VReg.V1, VReg.V2, 52);
                    this.vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                    this.vm.movImm(VReg.V2, 0);
                    this.vm.store(VReg.FP, invOff, VReg.V2); // invalidBefore = 0
                    this.vm.cmpImm(VReg.V1, 0x7ff);
                    this.vm.jne(freshLbl);
                    this.vm.movImm(VReg.V1, 1);
                    this.vm.store(VReg.FP, invOff, VReg.V1); // invalidBefore = 1
                    this.vm.label(freshLbl);
                }
                this.vm.push(VReg.RET); // 保存 date 值
                this.compileExpression(args[0]);
                this.emitNumberCoerceFast(); // RET = 裸 float 位
                // [Date 加固] NaN/±Inf(指数全 1)判别:此前直接 fcvtzs,NaN→0 静默当 0 写、
                // ±Inf→INT64_MAX 饱和;规范 → timestamp 写 canonical NaN 并返回 NaN
                // (同 aref 路 _aref_date_sp* _nan 支路;位提取等值判别是既有惯例,
                // 见 _date_toString:266-269,不触 §1.2 的 float 位序整数排序禁令)。
                this.vm.shrImm(VReg.V1, VReg.RET, 52);
                this.vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                this.vm.cmpImm(VReg.V1, 0x7ff);
                this.vm.jeq(nanLbl);
                // [Date 加固] 巨大有限值量纲判别:|v| > B[part] 组合必 NaN(fcmp 守 §1.2;
                // 组合后 TimeClip 对 int64 溢出/饱和值不可达,故转换前按量纲前置判别)。
                this.vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
                this.vm.and(VReg.V1, VReg.RET, VReg.V1); // V1 = |v| 位(x64 V1==A3,A3 无活值)
                this.vm.movImm64(VReg.V2, SETTER_MAG_BITS[part]); // B(x64 V2==A2,A2 下方才接 fcvtzs 结果)
                this.vm.fmovToFloat(0, VReg.V1);
                this.vm.fmovToFloat(1, VReg.V2);
                this.vm.fcmp(0, 1);
                this.vm.jfgt(nanLbl);
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.fcvtzs(VReg.A2, 0); // A2 = int 值
                if (part !== 0) {
                    // 强转完毕;强转前已 Invalid → RET=NaN 不写回(保 valueOf 修复)
                    this.vm.load(VReg.V0, VReg.FP, invOff);
                    this.vm.cmpImm(VReg.V0, 0);
                    this.vm.jne(invLbl);
                }
                this.vm.pop(VReg.A0); // date 值
                this.vm.movImm(VReg.A1, part);
                this.vm.call("_date_set_part"); // RET = 新 ms(裸 float number)
                this.vm.jmp(okLbl);
                this.vm.label(nanLbl);
                this.vm.pop(VReg.A0); // date 值
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1); // 裸 date 指针
                this.vm.movImm64(VReg.V1, 0x7ff0000000000001n); // canonical NaN(同 _dp_invalid)
                this.vm.store(VReg.A0, 8, VReg.V1);
                this.vm.mov(VReg.RET, VReg.V1);
                this.vm.jmp(okLbl);
                if (part !== 0) {
                    this.vm.label(invLbl);
                    this.vm.pop(VReg.V0); // 平衡栈(date 废弃;不写回)
                    this.vm.movImm64(VReg.RET, 0x7ff0000000000001n); // RET = NaN
                }
                this.vm.label(okLbl);
                return true;
            }
            // 多字段时间族(part 3..5:setHours/setMinutes/setSeconds 及 UTC 变体):
            // float 域组合(spec MakeTime/MakeDate/TimeClip 字面,经 _date_set_time_f64;
            // 复现 V8 FMA 收缩序,跨字段对消/巨大值与 node 逐位一致——独立量纲门会
            // 误杀对消合法值,已废)。逐参 ToNumber 落 f64 位槽(ToInteger 由 helper 逐参
            // 做),Invalid 接收者预检同单字段路(镜像 aref S2:返 NaN 不写回)。
            if (part >= 3) {
                const id = this.nextLabelId();
                const okLbl = this.ctx.newLabel("dset_ok");
                const invLbl = this.ctx.newLabel("dset_inv");
                this.compileExpression(obj); // RET = date(boxed)
                const invOff = this.ctx.allocLocal(`__dset_inv_${id}`);
                {
                    const freshLbl = this.ctx.newLabel("dset_fresh");
                    this.vm.emitMaskLoad(VReg.V1);
                    this.vm.andMaskReg(VReg.V2, VReg.RET, VReg.V1); // V2 = 裸 ptr(RET 保留)
                    this.vm.load(VReg.V2, VReg.V2, 8); // V2 = ts 位
                    this.vm.shrImm(VReg.V1, VReg.V2, 52);
                    this.vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                    this.vm.movImm(VReg.V2, 0);
                    this.vm.store(VReg.FP, invOff, VReg.V2); // invalidBefore = 0
                    this.vm.cmpImm(VReg.V1, 0x7ff);
                    this.vm.jne(freshLbl);
                    this.vm.movImm(VReg.V1, 1);
                    this.vm.store(VReg.FP, invOff, VReg.V1); // invalidBefore = 1
                    this.vm.label(freshLbl);
                }
                this.vm.push(VReg.RET); // 保存 date(boxed)
                const bufOffs = [];
                for (let i = 0; i < count; i++) {
                    bufOffs.push(this.ctx.allocLocal(`__dset_buf${i}_${id}`));
                }
                // 全部实参按序求值+ToNumber 落 f64 位槽(副作用保序,与 node 一致)
                for (let i = 0; i < count; i++) {
                    this.compileExpression(args[i]);
                    this.emitNumberCoerceFast(); // RET = 裸 float 位
                    this.vm.store(VReg.FP, bufOffs[count - 1 - i], VReg.RET); // values[i] 落最低+i*8
                }
                // 强转完毕;强转前已 Invalid → RET=NaN 不写回(保 valueOf 修复)
                this.vm.load(VReg.V0, VReg.FP, invOff);
                this.vm.cmpImm(VReg.V0, 0);
                this.vm.jne(invLbl);
                // A3 = valuesPtr = FP + bufOffs[count-1](最低槽);用寄存器减法避免大立即数
                this.vm.movImm(VReg.A3, -bufOffs[count - 1]);
                this.vm.sub(VReg.A3, VReg.FP, VReg.A3);
                this.vm.pop(VReg.A0); // date(boxed)
                this.vm.movImm(VReg.A1, part);   // startPart
                this.vm.movImm(VReg.A2, count);  // count
                this.vm.call("_date_set_time_f64"); // RET = 新 ms(number)
                this.vm.jmp(okLbl);
                this.vm.label(invLbl);
                this.vm.pop(VReg.V0); // 平衡栈(date 废弃;不写回)
                this.vm.movImm64(VReg.RET, 0x7ff0000000000001n); // RET = NaN
                this.vm.label(okLbl);
                return true;
            }
            // 多字段日历族(part 0..1:setFullYear/setMonth 及 UTC 变体):原子写。
            // 逐参转 int 存入连续 FP 槽(allocLocal 地址递减,
            // 故 values[i](part+i)存到 bufOffs[count-1-i]),再传 valuesPtr=最低槽地址。
            // (node 的 MakeDay 对原始 year/month 实参自带范围拒收——实证 |y|>1e6 或
            // |m|>1e7 及对消极大值全 NaN——故日历族独立量纲门安全,保留。)
            const id = this.nextLabelId();
            const mNanLbl = this.ctx.newLabel("dset_nan");
            const mOkLbl = this.ctx.newLabel("dset_ok");
            const mInvLbl = part !== 0 ? this.ctx.newLabel("dset_inv") : null;
            this.compileExpression(obj); // RET = date(boxed)
            // [Date 加固] Invalid 接收者预检(同单字段路,镜像 aref S2):part 1..6
            // 强转前读 t,指数全 1 → 标志=1;全部实参仍按序求值强转(副作用保序),
            // 统一分流 RET=NaN【不写回】。part=0 例外不预检(NaN→+0 重组)。
            let minvOff = 0;
            if (part !== 0) {
                const mFreshLbl = this.ctx.newLabel("dset_fresh");
                minvOff = this.ctx.allocLocal(`__dset_inv_${id}`);
                this.vm.emitMaskLoad(VReg.V1);
                this.vm.andMaskReg(VReg.V2, VReg.RET, VReg.V1); // V2 = 裸 ptr(RET 保留)
                this.vm.load(VReg.V2, VReg.V2, 8); // V2 = ts 位
                this.vm.shrImm(VReg.V1, VReg.V2, 52);
                this.vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                this.vm.movImm(VReg.V2, 0);
                this.vm.store(VReg.FP, minvOff, VReg.V2); // invalidBefore = 0
                this.vm.cmpImm(VReg.V1, 0x7ff);
                this.vm.jne(mFreshLbl);
                this.vm.movImm(VReg.V1, 1);
                this.vm.store(VReg.FP, minvOff, VReg.V1); // invalidBefore = 1
                this.vm.label(mFreshLbl);
            }
            this.vm.push(VReg.RET); // 保存 date(boxed)
            const bufOffs = [];
            for (let i = 0; i < count; i++) {
                bufOffs.push(this.ctx.allocLocal(`__dset_buf${i}_${id}`));
            }
            // [Date 加固] NaN/±Inf(指数全 1)与巨大有限值(|v| > B[part+i],fcmp 守 §1.2)
            // 判别不短路:全部实参先按序求值+强转落槽(副作用保序,与 node 一致——先求值
            // 全部实参再判定),命中仅置标志,循环后统一分流:写 canonical NaN 返 NaN
            // (值轴与单字段路一致)。
            const nanOff = this.ctx.allocLocal(`__dset_nan_${id}`);
            this.vm.movImm(VReg.V0, 0);
            this.vm.store(VReg.FP, nanOff, VReg.V0); // argNaN = 0
            for (let i = 0; i < count; i++) {
                const argNan2Lbl = this.ctx.newLabel("dset_argnan");
                const argOkLbl = this.ctx.newLabel("dset_argok");
                this.compileExpression(args[i]);
                this.emitNumberCoerceFast(); // RET = 裸 float 位
                this.vm.shrImm(VReg.V1, VReg.RET, 52);
                this.vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                this.vm.cmpImm(VReg.V1, 0x7ff);
                this.vm.jeq(argNan2Lbl); // NaN/±Inf(指数全 1)
                // 巨大有限值量纲判别:B[part+i](arg i 对应字段 part+i)
                this.vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
                this.vm.and(VReg.V1, VReg.RET, VReg.V1); // V1 = |v| 位(x64 V1==A3,A3 无活值)
                this.vm.movImm64(VReg.V2, SETTER_MAG_BITS[part + i]); // (x64 V2==A2,循环内无活值)
                this.vm.fmovToFloat(0, VReg.V1);
                this.vm.fmovToFloat(1, VReg.V2);
                this.vm.fcmp(0, 1);
                this.vm.jfgt(argNan2Lbl);
                this.vm.jmp(argOkLbl);
                this.vm.label(argNan2Lbl);
                this.vm.movImm(VReg.V1, 1);
                this.vm.store(VReg.FP, nanOff, VReg.V1); // argNaN = 1(不跳出循环)
                this.vm.label(argOkLbl);
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.fcvtzs(VReg.V0, 0); // V0 = int 值(NaN→0;标志命中时槽值不被使用)
                this.vm.store(VReg.FP, bufOffs[count - 1 - i], VReg.V0); // values[i] 落最低+i*8
            }
            // 全部实参求值强转完毕,统一判别:任一位 NaN/±Inf/超界 → 写 NaN 返 NaN
            this.vm.load(VReg.V0, VReg.FP, nanOff);
            this.vm.cmpImm(VReg.V0, 0);
            this.vm.jne(mNanLbl);
            if (part !== 0) {
                // 强转前已 Invalid → RET=NaN 不写回(保 valueOf 修复)
                this.vm.load(VReg.V0, VReg.FP, minvOff);
                this.vm.cmpImm(VReg.V0, 0);
                this.vm.jne(mInvLbl);
            }
            // A3 = valuesPtr = FP + bufOffs[count-1](最低槽);用寄存器减法避免大立即数
            this.vm.movImm(VReg.A3, -bufOffs[count - 1]);
            this.vm.sub(VReg.A3, VReg.FP, VReg.A3);
            this.vm.pop(VReg.A0); // date(boxed)
            this.vm.movImm(VReg.A1, part);   // startPart
            this.vm.movImm(VReg.A2, count);  // count
            this.vm.call("_date_set_parts"); // RET = 新 ms(裸 float number)
            this.vm.jmp(mOkLbl);
            this.vm.label(mNanLbl);
            this.vm.pop(VReg.A0); // date(boxed)
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1); // 裸 date 指针
            this.vm.movImm64(VReg.V1, 0x7ff0000000000001n); // canonical NaN(同 _dp_invalid)
            this.vm.store(VReg.A0, 8, VReg.V1);
            this.vm.mov(VReg.RET, VReg.V1);
            this.vm.jmp(mOkLbl);
            if (part !== 0) {
                this.vm.label(mInvLbl);
                this.vm.pop(VReg.V0); // 平衡栈(date 废弃;不写回)
                this.vm.movImm64(VReg.RET, 0x7ff0000000000001n); // RET = NaN
            }
            this.vm.label(mOkLbl);
            return true;
        }
        // setTime(ms):ToNumber + TimeClip(镜像 aref 路 _aref_date_setTime):
        // NaN/±Inf(指数全 1)或 |v| > 8.64e15(fcmp 比较,守 §1.2 不用整数比 float 位)
        // → 写 canonical NaN 返 NaN;否则向零截断(-0→+0)写回并返回新 ms。
        // 注意 RET==A0==V0==X0 别名:coerce 后的值须先存 A2(=X2),再 pop A0 取 date,
        // 否则 pop 会覆盖 X0 里的新 timestamp,反把 date 指针写进去。
        if (method === "setTime" && args.length >= 1) {
            const stNanLbl = this.ctx.newLabel("stime_nan");
            const stOkLbl = this.ctx.newLabel("stime_ok");
            this.compileExpression(obj);
            this.vm.push(VReg.RET);
            this.compileExpression(args[0]);
            this.emitNumberCoerceFast(); // RET = 裸 float 位(= 新 timestamp)
            this.vm.shrImm(VReg.V1, VReg.RET, 52);
            this.vm.andImm(VReg.V1, VReg.V1, 0x7ff);
            this.vm.cmpImm(VReg.V1, 0x7ff);
            this.vm.jeq(stNanLbl);
            this.vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
            this.vm.and(VReg.V2, VReg.RET, VReg.V1); // V2 = |v| 位(x64 V2==A2,A2 无活值)
            this.vm.movImm64(VReg.V1, 0x433eb208c2dc0000n); // 8.64e15
            this.vm.fmovToFloat(0, VReg.V2);
            this.vm.fmovToFloat(1, VReg.V1);
            this.vm.fcmp(0, 1);
            this.vm.jfgt(stNanLbl);
            this.vm.fmovToFloat(0, VReg.RET);
            this.vm.fcvtzs(VReg.A2, 0); // 向零截断(x64 A2==V2,覆写无妨)
            this.vm.scvtf(0, VReg.A2);
            this.vm.fmovToInt(VReg.A2, 0); // A2 = 截断后 ms 位(避开 X0 别名)
            this.vm.jmp(stOkLbl);
            this.vm.label(stNanLbl);
            this.vm.movImm64(VReg.A2, 0x7ff0000000000001n); // canonical NaN(同 _dp_invalid)
            this.vm.label(stOkLbl);
            this.vm.pop(VReg.A0); // date 值
            this.vm.emitMaskLoad(VReg.V1);
            this.vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1); // 裸 date 指针
            this.vm.store(VReg.A0, 8, VReg.A2); // 写回 timestamp
            this.vm.mov(VReg.RET, VReg.A2); // 返回新 ms
            return true;
        }

        // 先编译 Date 对象
        this.compileExpression(obj);
        this.vm.mov(VReg.A0, VReg.RET);

        switch (method) {
            case "getTime":
            case "valueOf":
                // date.getTime() / date.valueOf()
                this.vm.call("_date_getTime");
                return true;

            case "toString":
                // date.toString()
                this.vm.call("_date_toString");
                return true;

            case "toISOString":
            case "toJSON":
                // date.toISOString() / date.toJSON() - 输出 ISO 8601 格式
                this.vm.call("_date_toISOString");
                return true;

            case "getTimezoneOffset":
                // UTC 近似:恒返回 0(记偏差)
                this.vm.movImm(VReg.RET, 0);
                this.boxIntAsNumber(VReg.RET);
                return true;

            case "getMilliseconds":
            case "getUTCMilliseconds":
                this.vm.movImm(VReg.A1, 7);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;

            // [#35] 历法 getter 家族(原无分派无运行时,落通用路径崩溃)。
            // UTC 语义;part: 0=year 1=month(0基) 2=day 3=hours 4=minutes
            // 5=seconds 6=day-of-week
            case "getFullYear":
            case "getUTCFullYear":
                this.vm.movImm(VReg.A1, 0);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
            case "getMonth":
            case "getUTCMonth":
                this.vm.movImm(VReg.A1, 1);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
            case "getDate":
            case "getUTCDate":
                this.vm.movImm(VReg.A1, 2);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
            case "getHours":
            case "getUTCHours":
                this.vm.movImm(VReg.A1, 3);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
            case "getMinutes":
            case "getUTCMinutes":
                this.vm.movImm(VReg.A1, 4);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
            case "getSeconds":
            case "getUTCSeconds":
                this.vm.movImm(VReg.A1, 5);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
            case "getDay":
            case "getUTCDay":
                this.vm.movImm(VReg.A1, 6);
                this.vm.call("_date_get_part_num"); // Invalid → canonical NaN;否则裸 int 装箱 number
                return true;
        }

        return false;
    },
};

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
                    this.compileExpression(args[0]);
                    this.vm.mov(VReg.A1, VReg.RET); // b(另一个 Set)
                    this.vm.pop(VReg.A0);           // a(this Set)
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
        if (method in SETTER_PARTS && args.length >= 1) {
            const part = SETTER_PARTS[method];
            const count = Math.min(args.length, SETTER_MAX[method]);
            if (count === 1) {
                // 单字段:沿用 _date_set_part(与既有 codegen 一致)
                this.compileExpression(obj);
                this.vm.push(VReg.RET); // 保存 date 值
                this.compileExpression(args[0]);
                this.emitNumberCoerceFast(); // RET = 裸 float 位
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.fcvtzs(VReg.A2, 0); // A2 = int 值
                this.vm.pop(VReg.A0); // date 值
                this.vm.movImm(VReg.A1, part);
                this.vm.call("_date_set_part"); // RET = 新 ms(裸 float number)
                return true;
            }
            // 多字段:原子写。逐参转 int 存入连续 FP 槽(allocLocal 地址递减,
            // 故 values[i](part+i)存到 bufOffs[count-1-i]),再传 valuesPtr=最低槽地址。
            const id = this.nextLabelId();
            this.compileExpression(obj);
            this.vm.push(VReg.RET); // 保存 date(boxed)
            const bufOffs = [];
            for (let i = 0; i < count; i++) {
                bufOffs.push(this.ctx.allocLocal(`__dset_buf${i}_${id}`));
            }
            for (let i = 0; i < count; i++) {
                this.compileExpression(args[i]);
                this.emitNumberCoerceFast(); // RET = 裸 float 位
                this.vm.fmovToFloat(0, VReg.RET);
                this.vm.fcvtzs(VReg.V0, 0); // V0 = int 值
                this.vm.store(VReg.FP, bufOffs[count - 1 - i], VReg.V0); // values[i] 落最低+i*8
            }
            // A3 = valuesPtr = FP + bufOffs[count-1](最低槽);用寄存器减法避免大立即数
            this.vm.movImm(VReg.A3, -bufOffs[count - 1]);
            this.vm.sub(VReg.A3, VReg.FP, VReg.A3);
            this.vm.pop(VReg.A0); // date(boxed)
            this.vm.movImm(VReg.A1, part);   // startPart
            this.vm.movImm(VReg.A2, count);  // count
            this.vm.call("_date_set_parts"); // RET = 新 ms(裸 float number)
            return true;
        }
        // setTime(ms):直接写 timestamp,返回 ms
        // 注意 RET==A0==V0==X0 别名:coerce 后的值须先存 A2(=X2),再 pop A0 取 date,
        // 否则 pop 会覆盖 X0 里的新 timestamp,反把 date 指针写进去。
        if (method === "setTime" && args.length >= 1) {
            this.compileExpression(obj);
            this.vm.push(VReg.RET);
            this.compileExpression(args[0]);
            this.emitNumberCoerceFast(); // RET = 裸 float 位(= 新 timestamp)
            this.vm.mov(VReg.A2, VReg.RET); // A2 = 新 ms(避开 X0 别名)
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
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;

            // [#35] 历法 getter 家族(原无分派无运行时,落通用路径崩溃)。
            // UTC 语义;part: 0=year 1=month(0基) 2=day 3=hours 4=minutes
            // 5=seconds 6=day-of-week
            case "getFullYear":
            case "getUTCFullYear":
                this.vm.movImm(VReg.A1, 0);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
            case "getMonth":
            case "getUTCMonth":
                this.vm.movImm(VReg.A1, 1);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
            case "getDate":
            case "getUTCDate":
                this.vm.movImm(VReg.A1, 2);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
            case "getHours":
            case "getUTCHours":
                this.vm.movImm(VReg.A1, 3);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
            case "getMinutes":
            case "getUTCMinutes":
                this.vm.movImm(VReg.A1, 4);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
            case "getSeconds":
            case "getUTCSeconds":
                this.vm.movImm(VReg.A1, 5);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
            case "getDay":
            case "getUTCDay":
                this.vm.movImm(VReg.A1, 6);
                this.vm.call("_date_get_part");
                this.boxIntAsNumber(VReg.RET);
                return true;
        }

        return false;
    },
};

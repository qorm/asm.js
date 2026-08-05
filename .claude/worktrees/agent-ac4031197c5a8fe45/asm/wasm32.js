// asm.js WebAssembly (wasm32) 汇编器
// 与 ARM64Assembler/X64Assembler 同一契约:code/labels/data/addString/addDataLabel/
// addDataQword/addFloat64/finalize/fixupAll。code 是"巨函数"体的裸 wasm 指令流,
// 标签按定义顺序获得 pc 序号;跳转/调用发射 padded-LEB 占位立即数,fixupAll 统一回填
// (pc 序号 / br 深度 / lea 绝对地址)。控制流骨架(loop+block×N+br_table)由
// binary/wasm.js 在段拼装时包裹,故所有回填都是"值补丁",拼装不移位。
// 设计详见 docs/WASM_DESIGN.md。

// 代码地址空间基址:lea(代码标签) = WASM_CODE_BASE + 标签序号。
// 与 vm.ptrFloor(wasi)=0x400000 对齐:闭包里的函数指针 >= ptrFloor,合法性判定成立。
export const WASM_CODE_BASE = 0x400000;

export class Wasm32Assembler {
    constructor() {
        this.code = [];
        this.data = [];
        this.dataSection = this.data; // PE/COFF 路径别名,wasm 不用但保契约
        this.labels = new Map();
        this.labelAliases = new Map();
        this.labelPrefix = "";

        // 代码标签(定义序 == 偏移序;code.length 单调)
        this._codeLabelNames = [];
        this._codeLabelOffs = [];
        this._codeLabelSet = new Set();

        // 数据段(与 arm64.js 同构)
        this.strings = [];
        this._stringInternMap = new Map();
        this.dataLabels = [];
        this.floats = new Map();
        this._dataLabelSet = new Set();

        // 回填记录:{ type: "pc"|"a64"|"br", offset, label, extra }
        this.pendingFixups = [];

        // 生成器契约字段
        this.codeVAddr = 0;
        this.dataVAddr = 0;
        this.externalSymbolList = [];
        this.undefinedSymbolList = [];
        this.branchRelocations = [];
        this.iatRelocations = [];

        // call 返回标签计数
        this._retCounter = 0;

        // [M3] 段大小(每段标签数,均匀切分 → 蹦床按 pc/segSize 常数除法路由)。
        // 缺省 256:实测扫 128/256/384/512/1024,256 全面最优(小段 Turbofan 编得动
        // 且编得好;大段撞优化崖,1024 起全面劣化)。ASMJS_WASM_SEG 仅供 node 驱动的
        // 实验(编译产物 env 恒空 → 恒走缺省,gen1/自举产物字节一致)。
        let seg = 256;
        if (typeof process !== "undefined" && process.env && process.env.ASMJS_WASM_SEG) {
            const n = Number(process.env.ASMJS_WASM_SEG);
            if (n > 0) seg = n;
        }
        this.segSize = seg;

        // br/br_if 深度立即数的定长占位宽度。深度 = 段内到派发 loop 的层数,恒
        // ≤ segSize-1+extra(段最多 segSize 个标签)——由编译期常量 segSize 封顶,
        // 与 pc 标签序号(可达数十万,须 5 字节)截然不同。故按 segSize 自适应取
        // 刚好够用的 uleb 宽度(缺省 256 → 2 字节),替代恒 5 字节占位,每条 br/br_if
        // 省 ~3 字节。gen1 恒走缺省 segSize=256 → brPadBytes=2,确定性不变。
        this.brPadBytes = this._ulebLen(this.segSize + 2);
        if (this.brPadBytes < 1) this.brPadBytes = 1;
    }

    // uleb128 编码 v(u32)所需字节数
    _ulebLen(v) {
        let n = v >>> 0;
        let len = 0;
        do {
            len = len + 1;
            n = n >>> 7;
        } while (n !== 0);
        return len;
    }

    offset() {
        return this.code.length;
    }

    // ==================== 基础发射 ====================

    emit(b) {
        this.code.push(b & 0xff);
    }

    emitBytes(arr) {
        for (let i = 0; i < arr.length; i = i + 1) {
            this.code.push(arr[i] & 0xff);
        }
    }

    // 无符号 LEB128(u32 范围)
    uleb(v) {
        let n = v >>> 0;
        while (true) {
            let b = n & 0x7f;
            n = n >>> 7;
            if (n !== 0) {
                this.code.push(b | 0x80);
            } else {
                this.code.push(b);
                break;
            }
        }
    }

    // 有符号 LEB128(接受 number 或 BigInt;64 位范围)。
    // 【gen1 语义护栏】自举运行时的 BigInt 是 64 位补码位型:无符号大数比较(> 2^63-1
    // 判假)、产生负数的减法、与计算负数的 === 都不可靠(实测)。故:
    //   • 32 位整数走纯 number 路径(number 语义 gen1 可靠);
    //   • 其余一律定长 10 字节 sleb64(padded 编码合法),按"位型 + 显式符号填充"
    //     逐段提取,只用 & / >> / | / 与小字面量的 ===,两种运行时逐位一致。
    sleb(v) {
        if (typeof v === "number" && (v | 0) === v) {
            let n = v | 0;
            let more = true;
            while (more) {
                let b = n & 0x7f;
                n = n >> 7;
                const signBit = (b & 0x40) !== 0;
                if ((n === 0 && !signBit) || (n === -1 && signBit)) {
                    more = false;
                } else {
                    b = b | 0x80;
                }
                this.code.push(b);
            }
            return;
        }
        const off = this.code.length;
        for (let i = 0; i < 10; i = i + 1) {
            this.code.push(0);
        }
        this.patchSleb64(off, v);
    }

    // 5 字节 padded 占位(uleb/sleb 通用,值 0)。返回占位起始偏移。
    emitPad5() {
        const off = this.code.length;
        this.code.push(0x80);
        this.code.push(0x80);
        this.code.push(0x80);
        this.code.push(0x80);
        this.code.push(0x00);
        return off;
    }

    // n 字节 padded 占位(uleb,值 0)。返回占位起始偏移。
    emitPadN(n) {
        const off = this.code.length;
        for (let i = 0; i < n - 1; i = i + 1) {
            this.code.push(0x80);
        }
        this.code.push(0x00);
        return off;
    }

    // 10 字节 padded 占位(sleb64,值 0)。返回占位起始偏移。
    emitPad10() {
        const off = this.code.length;
        for (let i = 0; i < 9; i = i + 1) {
            this.code.push(0x80);
        }
        this.code.push(0x00);
        return off;
    }

    // ==================== 回填补丁 ====================

    patchSleb32(off, v) {
        let n = v | 0;
        for (let i = 0; i < 4; i = i + 1) {
            this.code[off + i] = (n & 0x7f) | 0x80;
            n = n >> 7;
        }
        this.code[off + 4] = n & 0x7f;
    }

    patchUleb32(off, v) {
        let n = v >>> 0;
        for (let i = 0; i < 4; i = i + 1) {
            this.code[off + i] = (n & 0x7f) | 0x80;
            n = n >>> 7;
        }
        this.code[off + 4] = n & 0x7f;
    }

    // 定长 w 字节 uleb 写入(非最小编码合法;w<5 时 v 必须落在其表示范围内)
    patchUlebN(off, v, w) {
        let n = v >>> 0;
        for (let i = 0; i < w - 1; i = i + 1) {
            this.code[off + i] = (n & 0x7f) | 0x80;
            n = n >>> 7;
        }
        this.code[off + w - 1] = n & 0x7f;
    }

    // 定长 w 字节 sleb 写入(见 sleb 的 gen1 语义护栏注释):
    // 位型逐 7 位提取,每次移位后砍掉高 7 位再按符号位显式回填——
    // 无论宿主 BigInt >> 是算术还是逻辑语义,结果逐位一致。
    // w<10 时 v 须落在 w*7 位有符号范围内(调用方保证:wasm32 地址恒 < 2³² < 2³⁴,
    // 5 字节=35 位有符号足容,故 a64 地址占位用 w=5)。
    patchSlebW(off, v, w) {
        let big = (typeof v === "bigint" ? v : BigInt(v)) & 0xffffffffffffffffn;
        const sign = (big >> 63n) & 1n;
        for (let i = 0; i < w - 1; i = i + 1) {
            this.code[off + i] = Number(big & 0x7fn) | 0x80;
            big = (big >> 7n) & 0x01ffffffffffffffn;
            if (sign === 1n) {
                big = big | 0xfe00000000000000n;
            }
        }
        this.code[off + w - 1] = Number(big & 0x7fn);
    }

    patchSleb64(off, v) {
        this.patchSlebW(off, v, 10);
    }

    // ==================== 标签 ====================

    _fullLabelName(name) {
        if (name.charAt(0) !== "_") {
            return this.labelPrefix + name;
        }
        return name;
    }

    label(name) {
        const fullName = this._fullLabelName(name);
        this.labels.set(fullName, this.code.length);
        this._codeLabelNames.push(fullName);
        this._codeLabelOffs.push(this.code.length);
        this._codeLabelSet.add(fullName);
    }

    resolveLabel(name) {
        let resolved = name;
        let iterations = 0;
        const maxIterations = 16;
        while (this.labelAliases.get(resolved) && iterations < maxIterations) {
            resolved = this.labelAliases.get(resolved);
            iterations = iterations + 1;
        }
        return resolved;
    }

    // 生成唯一 call 返回标签名
    nextReturnLabel() {
        const n = this._retCounter;
        this._retCounter = n + 1;
        return "_wret" + n;
    }

    // 记录一个跳转/调用目标的 pc 序号占位(i32.const 的立即数位置)
    addPcFixup(labelName) {
        const off = this.emitPad5();
        this.pendingFixups.push({ type: "pc", offset: off, label: this._fullLabelName(labelName), extra: 0 });
    }

    // 记录一个绝对地址占位(i64.const:数据段地址或 CODE_BASE+序号)。所有 wasm32
    // 地址恒 < 2³²(4GB 线性内存 + CODE_BASE+序号),用 5 字节 sleb(35 位有符号)即足,
    // 非满 10 字节 —— 由 wasm32 32 位地址空间硬不变式封顶,与 pc/br 窄化同理。
    addAbs64Fixup(labelName) {
        const off = this.emitPad5();
        this.pendingFixups.push({ type: "a64", offset: off, label: this._fullLabelName(labelName), extra: 0 });
    }

    // 记录一个 br 深度占位。extra = 发射点相对段顶层的额外嵌套层数(if 内 +1)。
    // 深度由 segSize 封顶 → 用自适应窄占位(brPadBytes),而非 pc 序号的 5 字节。
    addBrDepthFixup(extra) {
        const off = this.emitPadN(this.brPadBytes);
        this.pendingFixups.push({ type: "br", offset: off, label: "", extra: extra });
    }

    // ==================== 数据段(与 arm64.js 同构) ====================

    registerRuntimeString(runtimeLabel, value) {
        if (this._stringInternMap.has(value)) {
            const labelIndex = this._stringInternMap.get(value);
            const actualLabel = "_str_" + labelIndex;
            this.labelAliases.set(runtimeLabel, actualLabel);
            return;
        }
        const labelIndex = this.strings.length;
        const actualLabel = "_str_" + labelIndex;
        this.strings.push(value);
        this._stringInternMap.set(value, labelIndex);
        this.labelAliases.set(runtimeLabel, actualLabel);
    }

    addString(str) {
        if (this._stringInternMap.has(str)) {
            const labelIndex = this._stringInternMap.get(str);
            return "_str_" + labelIndex;
        }
        const labelIndex = this.strings.length;
        const labelName = "_str_" + labelIndex;
        this.strings.push(str);
        this._stringInternMap.set(str, labelIndex);
        return labelName;
    }

    addDataLabel(name) {
        this.dataLabels.push({ name: name, offset: -1 });
    }

    addDataByte(value) {
        if (this.dataLabels.length > 0) {
            const lastLabel = this.dataLabels[this.dataLabels.length - 1];
            if (lastLabel.offset === -1) {
                lastLabel.offset = this.data.length;
            }
        }
        this.data.push(value & 255);
    }

    addDataQword(value) {
        const misalign = this.data.length & 7;
        if (misalign !== 0) {
            const pad = 8 - misalign;
            for (let i = 0; i < pad; i = i + 1) {
                this.data.push(0);
            }
        }
        if (this.dataLabels.length > 0) {
            const lastLabel = this.dataLabels[this.dataLabels.length - 1];
            if (lastLabel.offset === -1) {
                lastLabel.offset = this.data.length;
            }
        }
        let val = BigInt(value);
        for (let i = 0; i < 8; i = i + 1) {
            this.data.push(Number(val & 0xffn));
            val = val >> 8n;
        }
    }

    addFloat64(value, bits) {
        let b = bits;
        const bytes = [];
        for (let i = 0; i < 8; i = i + 1) {
            bytes.push(Number(b & 0xffn));
            b = b >> 8n;
        }
        const key = bytes.join(",");
        if (this.floats.has(key)) {
            return this.floats.get(key);
        }
        const labelIndex = this.floats.size;
        const labelName = "_float_" + labelIndex;
        this.floats.set(key, labelName);
        this.dataLabels.push({ name: labelName, offset: this.data.length });
        for (let i = 0; i < 8; i = i + 1) {
            this.data.push(bytes[i]);
        }
        return labelName;
    }

    finalize() {
        // 物化字符串常量到数据段(逐字节透传,不重编码;见 arm64.js 同段注释)
        for (let i = 0; i < this.strings.length; i = i + 1) {
            const labelName = "_str_" + i;
            this.labels.set(labelName, this.data.length);
            this._dataLabelSet.add(labelName);
            const str = this.strings[i];
            for (let j = 0; j < str.length; j = j + 1) {
                this.data.push(str.charCodeAt(j) & 0xff);
            }
            this.data.push(0);
        }
        // 数据标签
        for (let i = 0; i < this.dataLabels.length; i = i + 1) {
            const dl = this.dataLabels[i];
            if (dl.offset >= 0) {
                this.labels.set(dl.name, dl.offset);
                this._dataLabelSet.add(dl.name);
            }
        }
    }

    // ==================== 回填 ====================

    fixupAll() {
        this.labels.set("_data_start", 0);
        this._dataLabelSet.add("_data_start");

        // 代码标签序号表(定义序;重复定义时后写覆盖序号映射)
        const idxMap = new Map();
        for (let i = 0; i < this._codeLabelNames.length; i = i + 1) {
            idxMap.set(this._codeLabelNames[i], i);
        }
        const n = this._codeLabelNames.length;

        for (let i = 0; i < this.pendingFixups.length; i = i + 1) {
            const fixup = this.pendingFixups[i];

            if (fixup.type === "br") {
                // 所在标签(全局序号)→ 段内序号;深度相对本段的派发 loop:
                // 段结构 block_exit{ loop{ block×n_i{ br_table } 切片… } },
                // 切片 j 内 br 到 loop 的深度 = (n_i - 1 - j) + extra(if 内 +1)。
                const li = this._segmentOf(fixup.offset);
                const segBase = Math.floor(li / this.segSize) * this.segSize;
                const segCount = Math.min(this.segSize, n - segBase);
                const depth = (segCount - 1 - (li - segBase)) + fixup.extra;
                // 深度 ≤ segSize-1+extra,恒落在 brPadBytes 的 uleb 范围内(见构造器注)。
                this.patchUlebN(fixup.offset, depth, this.brPadBytes);
                continue;
            }

            const resolved = this.resolveLabel(fixup.label);

            if (fixup.type === "pc") {
                if (!idxMap.has(resolved)) {
                    throw new Error("wasm fixup: undefined code label: " + resolved);
                }
                this.patchSleb32(fixup.offset, idxMap.get(resolved));
                continue;
            }

            if (fixup.type === "a64") {
                // 5 字节 sleb(35 位有符号)容 < 2³² 的全部 wasm32 地址(见 addAbs64Fixup)。
                if (this._dataLabelSet.has(resolved)) {
                    this.patchSlebW(fixup.offset, BigInt(this.dataVAddr) + BigInt(this.labels.get(resolved)), 5);
                } else if (idxMap.has(resolved)) {
                    this.patchSlebW(fixup.offset, BigInt(WASM_CODE_BASE + idxMap.get(resolved)), 5);
                } else {
                    throw new Error("wasm fixup: undefined label: " + resolved);
                }
                continue;
            }

            throw new Error("wasm fixup: unknown type: " + fixup.type);
        }
    }

    // 二分:最后一个标签偏移 <= off 的下标(off 在首标签前 → 0,只会是死代码)
    _segmentOf(off) {
        const offs = this._codeLabelOffs;
        let lo = 0;
        let hi = offs.length - 1;
        if (hi < 0 || off < offs[0]) return 0;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (offs[mid] <= off) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }

    estimateFinalDataSize() {
        let size = this.data.length;
        for (let i = 0; i < this.strings.length; i = i + 1) {
            size = size + this.strings[i].length + 1;
        }
        return size;
    }
}

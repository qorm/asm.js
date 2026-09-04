// 虚拟寄存器契约与保守线性扫描分配器。
//
// 这层故意独立于 backend 的指令发射：backend 仍然接收 VReg，分配器只负责
// 说明「哪些名字实际上是同一个物理寄存器」、计算临时值的活跃区间，并给出
// 一个可验证的映射。这样可以先在录制层启用审计/差分，再逐步接管 codegen，
// 不会把自举编译器一次性切换到尚未验证的 allocator。

import { VReg, isTemp, makeTempName } from "./registers.js";

// 物理寄存器编号与 backend 中的定义保持一致。这里不复制 backend 对象，避免
// 分配器为了查询 ABI 而触发任何汇编发射。
const CONTRACTS = {
    arm64: {
        arch: "arm64",
        map: {
            V0: 8, V1: 9, V2: 10, V3: 11, V4: 12, V5: 13, V6: 14, V7: 15,
            S0: 19, S1: 20, S2: 21, S3: 22, S4: 23, S5: 24,
            A0: 0, A1: 1, A2: 2, A3: 3, A4: 4, A5: 5,
            RET: 0, FP: 29, SP: 31, LR: 30,
        },
        // 只有 S* 可以无条件跨越普通 C/运行时调用。X16/X17 是 backend 的
        // 临时寄存器，X18/X28 由平台/并发运行时保留，不能交给通用 allocator。
        calleeSaved: ["S0", "S1", "S2", "S3", "S4", "S5"],
        callerSaved: ["V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "A0", "A1", "A2", "A3", "A4", "A5", "RET"],
        allocatable: ["S0", "S1", "S2", "S3", "S4", "S5"],
        scratchPhysical: [16, 17],
        reservedPhysical: [16, 17, 18, 28, 29, 30, 31],
        // Native user-frame locals start below the six-slot callee-save area.
        // Keeping this metadata here lets a verifier reject a spill which would
        // alias a saved register even before a backend-specific frame is built.
        stackHomeAlignment: 8,
        minLocalHome: -56,
        reservedStackSlots: [],
        stackSlots: {},
    },
    x64: {
        arch: "x64",
        map: {
            V0: 0, V1: 1, V2: 2, V3: 8, V4: 9, V5: 10, V6: 11, V7: 6,
            S0: 3, S1: 12, S2: 13, S3: 14, S4: 15, S5: null,
            // S5 是相对于 RBP 的栈槽，不是一个可供 allocator 着色的 GPR。
            A0: 7, A1: 6, A2: 2, A3: 1, A4: 8, A5: 9,
            RET: 0, FP: 5, SP: 4, LR: 0,
        },
        calleeSaved: ["S0", "S1", "S2", "S3", "S4"],
        callerSaved: ["V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "A0", "A1", "A2", "A3", "A4", "A5", "RET"],
        allocatable: ["S0", "S1", "S2", "S3", "S4"],
        scratchPhysical: [10, 11],
        // RSP/RBP and the two backend scratch registers are never allocator
        // candidates.  Caller-saved argument/result registers remain available
        // when `allowCallerSaved` is explicitly requested for call-free code.
        reservedPhysical: [4, 5, 10, 11],
        stackHomeAlignment: 8,
        minLocalHome: -56,
        // S5 is saved in a backend-selected slot.  With the current fixed
        // six-slot frame, every offset in this area can be occupied by a saved
        // register/S5; user locals begin at FP-56.
        reservedStackSlots: [-8, -16, -24, -32, -40, -48],
        stackSlots: { S5: -8 },
    },
    wasm32: {
        arch: "wasm32",
        // wasm backend 实际把这些名字映射到 mutable globals；给它们稳定的
        // logical 编号即可用于审计。wasm 的 globals 不受 native ABI clobber。
        map: {
            V0: 7, V1: 8, V2: 9, V3: 10, V4: 11, V5: 12, V6: 13, V7: 14,
            S0: 15, S1: 16, S2: 17, S3: 18, S4: 19, S5: 20,
            A0: 1, A1: 2, A2: 3, A3: 4, A4: 5, A5: 6,
            RET: 1, FP: 21, SP: 22, LR: 23,
        },
        calleeSaved: ["S0", "S1", "S2", "S3", "S4", "S5"],
        callerSaved: [],
        allocatable: ["S0", "S1", "S2", "S3", "S4", "S5"],
        scratchPhysical: [],
        reservedPhysical: [0, 1, 2],
        stackHomeAlignment: 8,
        minLocalHome: -56,
        reservedStackSlots: [],
        stackSlots: {},
    },
};

export const SUPPORTED_ARCHITECTURES = ["arm64", "x64", "wasm32"];

function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

function cloneArray(a) {
    const out = [];
    for (let i = 0; i < a.length; i++) out.push(a[i]);
    return out;
}

function cloneObject(o) {
    const out = {};
    for (const k in o) {
        if (hasOwn(o, k)) out[k] = o[k];
    }
    return out;
}

function contractFor(arch) {
    if (typeof arch !== "string" || !hasOwn(CONTRACTS, arch)) {
        throw new RangeError("Unknown register architecture: " + arch);
    }
    const key = arch;
    const src = CONTRACTS[key];
    // 返回副本：调用方可以给 candidate pool 加过滤条件而不污染全局契约。
    return {
        arch: src.arch,
        map: cloneObject(src.map),
        calleeSaved: cloneArray(src.calleeSaved),
        callerSaved: cloneArray(src.callerSaved),
        allocatable: cloneArray(src.allocatable),
        scratchPhysical: cloneArray(src.scratchPhysical),
        reservedPhysical: cloneArray(src.reservedPhysical),
        stackHomeAlignment: src.stackHomeAlignment,
        minLocalHome: src.minLocalHome,
        reservedStackSlots: cloneArray(src.reservedStackSlots || []),
        stackSlots: cloneObject(src.stackSlots || {}),
    };
}

function aliasesOf(contract, name) {
    if (!hasOwn(contract.map, name) && !hasOwn(contract.stackSlots || {}, name)) return [];
    if (hasOwn(contract.stackSlots || {}, name) && !hasOwn(contract.map, name)) return [name];
    const p = contract.map[name];
    if (p == null) return [name];
    const out = [];
    for (const k in contract.map) {
        if (hasOwn(contract.map, k) && contract.map[k] === p) out.push(k);
    }
    return out;
}

function isRegisterName(contract, x) {
    return typeof x === "string" && hasOwn(contract.map, x);
}

function looksLikeRegisterName(x) {
    if (typeof x !== "string") return false;
    if (x === "RET" || x === "FP" || x === "SP" || x === "LR") return true;
    if (x.length < 2) return false;
    const c = x.charCodeAt(0);
    if (c !== 65 && c !== 83 && c !== 86) return false; // A/S/V
    for (let i = 1; i < x.length; i++) {
        const d = x.charCodeAt(i);
        if (d < 48 || d > 57) return false;
    }
    return true;
}

function isCallOpcode(op) {
    // vm/index.js 与 vm/regalloc.js 的录制 opcode。保守地把 PREPARECALL
    // 也视为 call：它会把参数搬进 ABI caller-saved 寄存器。
    return op === 8 || op === 52 || op === 54 || op === 55 || op === 56 ||
        op === 82 || op === 83 || op === 84 || op === 85 || op === 86 ||
        op === "call" || op === "call_indirect" || op === "callIndirect" ||
        op === "call_reg" || op === "callReg" || op === "prepareCall" ||
        op === "syscall" || op === "syscallReg" || op === "syscall_reg" ||
        op === "call_iat" || op === "callIAT" || op === "call_windows_api" ||
        op === "callWindowsAPI" || op === "call_windows_write" ||
        op === "callWindowsWriteConsole" || op === "call_windows_exit" ||
        op === "callWindowsExitProcess" || op === "call_windows_getcommandline" ||
        op === "callWindowsGetCommandLine" || op === "call_win_write" ||
        op === "call_win_exit" || op === "call_win_getcommandline" ||
        op === "call_win_api";
}

function isControlFlowOpcode(op) {
    // Conditional/unconditional branches and indirect jumps in vm/index.js.
    // A generic descriptor may also spell these out explicitly. Without a CFG
    // we extend every interval across the function when one is present; this
    // is conservative, but prevents a linear scan from reusing a color across
    // a loop back-edge.
    return op === 6 || op === 7 || op === 10 || op === 12 ||
        op === 19 || op === 20 || op === 21 || op === 22 ||
        op === 26 || op === 27 || op === 28 || op === 29 ||
        op === 53 || op === 78 || op === 79 || op === 80 || op === 81 ||
        op === 87 || op === "label" || op === "jump" || op === "branch" ||
        op === "jmp" || op === "jmp_if" || op === "jump_if" ||
        op === "jeq" || op === "jne" || op === "jlt" || op === "jle" ||
        op === "jgt" || op === "jge" || op === "jb" || op === "jbe" ||
        op === "ja" || op === "jae" || op === "jflt" || op === "jfle" ||
        op === "jfgt" || op === "jfge" || op === "jnan" ||
        op === "br" || op === "br_if" || op === "loop" || op === "switch" ||
        op === "throw" || op === "jmp_indirect" || op === "jump_indirect";
}

function forEachOperand(value, fn) {
    return forEachOperandSeen(value, fn, []);
}

// Descriptor operands are normally tiny, but accepting arbitrary nested
// objects makes the audit API useful to fuzzers.  Guard object graphs against
// cycles so a malformed `{self: obj}` cannot recurse until stack overflow.
function forEachOperandSeen(value, fn, seen) {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
        fn(value);
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < seen.length; i++) if (seen[i] === value) return;
        seen.push(value);
        for (let i = 0; i < value.length; i++) forEachOperandSeen(value[i], fn, seen);
        return;
    }
    if (typeof value === "object") {
        for (let i = 0; i < seen.length; i++) if (seen[i] === value) return;
        seen.push(value);
        // prepareCall 的 `{reg, value}` 以及少数 runtime 自定义参数对象。
        for (const k in value) {
            if (hasOwn(value, k)) forEachOperandSeen(value[k], fn, seen);
        }
    }
}

function operandListForRecorded(record, i) {
    const out = [];
    if (record.a) out.push(record.a[i]);
    if (record.b) out.push(record.b[i]);
    if (record.c) out.push(record.c[i]);
    return out;
}

function isValidStackHome(contract, home) {
    if (!Number.isSafeInteger(home)) return false;
    const alignment = contract.stackHomeAlignment || 8;
    if (alignment > 1 && (home % alignment) !== 0) return false;
    if (home >= 0) return false;
    if (contract.minLocalHome != null && home > contract.minLocalHome) return false;
    const reserved = contract.reservedStackSlots || [];
    for (let i = 0; i < reserved.length; i++) {
        if (reserved[i] === home) return false;
    }
    return true;
}

function sortedNumericUnique(values) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
        let seen = false;
        for (let j = 0; j < out.length; j++) {
            if (out[j] === values[i]) { seen = true; break; }
        }
        if (!seen) out.push(values[i]);
    }
    out.sort((a, b) => a - b);
    return out;
}

/**
 * Return a copy of the register/ABI contract for an architecture.
 */
export function getRegisterContract(arch) {
    return contractFor(arch);
}

/**
 * Return all VReg names which alias `name` on the selected architecture.
 */
export function getRegisterAliases(arch, name) {
    return aliasesOf(contractFor(arch), name);
}

/**
 * A deliberately conservative linear-scan manager.
 *
 * It is useful in two places:
 *   1. standalone IR tests (`allocate([{uses, defs, call}])`), and
 *   2. the VM recorder (`allocateRecorded({ops, a, b, c, cnt, tempHomes})`).
 *
 * The default pool is callee-saved only. This is slower than using every GPR,
 * but it makes a mapping sound across helper calls while the call-clobber table
 * is still being migrated out of hand-written compiler sites.
 */
export class VirtualRegisterManager {
    constructor(arch, options) {
        this.contract = contractFor(arch);
        this.options = options || {};
        // The VM recorder is tiny, but the standalone API is also exposed to
        // fuzzers.  Bound the input before constructing an instruction list so
        // a hostile count cannot turn into an unbounded allocation/OOM.
        this.maxInstructions = Number.isSafeInteger(this.options.maxInstructions) &&
            this.options.maxInstructions >= 0
            ? this.options.maxInstructions : (1 << 20);
        this.reset();
    }

    reset() {
        this.nextId = 0;
        this.tempHomes = Object.create(null);
        this.tempMeta = Object.create(null);
        this._intervals = Object.create(null);
        this._intervalList = [];
        this._fixedPhysical = Object.create(null);
        this._callPositions = [];
        this._hasControlFlow = false;
        this._inputErrors = [];
        this.lastAllocation = null;
    }

    newTemp(homeOff, type) {
        const name = makeTempName(this.nextId);
        this.nextId = this.nextId + 1;
        this.tempHomes[name] = homeOff;
        this.tempMeta[name] = { home: homeOff, type: type || "value" };
        return name;
    }

    newVirtual(type, homeOff) {
        return this.newTemp(homeOff, type);
    }

    _makeInterval(name, pos, isCall) {
        const old = this._intervals[name];
        if (old) {
            old.last = pos;
            old.count = old.count + 1;
            if (isCall) old.crossesCall = true;
            return old;
        }
        const it = {
            name: name,
            first: pos,
            last: pos,
            count: 1,
            crossesCall: !!isCall,
            home: hasOwn(this.tempHomes, name) ? this.tempHomes[name] : undefined,
        };
        this._intervals[name] = it;
        this._intervalList.push(it);
        return it;
    }

    _scanInstruction(inst, pos) {
        if (!inst || typeof inst !== "object") {
            this._inputErrors.push("instruction " + pos + " is not an object");
            return;
        }
        const call = !!inst.call || isCallOpcode(inst.op);
        if (inst.branch || inst.jump || inst.label || isControlFlowOpcode(inst.op)) {
            this._hasControlFlow = true;
        }
        const self = this;
        const scan = function (value) {
            if (isTemp(value)) self._makeInterval(value, pos, call);
            else if (isRegisterName(self.contract, value)) {
                const p = self.contract.map[value];
                if (p != null) self._fixedPhysical[p] = true;
            }
        };
        forEachOperand(inst.uses, scan);
        forEachOperand(inst.defs, scan);
        forEachOperand(inst.reads, scan);
        forEachOperand(inst.writes, scan);
        forEachOperand(inst.fixed, scan);
        const fixedScan = (value) => {
            if (typeof value === "string" && looksLikeRegisterName(value) &&
                !isRegisterName(this.contract, value)) {
                this._inputErrors.push("unknown fixed register " + value + " at " + pos);
            }
        };
        forEachOperand(inst.fixed, fixedScan);
        // A descriptor can carry extra operands (for example a call target or
        // a nested prepareCall object). Scanning it is safer than silently
        // allowing a hidden fixed-register alias.
        if (inst.operands) forEachOperand(inst.operands, scan);
        if (call) this._callPositions.push(pos);
    }

    _sortIntervals() {
        const a = this._intervalList;
        // Keep interval ordering deterministic while avoiding the quadratic
        // insertion sort that made a malformed/fuzzed instruction stream
        // unnecessarily expensive.  The allocator is not on the self-hosted
        // codegen path yet, so the native sort primitive is an explicit part of
        // this standalone audit boundary.
        a.sort(function (left, right) {
            if (left.first !== right.first) return left.first - right.first;
            if (left.count !== right.count) return right.count - left.count;
            if (left.name < right.name) return -1;
            if (left.name > right.name) return 1;
            return 0;
        });
    }

    _physicalBusy(active, physical) {
        for (let i = 0; i < active.length; i++) {
            const p = this.contract.map[active[i].reg];
            if (p === physical) return true;
        }
        return false;
    }

    _candidatePool(options) {
        const allowCaller = !!(options && options.allowCallerSaved);
        const names = [];
        const source = allowCaller
            ? this.contract.allocatable.concat(this.contract.callerSaved)
            : this.contract.allocatable;
        for (let i = 0; i < source.length; i++) {
            const n = source[i];
            if (!isRegisterName(this.contract, n)) continue;
            const p = this.contract.map[n];
            if (p == null) continue;
            let reserved = false;
            for (let r = 0; r < this.contract.reservedPhysical.length; r++) {
                if (this.contract.reservedPhysical[r] === p) { reserved = true; break; }
            }
            if (reserved) continue;
            let duplicate = false;
            for (let j = 0; j < names.length; j++) {
                if (this.contract.map[names[j]] === p) duplicate = true;
            }
            if (duplicate || this._fixedPhysical[p]) continue;
            names.push(n);
        }
        return names;
    }

    _intervalsCrossingCall(it) {
        if (it.crossesCall) return true;
        for (let i = 0; i < this._callPositions.length; i++) {
            const p = this._callPositions[i];
            if (p >= it.first && p <= it.last) return true;
        }
        return false;
    }

    _allocateIntervals(options) {
        const pool = this._candidatePool(options);
        const active = [];
        const assignments = Object.create(null);
        const spills = Object.create(null);
        const diagnostics = [];

        for (let i = 0; i < this._intervalList.length; i++) {
            const cur = this._intervalList[i];
            // Expire intervals which ended before this one starts.
            for (let j = active.length - 1; j >= 0; j--) {
                if (active[j].last < cur.first) active.splice(j, 1);
            }
            const crosses = this._intervalsCrossingCall(cur);
            let chosen = null;
            for (let p = 0; p < pool.length; p++) {
                const candidate = pool[p];
                if (crosses && this.contract.calleeSaved.indexOf(candidate) < 0) continue;
                if (!this._physicalBusy(active, this.contract.map[candidate])) {
                    chosen = candidate;
                    break;
                }
            }
            if (chosen) {
                assignments[cur.name] = chosen;
                active.push({ name: cur.name, reg: chosen, last: cur.last });
            } else {
                const home = cur.home;
                spills[cur.name] = home;
                diagnostics.push({
                    kind: "spill",
                    temp: cur.name,
                    home: home,
                    first: cur.first,
                    last: cur.last,
                });
            }
        }
        const savedRegisters = [];
        for (const name in assignments) {
            if (!hasOwn(assignments, name)) continue;
            const reg = assignments[name];
            if (this.contract.calleeSaved.indexOf(reg) < 0) continue;
            let seen = false;
            for (let i = 0; i < savedRegisters.length; i++) {
                if (savedRegisters[i] === reg) { seen = true; break; }
            }
            if (!seen) savedRegisters.push(reg);
        }
        return {
            assignments, spills, diagnostics, pool,
            // Codegen must add these to both prologue and epilogue before using
            // the mapping.  Returning the set makes a future integration
            // mechanically checkable instead of relying on hand-maintained ABI
            // lists.
            savedRegisters,
            requiredCalleeSaved: savedRegisters.slice(),
        };
    }

    /** Allocate a generic instruction descriptor list. */
    allocate(instructions, options) {
        if (!Array.isArray(instructions)) {
            throw new TypeError("instructions must be an array");
        }
        const list = instructions;
        const limit = options && Number.isSafeInteger(options.maxInstructions)
            ? options.maxInstructions : this.maxInstructions;
        if (list.length > limit) {
            throw new RangeError("too many instructions for virtual register allocation");
        }
        this._intervals = Object.create(null);
        this._intervalList = [];
        this._fixedPhysical = Object.create(null);
        this._callPositions = [];
        this._hasControlFlow = false;
        this._inputErrors = [];
        for (let i = 0; i < list.length; i++) this._scanInstruction(list[i], i);
        if (this._hasControlFlow && this._intervalList.length > 0) {
            // No CFG/phi information is available at this layer. Widening to
            // the complete region is the only sound fallback for loops and
            // branch joins; a later CFG-aware allocator may narrow it.
            for (let i = 0; i < this._intervalList.length; i++) {
                this._intervalList[i].first = 0;
                this._intervalList[i].last = list.length - 1;
            }
        }
        // Record the derived fact in the public interval metadata as well as
        // using it for coloring.  A value can be live across a call even when
        // it is not itself an operand of the call instruction (there may be a
        // gap between its definition and use), so relying only on the
        // `_makeInterval` operand flag would under-report clobber risk.
        for (let i = 0; i < this._intervalList.length; i++) {
            this._intervalList[i].crossesCall = this._intervalsCrossingCall(this._intervalList[i]);
        }
        this._sortIntervals();
        const out = this._allocateIntervals(options || this.options);
        // Do not expose the manager's mutable interval records.  A verifier or
        // caller may annotate its result; mutating that annotation must not
        // silently alter `lastAllocation`/the next handoff.
        out.intervals = [];
        for (let i = 0; i < this._intervalList.length; i++) {
            out.intervals.push(cloneObject(this._intervalList[i]));
        }
        out.fixedPhysical = cloneObject(this._fixedPhysical);
        out.callPositions = this._callPositions.slice();
        out.instructionCount = list.length;
        out.arch = this.contract.arch;
        if (this._inputErrors.length > 0) {
            out.diagnostics = out.diagnostics.concat(this._inputErrors.map((message) => ({
                kind: "input", message,
            })));
        }
        out.requiresSpillLowering = Object.keys(out.spills).length > 0;
        // Keep a machine-readable verification result beside the mapping.  A
        // caller may still inspect/diagnose a non-emittable allocation, but it
        // must not mistake it for a safe codegen handoff.
        out.verification = this.verify(out);
        if (this._inputErrors.length > 0) {
            out.verification.ok = false;
            for (let i = 0; i < this._inputErrors.length; i++) {
                out.verification.errors.push(this._inputErrors[i]);
            }
        }
        out.ok = out.verification.ok;
        out.emittable = out.ok && !out.requiresSpillLowering;
        this.lastAllocation = out;
        return out;
    }

    /**
     * Adapt the VM's compact parallel recorder arrays to `allocate`.
     * The scan intentionally treats every recorded operand as a use/def. That
     * over-approximates liveness (fewer colors, more spills) but cannot shorten
     * a live range and therefore cannot introduce a call-clobber bug.
     */
    allocateRecorded(record, options) {
        if (!record || typeof record !== "object") {
            throw new TypeError("record must be an object");
        }
        const n = record.cnt;
        const limit = options && Number.isSafeInteger(options.maxInstructions)
            ? options.maxInstructions : this.maxInstructions;
        if (!Number.isSafeInteger(n) || n < 0 || n > limit) {
            throw new RangeError("record.cnt must be a non-negative safe integer");
        }
        if (n > 0 && !Array.isArray(record.ops)) {
            throw new TypeError("record.ops must be an array when cnt is non-zero");
        }
        const arrayKeys = ["ops", "a", "b", "c"];
        for (let i = 0; i < arrayKeys.length; i++) {
            const key = arrayKeys[i];
            if (record[key] != null &&
                (!Array.isArray(record[key]) || record[key].length < n)) {
                throw new RangeError("record." + key + " is shorter than record.cnt");
            }
        }
        if (record.tempHomes != null &&
            (typeof record.tempHomes !== "object" || Array.isArray(record.tempHomes))) {
            throw new TypeError("record.tempHomes must be an object");
        }
        // Copy homes before scanning: `_makeInterval` snapshots the home on its
        // first occurrence, so a late copy would turn every spill into an
        // unaddressable `undefined` slot.
        const previousHomes = this.tempHomes;
        const recordHomes = Object.create(null);
        if (record && record.tempHomes) {
            for (const k in record.tempHomes) {
                if (hasOwn(record.tempHomes, k)) recordHomes[k] = record.tempHomes[k];
            }
        } else {
            // If the caller created temps through newTemp(), retain those homes
            // only when the record does not provide an authoritative table.
            for (const k in previousHomes) {
                if (hasOwn(previousHomes, k)) recordHomes[k] = previousHomes[k];
            }
        }
        this.tempHomes = recordHomes;
        const instructions = [];
        for (let i = 0; i < n; i++) {
            const operands = operandListForRecorded(record, i);
            instructions.push({
                op: record.ops ? record.ops[i] : undefined,
                operands: operands,
                uses: operands,
                defs: [],
                call: isCallOpcode(record.ops ? record.ops[i] : undefined),
            });
        }
        try {
            return this.allocate(instructions, options);
        } finally {
            // Homes are per-record metadata; retaining them across records can
            // turn a later spill into a stale frame offset.
            this.tempHomes = previousHomes;
        }
    }

    /**
     * Rewrite a flat operand array using a successful allocation. Spilled temps
     * are left intact and returned in `unresolved`; the caller must lower those
     * to loads/stores rather than guessing a physical register.
     */
    rewriteValues(values, allocation) {
        const out = [];
        const unresolved = [];
        const map = allocation && allocation.assignments ? allocation.assignments : {};
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (isTemp(v) && hasOwn(map, v)) out.push(map[v]);
            else {
                out.push(v);
                if (isTemp(v)) unresolved.push(v);
            }
        }
        return { values: out, unresolved: unresolved };
    }

    /**
     * Check an allocation for alias and call-safety violations. This is used by
     * the opt-in VM audit and by unit tests; it deliberately returns data rather
     * than throwing so a production build can fall back to the old path.
     */
    verify(allocation) {
        const errors = [];
        if (!allocation || typeof allocation !== "object") {
            return { ok: false, errors: ["missing allocation"] };
        }
        const isDict = (value) => value != null && typeof value === "object" &&
            !Array.isArray(value);
        const map = isDict(allocation.assignments) ? allocation.assignments : {};
        const spills = isDict(allocation.spills) ? allocation.spills : {};
        const fixed = isDict(allocation.fixedPhysical) ? allocation.fixedPhysical : {};
        if (!isDict(allocation.assignments)) errors.push("assignments must be an object");
        if (!isDict(allocation.spills)) errors.push("spills must be an object");
        if (!isDict(allocation.fixedPhysical)) errors.push("fixedPhysical must be an object");
        const intervals = Array.isArray(allocation.intervals) ? allocation.intervals : null;
        if (!intervals) errors.push("intervals must be an array");
        const rawCalls = allocation.callPositions;
        const calls = Array.isArray(rawCalls) ? rawCalls : [];
        if (!Array.isArray(rawCalls)) errors.push("callPositions must be an array");
        const active = [];
        const seen = Object.create(null);
        const spillIntervals = [];
        const instructionCount = allocation.instructionCount;
        if (allocation.arch !== this.contract.arch) {
            errors.push("allocation architecture " + allocation.arch + " does not match " + this.contract.arch);
        }
        if (instructionCount != null &&
            (!Number.isSafeInteger(instructionCount) || instructionCount < 0)) {
            errors.push("invalid instructionCount " + instructionCount);
        }
        const callList = [];
        for (let i = 0; i < calls.length; i++) {
            const p = calls[i];
            if (!Number.isSafeInteger(p) || p < 0 ||
                (Number.isSafeInteger(instructionCount) && p >= instructionCount)) {
                errors.push("invalid call position " + p);
            } else {
                callList.push(p);
            }
        }
        const uniqueCalls = sortedNumericUnique(callList);
        let pool = null;
        if (allocation.pool != null) {
            if (!Array.isArray(allocation.pool)) errors.push("pool must be an array");
            else pool = allocation.pool;
        }
        // Verify in interval order even when a caller supplied an unsorted list.
        const ordered = intervals ? intervals.slice() : [];
        ordered.sort((a, b) => {
            const af = a && typeof a === "object" && Number.isSafeInteger(a.first)
                ? a.first : Number.MAX_SAFE_INTEGER;
            const bf = b && typeof b === "object" && Number.isSafeInteger(b.first)
                ? b.first : Number.MAX_SAFE_INTEGER;
            if (af !== bf) return af - bf;
            const al = a && typeof a === "object" && Number.isSafeInteger(a.last)
                ? a.last : Number.MAX_SAFE_INTEGER;
            const bl = b && typeof b === "object" && Number.isSafeInteger(b.last)
                ? b.last : Number.MAX_SAFE_INTEGER;
            return al - bl;
        });
        for (let i = 0; i < ordered.length; i++) {
            const it = ordered[i];
            if (!it || typeof it !== "object" || Array.isArray(it)) {
                errors.push("invalid interval at index " + i);
                continue;
            }
            const name = it.name;
            if (typeof name !== "string" || !isTemp(name)) {
                errors.push("invalid interval name " + name);
                continue;
            }
            if (!Number.isSafeInteger(it.first) || !Number.isSafeInteger(it.last) ||
                it.first < 0 || it.first > it.last ||
                (Number.isSafeInteger(instructionCount) && it.last >= instructionCount)) {
                errors.push(name + " has invalid interval " + it.first + ".." + it.last);
                continue;
            }
            if (it.count !== undefined &&
                (!Number.isSafeInteger(it.count) || it.count < 1)) {
                errors.push(name + " has invalid interval count " + it.count);
            }
            if (seen[name]) errors.push("duplicate interval " + name);
            seen[name] = true;
            if (it.home !== undefined && !isValidStackHome(this.contract, it.home)) {
                errors.push(name + " has invalid interval home " + it.home);
            }
            // `crossesCall` is producer metadata, not a privilege to bypass
            // the call-position proof.  Check it for spilled intervals too:
            // otherwise a malformed spill record could silently disagree with
            // the liveness facts consumed by a later lowering pass.
            let crosses = false;
            for (let c = 0; c < uniqueCalls.length; c++) {
                if (uniqueCalls[c] >= it.first && uniqueCalls[c] <= it.last) {
                    crosses = true;
                    break;
                }
            }
            if (it.crossesCall !== undefined && typeof it.crossesCall !== "boolean") {
                errors.push(name + " has non-boolean crossesCall");
            } else if (it.crossesCall === true && !crosses) {
                errors.push(name + " claims to cross a call but no call is recorded");
            } else if (it.crossesCall === false && crosses) {
                errors.push(name + " does not claim a recorded call crossing");
            }
            const hasAssignment = hasOwn(map, name);
            const hasSpill = hasOwn(spills, name);
            if (hasAssignment && hasSpill) {
                errors.push(name + " has both register and spill home");
            } else if (!hasAssignment && !hasSpill) {
                errors.push(name + " has neither register nor spill home");
            }
            if (hasSpill) {
                const home = spills[name];
                if (!isValidStackHome(this.contract, home)) {
                    errors.push(name + " has invalid spill home " + home);
                } else {
                    spillIntervals.push({ name: name, first: it.first, last: it.last, home: home });
                }
            }
            if (!hasAssignment) continue;
            const reg = map[name];
            if (typeof reg !== "string" || !isRegisterName(this.contract, reg)) {
                errors.push(name + " mapped to unknown register " + reg);
                continue;
            }
            const phys = this.contract.map[reg];
            if (phys == null) {
                errors.push(name + " mapped to non-physical " + reg);
                continue;
            }
            let reserved = false;
            for (let r = 0; r < this.contract.reservedPhysical.length; r++) {
                if (this.contract.reservedPhysical[r] === phys) { reserved = true; break; }
            }
            if (reserved) errors.push(name + " mapped to reserved physical " + phys + " (" + reg + ")");
            let allowed = this.contract.allocatable.indexOf(reg) >= 0 ||
                this.contract.callerSaved.indexOf(reg) >= 0;
            if (pool) allowed = pool.indexOf(reg) >= 0;
            if (!allowed) errors.push(name + " mapped outside allocator pool (" + reg + ")");
            if (hasOwn(fixed, phys)) errors.push(name + " aliases fixed physical " + phys + " (" + reg + ")");
            if (crosses && this.contract.calleeSaved.indexOf(reg) < 0) {
                errors.push(name + " crosses call in caller-saved " + reg);
            }
            for (let j = active.length - 1; j >= 0; j--) {
                if (active[j].last < it.first) active.splice(j, 1);
            }
            for (let j = 0; j < active.length; j++) {
                if (this.contract.map[active[j].reg] === phys) {
                    errors.push("overlap: " + active[j].name + " and " + name + " use " + reg);
                }
            }
            active.push({ name: name, reg: reg, last: it.last });
        }
        for (const name in map) {
            if (hasOwn(map, name) && !seen[name]) {
                errors.push(name + " assignment has no interval");
            }
        }
        for (const name in spills) {
            if (hasOwn(spills, name) && !seen[name]) {
                errors.push(name + " spill has no interval");
            }
        }
        // Two simultaneously-live spills may not share a home. Sort by home
        // and sweep the rightmost active endpoint, reducing this check from
        // quadratic pairwise comparisons to O(n log n).
        spillIntervals.sort(function (left, right) {
            if (left.home !== right.home) return left.home < right.home ? -1 : 1;
            if (left.first !== right.first) return left.first < right.first ? -1 : 1;
            if (left.last !== right.last) return left.last < right.last ? -1 : 1;
            if (left.name < right.name) return -1;
            if (left.name > right.name) return 1;
            return 0;
        });
        let activeSpill = null;
        for (let i = 0; i < spillIntervals.length; i++) {
            const cur = spillIntervals[i];
            if (!activeSpill || cur.home !== activeSpill.home) {
                activeSpill = cur;
                continue;
            }
            if (cur.first <= activeSpill.last) {
                errors.push("spill overlap: " + activeSpill.name + " and " + cur.name + " share " + cur.home);
            }
            if (cur.last > activeSpill.last) activeSpill = cur;
        }
        // If the allocator selected callee-saved registers, codegen must save
        // exactly those registers.  The fields are optional for legacy callers,
        // but when present they are checked strictly.
        const required = [];
        for (const name in map) {
            if (!hasOwn(map, name)) continue;
            const reg = map[name];
            if (this.contract.calleeSaved.indexOf(reg) < 0) continue;
            let found = false;
            for (let i = 0; i < required.length; i++) if (required[i] === reg) found = true;
            if (!found) required.push(reg);
        }
        const saved = allocation.requiredCalleeSaved != null
            ? allocation.requiredCalleeSaved : allocation.savedRegisters;
        if (saved != null) {
            if (!Array.isArray(saved)) errors.push("requiredCalleeSaved must be an array");
            else {
                for (let i = 0; i < saved.length; i++) {
                    const reg = saved[i];
                    if (this.contract.calleeSaved.indexOf(reg) < 0) {
                        errors.push("invalid required callee-saved register " + reg);
                    }
                }
                for (let i = 0; i < required.length; i++) {
                    let found = false;
                    for (let j = 0; j < saved.length; j++) if (saved[j] === required[i]) found = true;
                    if (!found) errors.push("missing required callee-saved register " + required[i]);
                }
            }
        }
        return { ok: errors.length === 0, errors: errors };
    }
}

// More explicit spelling for callers that want to distinguish this from the
// VM facade. Keep the original name as the primary public API for compatibility.
export const VirtualRegisterAllocator = VirtualRegisterManager;

// Return the register uses/definitions for one compact recorder opcode.  The
// recorder stores all operands in three untyped slots, so a first/last scan is
// not enough: e.g. `mov A0, RET; call; mov A0, RET` reuses A0 deliberately and
// must not be reported as a value surviving the call.  Keeping this table next
// to the audit makes the ABI proof explicit and leaves the code generator
// untouched.  Unknown operations are marked opaque; callers can request a
// conservative fixed-register check for them, but the default audit will not
// invent a live range from a scratch operand.
function recordedRegisterEffects(op, a, b, c, contract) {
    const uses = [];
    const defs = [];
    const clobbers = [];
    const add = (list, value) => {
        if (!isRegisterName(contract, value)) return;
        const p = contract.map[value];
        if (p == null) return;
        if (list.indexOf(p) < 0) list.push(p);
    };
    const addAll = (list, values) => {
        for (let i = 0; i < values.length; i++) add(list, values[i]);
    };
    const binaryDef = () => { add(defs, a); addAll(uses, [b, c]); };
    const unaryDef = () => { add(defs, a); add(uses, b); };
    const is = (...xs) => xs.indexOf(op) >= 0;

    if (is(3, 4, 23)) { // mov / immediate / immediate64
        add(defs, a);
    } else if (is(1, 2, 24, 89)) { // store/load/load-byte/load32
        if (op === 1) addAll(uses, [a, b, c]);
        else { add(defs, a); addAll(uses, [b, c]); }
    } else if (op === 25 || op === 90) { // store-byte/store32
        addAll(uses, [a, b, c]);
    } else if (op === 18) { // lea
        add(defs, a);
    } else if (is(9, 13, 16, 30, 32, 34, 39, 40, 41, 42, 43, 44,
                   60, 61, 62, 63, 66, 68)) {
        binaryDef();
    } else if (is(17, 31, 33, 35, 36, 37, 38)) {
        add(defs, a); add(uses, b);
    } else if (is(45, 46, 58, 59, 64, 69, 70, 71, 72, 73, 74, 75, 76, 77, 88)) {
        unaryDef();
    } else if (is(5, 11, 47, 67)) { // compare/test; flags only
        addAll(uses, [a, b]);
    } else if (is(14)) { // push
        add(uses, a);
    } else if (is(15)) { // pop
        add(defs, a);
    } else if (is(52)) { // indirect call target is a register
        add(uses, a);
        for (let i = 0; i < contract.callerSaved.length; i++) add(clobbers, contract.callerSaved[i]);
        add(defs, "RET");
    } else if (is(8, 55, 56, 82, 83, 84, 85, 86)) {
        // Direct/system calls have no register target in the compact stream.
        // The return register is a fresh definition; all caller-saved values
        // are clobbered by the ABI.
        for (let i = 0; i < contract.callerSaved.length; i++) add(clobbers, contract.callerSaved[i]);
        add(defs, "RET");
    } else if (op === 54) { // prepareCall([{reg,value}, ...])
        if (Array.isArray(a)) {
            for (let i = 0; i < a.length; i++) {
                const item = a[i];
                if (!item || typeof item !== "object") continue;
                add(defs, item.reg);
                add(uses, item.value);
            }
        }
    } else if (op === 53) { // indirect jump
        add(uses, a);
    } else if (is(6, 7, 12, 19, 20, 21, 22, 26, 27, 28, 29,
                   78, 79, 80, 81, 87)) {
        // Branch operands are labels in the recorder.  A hand-written stream
        // may use a register in a custom descriptor; count it as a use.
        add(uses, a);
    } else if (op === 49 || op === 50 || op === 51 || op === 10 || op === 57) {
        // prologue/epilogue/ret/label/nop: no ordinary value transfer.
    } else {
        // Keep a visible diagnostic for extensions without making the default
        // audit fail every time a new opcode is introduced.
        return { uses, defs, clobbers, opaque: true };
    }
    return { uses, defs, clobbers, opaque: false };
}

// A small, side-effect-free helper used by diagnostics and tests.  In addition
// to the allocation proof, audit the physical register stream itself: a
// caller-saved register whose first/last use straddles a call is a concrete
// clobber hazard even when no T* virtuals are present in the recording.  Label
// targets are checked as well; this catches a malformed back-edge before an
// emitter attempts to patch it.  These checks are intentionally opt-in through
// the VM facade (see VREG_AUDIT) so the default code-generation path is byte
// for byte unchanged.
export function auditRecordedRegisters(arch, record, options) {
    const manager = new VirtualRegisterManager(arch, options);
    const allocation = manager.allocateRecorded(record, options);
    const verification = manager.verify(allocation);
    const contract = manager.contract;
    const n = record && Number.isSafeInteger(record.cnt) ? record.cnt : 0;
    const labels = Object.create(null);
    const labelUses = [];
    const calls = [];
    const effects = [];
    let hasControlFlow = false;
    const branchOps = new Set([
        6, 7, 12, 19, 20, 21, 22, 26, 27, 28, 29, 78, 79, 80, 81,
        "jeq", "jne", "jmp", "jlt", "jle", "jgt", "jge", "jb", "jbe",
        "ja", "jae", "jflt", "jfle", "jfgt", "jfge", "jnan", "branch",
        "jump", "jmp_if", "jump_if",
    ]);
    const labelDef = (op) => op === 10 || op === "label";
    const callOp = (op) => isCallOpcode(op);
    for (let i = 0; i < n; i++) {
        const op = record.ops ? record.ops[i] : undefined;
        const a = record.a ? record.a[i] : undefined;
        if (labelDef(op) && typeof a === "string") labels[a] = i;
        if (branchOps.has(op) && typeof a === "string") labelUses.push({ name: a, pos: i });
        if (callOp(op)) calls.push(i);
        const b = record.b ? record.b[i] : undefined;
        const c = record.c ? record.c[i] : undefined;
        const effect = recordedRegisterEffects(op, a, b, c, contract);
        effects.push(effect);
        if (branchOps.has(op) || op === 53) hasControlFlow = true;
    }
    const livenessErrors = [];
    for (let i = 0; i < labelUses.length; i++) {
        const use = labelUses[i];
        if (!hasOwn(labels, use.name)) {
            livenessErrors.push({ kind: "label", message: "branch at " + use.pos + " targets undefined label " + use.name });
        }
    }
    // A straight-line backwards data-flow pass proves only values that are
    // genuinely used after a call.  The old first/last heuristic treated every
    // scratch argument as one long value and rejected valid code (especially
    // compiler-generated `mov A0, ...; call; mov A0, ...` sequences).  Branches
    // need a CFG/phi model that the compact recorder does not carry yet; keep
    // the structural label check above and explicitly report that fixed-value
    // liveness was skipped rather than manufacturing false positives.
    const livenessMode = options && options.fixedLiveness === "dataflow"
        ? "dataflow" : (hasControlFlow ? "skipped-control-flow" : "dataflow");
    if (livenessMode === "dataflow") {
        const live = Object.create(null);
        for (let i = n - 1; i >= 0; i--) {
            const effect = effects[i];
            // At a call, values needed by later instructions must not reside
            // in caller-saved physicals.  A call's own clobber/RET definition
            // is applied before the ordinary transfer, so a fresh return value
            // is not confused with the pre-call value in RET.
            for (let c = 0; c < effect.clobbers.length; c++) {
                const p = effect.clobbers[c];
                if (live[p]) {
                    livenessErrors.push({
                        kind: "call-clobber",
                        message: "physical " + p + " is live across call at " + i,
                    });
                }
                delete live[p];
            }
            for (let d = 0; d < effect.defs.length; d++) delete live[effect.defs[d]];
            for (let u = 0; u < effect.uses.length; u++) live[effect.uses[u]] = true;
        }
    }
    if (livenessErrors.length > 0) {
        verification.ok = false;
        verification.errors = verification.errors.concat(livenessErrors.map((entry) => entry.message));
    }
    return { allocation: allocation, verification: verification, liveness: {
        ok: livenessErrors.length === 0,
        errors: livenessErrors,
        labels: labels,
        calls: calls,
        mode: livenessMode,
    } };
}

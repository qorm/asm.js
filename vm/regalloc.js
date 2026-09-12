// asm.js 用户函数寄存器分配(LLVM 式线性扫描)
// 仅 beginRecord/endRecord 用户函数体;runtime 手写 VReg 不经此。
//
// 运行时:T* 与 spill home 同一区间;CFG liveness 后线性扫描;call-free 着
// caller-saved(按 phys,x64 别名只占一色),跨 call 着 callee-saved S。
// 落选维持 FP 槽,永远 sound。
// 编译时:缓冲跨函数复用;mentMask 一次扫描;块 liveness 位图(≤30 槽);
// 过大函数在 AST 门不录,避免录满 REC_CAP 再白冲。

import { VReg, isTemp } from "./registers.js";

export const RC = {
    STORE: 1, LOAD: 2, MOV: 3,
    JEQ: 6, JNE: 7, CALL: 8, LABEL: 10, JMP: 12,
    PUSH: 14, POP: 15,
    JLT: 19, JLE: 20, JGT: 21, JGE: 22,
    JBE: 26, JB: 27, JA: 28, JAE: 29,
    PROLOGUE: 49, EPILOGUE: 50, RET: 51, CALLINDIRECT: 52, JMPINDIRECT: 53,
    PREPARECALL: 54, SYSCALL: 55, SYSCALLREG: 56,
    CALLWINDOWSWRITECONSOLE: 82, CALLWINDOWSEXITPROCESS: 83,
    CALLWINDOWSGETCOMMANDLINE: 84, CALLWINDOWSAPI: 85, CALLIAT: 86,
    JFLT: 78, JFLE: 79, JFGT: 80, JFGE: 81, JNAN: 87,
};

function isJumpOp(n) {
    return n === RC.JMP || n === RC.JEQ || n === RC.JNE ||
        n === RC.JLT || n === RC.JLE || n === RC.JGT || n === RC.JGE ||
        n === RC.JB || n === RC.JBE || n === RC.JA || n === RC.JAE ||
        n === RC.JFLT || n === RC.JFLE || n === RC.JFGT || n === RC.JFGE ||
        n === RC.JNAN;
}

function isCallOp(n) {
    return n === RC.CALL || n === RC.CALLINDIRECT || n === RC.CALLIAT ||
        n === RC.CALLWINDOWSAPI || n === RC.CALLWINDOWSWRITECONSOLE ||
        n === RC.CALLWINDOWSEXITPROCESS || n === RC.CALLWINDOWSGETCOMMANDLINE ||
        n === RC.SYSCALL || n === RC.SYSCALLREG || n === RC.PREPARECALL;
}

function markS(usedS, x) {
    if (x === VReg.S0) usedS[0] = true;
    else if (x === VReg.S1) usedS[1] = true;
    else if (x === VReg.S2) usedS[2] = true;
    else if (x === VReg.S3) usedS[3] = true;
    else if (x === VReg.S4) usedS[4] = true;
    else if (x === VReg.S5) usedS[5] = true;
}

// 物理编号(与 backend 一致)。着色按 phys,所以 x64 上 V1≡A3 不会被分两次。
const PHYS_X64 = {
    V0: 0, RET: 0, LR: 0,
    V1: 1, A3: 1,
    V2: 2, A2: 2,
    S0: 3,
    V7: 6, A1: 6,
    A0: 7,
    V3: 8, A4: 8,
    V4: 9, A5: 9,
    V5: 10, V6: 11,
    S1: 12, S2: 13, S3: 14, S4: 15,
};
const PHYS_ARM = {
    A0: 0, RET: 0,
    A1: 1, A2: 2, A3: 3, A4: 4, A5: 5,
    V0: 8, V1: 9, V2: 10, V3: 11, V4: 12, V5: 13, V6: 14, V7: 15,
    S0: 19, S1: 20, S2: 21, S3: 22, S4: 23, S5: 24,
    LR: 30,
};
function physId(arch, name) {
    if (typeof name !== "string") return -1;
    const t = arch === "x64" ? PHYS_X64 : (arch === "arm64" ? PHYS_ARM : null);
    if (!t) return -1;
    const p = t[name];
    return p === undefined ? -1 : p;
}

// call-free 区间的 caller-saved 池。每个 phys 只出现一次。
// x64 不用 V0(≡RET)也不用 V5/V6(scratchReg=R10/R11)。
function callerPool(arch) {
    if (arch === "arm64") {
        return [VReg.V7, VReg.V6, VReg.V5, VReg.V4, VReg.V3, VReg.V2, VReg.V1, VReg.V0];
    }
    // x64 caller-saved V/A all alias the incoming arg window
    // (V7≡A1, V2≡A2, V1≡A3, V3≡A4, V4≡A5, plus A0). Coloring a
    // call-free T* onto those phys before/across the A-reg snapshot
    // stores leftover 1e-323 into arguments[1] / Array.from mapfn k
    // (calling-from-valid-2). V0≡RET and V5/V6 are scratch. Empty
    // pool → call-free T* use callee-saved S like cross-call ranges.
    if (arch === "x64") {
        return [];
    }
    return [];
}

function rangeHasPhys(mask, lo, hi, phys) {
    if (phys < 0 || phys > 30) return true;
    const bit = 1 << phys;
    for (let i = lo; i <= hi; i++) {
        if ((mask[i] & bit) !== 0) return true;
    }
    return false;
}

function isTermOp(n) {
    return n === RC.JMP || isJumpOp(n) || n === RC.RET || n === RC.JMPINDIRECT;
}

function _ensureN(a, n, fill) {
    while (a.length < n) a.push(fill);
}

function _slotOf(offIdx, off) {
    if (typeof off !== "number") return -1;
    const k = offIdx[off];
    return k === undefined ? -1 : k;
}

// 对第 i 条指令的槽 use/def 回调。MOV 先 use 源再 def 目的(标准)。
function _forSlotUseDef(ops, ra, rb, rc, i, offIdx, tempHomes, onUse, onDef) {
    const n = ops[i];
    const homeOf = (t) => (tempHomes && isTemp(t)) ? tempHomes[t] : undefined;
    if (n === RC.LOAD && rb[i] === VReg.FP) {
        const u = _slotOf(offIdx, rc[i]);
        if (u >= 0) onUse(u);
        const hd = homeOf(ra[i]);
        const d = _slotOf(offIdx, hd);
        if (d >= 0) onDef(d);
        return;
    }
    if (n === RC.STORE && ra[i] === VReg.FP) {
        const hs = homeOf(rc[i]);
        const u = _slotOf(offIdx, hs);
        if (u >= 0) onUse(u);
        const d = _slotOf(offIdx, rb[i]);
        if (d >= 0) onDef(d);
        return;
    }
    if (n === RC.MOV) {
        const hs = homeOf(rb[i]);
        const u = _slotOf(offIdx, hs);
        if (u >= 0) onUse(u);
        const hd = homeOf(ra[i]);
        const d = _slotOf(offIdx, hd);
        if (d >= 0) onDef(d);
        return;
    }
    const ha = homeOf(ra[i]); const ua = _slotOf(offIdx, ha); if (ua >= 0) onUse(ua);
    const hb = homeOf(rb[i]); const ub = _slotOf(offIdx, hb); if (ub >= 0) onUse(ub);
    const hc = homeOf(rc[i]); const uc = _slotOf(offIdx, hc); if (uc >= 0) onUse(uc);
}

// 块级 liveness → 覆盖区间 [first,last]。循环携带值会 live-in 在头块,
// 不会把循环体内死值拉满整个循环。槽>30 或间接跳则失败,调用方走保守并入。
function applyCfgLive(ops, ra, rb, rc, cnt, offs, firsts, lasts, offIdx, tempHomes) {
    const nSlot = offs.length;
    if (nSlot === 0 || nSlot > 30 || cnt <= 0) return false;

    const isStart = _RA.isStart || (_RA.isStart = []);
    _ensureN(isStart, cnt, 0);
    for (let i = 0; i < cnt; i++) isStart[i] = 0;
    isStart[0] = 1;
    for (let i = 0; i < cnt; i++) {
        if (ops[i] === RC.LABEL) isStart[i] = 1;
        if (isTermOp(ops[i]) && i + 1 < cnt) isStart[i + 1] = 1;
    }
    const blkStart = _raClear(_RA.blkStart || (_RA.blkStart = []));
    for (let i = 0; i < cnt; i++) if (isStart[i]) blkStart.push(i);
    const nBlk = blkStart.length;
    if (nBlk <= 1 || nBlk > 128) return false;

    const blkEnd = _RA.blkEnd || (_RA.blkEnd = []);
    const s0 = _RA.blkS0 || (_RA.blkS0 = []);
    const s1 = _RA.blkS1 || (_RA.blkS1 = []);
    const gen = _RA.blkGen || (_RA.blkGen = []);
    const kill = _RA.blkKill || (_RA.blkKill = []);
    const liveIn = _RA.blkIn || (_RA.blkIn = []);
    const liveOut = _RA.blkOut || (_RA.blkOut = []);
    _ensureN(blkEnd, nBlk, 0);
    _ensureN(s0, nBlk, -1);
    _ensureN(s1, nBlk, -1);
    _ensureN(gen, nBlk, 0);
    _ensureN(kill, nBlk, 0);
    _ensureN(liveIn, nBlk, 0);
    _ensureN(liveOut, nBlk, 0);

    const posToBlk = _RA.posToBlk || (_RA.posToBlk = []);
    _ensureN(posToBlk, cnt, 0);
    for (let b = 0; b < nBlk; b++) {
        const en = (b + 1 < nBlk) ? blkStart[b + 1] : cnt;
        blkEnd[b] = en;
        for (let i = blkStart[b]; i < en; i++) posToBlk[i] = b;
    }

    const labNames = _RA.labNames;
    const labPos = _RA.labPos;
    const blockOfLabel = (name) => {
        for (let k = 0; k < labNames.length; k++) {
            if (labNames[k] === name) return posToBlk[labPos[k]];
        }
        return -1;
    };

    for (let b = 0; b < nBlk; b++) {
        s0[b] = -1; s1[b] = -1;
        const last = blkEnd[b] - 1;
        const n = ops[last];
        if (n === RC.JMP) {
            s0[b] = blockOfLabel(ra[last]);
        } else if (isJumpOp(n)) {
            s0[b] = blockOfLabel(ra[last]);
            if (b + 1 < nBlk) s1[b] = b + 1;
        } else if (n === RC.RET || n === RC.JMPINDIRECT) {
            // 无后继
        } else if (b + 1 < nBlk) {
            s0[b] = b + 1;
        }
        let g = 0, k = 0;
        for (let i = blkStart[b]; i < blkEnd[b]; i++) {
            _forSlotUseDef(ops, ra, rb, rc, i, offIdx, tempHomes, (u) => {
                const bit = 1 << u;
                if ((k & bit) === 0) g = g | bit;
            }, (d) => {
                k = k | (1 << d);
            });
        }
        gen[b] = g; kill[b] = k;
        liveIn[b] = 0; liveOut[b] = 0;
    }

    const slotMask = nSlot >= 31 ? 0x7fffffff : ((1 << nSlot) - 1);
    let changed = true;
    let guard = nBlk + 2;
    while (changed && guard > 0) {
        changed = false;
        guard = guard - 1;
        for (let b = nBlk - 1; b >= 0; b--) {
            let o = 0;
            const a = s0[b];
            const c = s1[b];
            if (a >= 0) o = o | liveIn[a];
            if (c >= 0) o = o | liveIn[c];
            o = o & slotMask;
            const inn = (gen[b] | (o & ~kill[b])) & slotMask;
            if (inn !== liveIn[b] || o !== liveOut[b]) changed = true;
            liveIn[b] = inn;
            liveOut[b] = o;
        }
    }

    for (let k = 0; k < nSlot; k++) {
        firsts[k] = cnt;
        lasts[k] = -1;
    }
    const markLive = (i, live) => {
        let bits = live;
        let u = 0;
        while (bits !== 0 && u < nSlot) {
            if ((bits & 1) !== 0) {
                if (i < firsts[u]) firsts[u] = i;
                if (i > lasts[u]) lasts[u] = i;
            }
            bits = bits >>> 1;
            u = u + 1;
        }
    };
    for (let b = 0; b < nBlk; b++) {
        let live = liveOut[b];
        for (let i = blkEnd[b] - 1; i >= blkStart[b]; i--) {
            _forSlotUseDef(ops, ra, rb, rc, i, offIdx, tempHomes, function () {}, function (d) {
                live = live & ~(1 << d);
            });
            _forSlotUseDef(ops, ra, rb, rc, i, offIdx, tempHomes, function (u) {
                live = live | (1 << u);
            }, function () {});
            live = live & slotMask;
            markLive(i, live);
        }
    }
    for (let k = 0; k < nSlot; k++) {
        if (lasts[k] < 0) {
            firsts[k] = 0;
            lasts[k] = cnt - 1;
        }
    }
    return true;
}

// 跨函数复用分析缓冲,避免每用户函数 new 十余个数组(自编译录制税大头之一)。
// endRecord 同步消费返回值后再进下一函数,无重入。
const _RA = {
    offs: [], cnts: [], firsts: [], lasts: [],
    labNames: [], labPos: [], backT: [], backJ: [],
    promOffs: [], promRegs: [], extList: [],
    prIdx: [], prReg: [],
    order: [], sBusy: [], poolS: [], poolSExt: [],
    busyReg: [], busyS: [], busyE: [], stk: [], cands: [],
    usedS: [false, false, false, false, false, false],
    mentMask: [],
    callAt: [],
    mentFirst: [],
    mentLast: [],
    offIdx: null,
    isStart: null,
    blkStart: null,
    blkEnd: null,
    blkS0: null,
    blkS1: null,
    blkGen: null,
    blkKill: null,
    blkIn: null,
    blkOut: null,
    posToBlk: null,
};
function _raClear(a) { a.length = 0; return a; }

/**
 * T* 读写折算为对其 spill home 的 use;分配只针对 FP 槽。
 * 成功时就地改写 ops/ra/rb/rc 中的 T*。
 */
export function runUserFuncRegAlloc(input) {
    const ops = input.ops;
    const ra = input.ra;
    const rb = input.rb;
    const rc = input.rc;
    const cnt = input.cnt;
    const arch = input.arch;
    const tempHomes = input.tempHomes || null;
    const pinnedOffs = input.pinnedOffs || [];
    const pinned = Object.create(null);
    for (let pi = 0; pi < pinnedOffs.length; pi++) {
        if (typeof pinnedOffs[pi] === "number") pinned[pinnedOffs[pi]] = true;
    }

    // 诊断:RA_BAIL=1 强制失败,走 endRecord 快照恢复 + T*→home(对照 LSRA 本身)
    if (typeof process !== "undefined" && process.env && process.env.RA_BAIL) {
        return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
    }

    const offs = _raClear(_RA.offs);
    const cnts = _raClear(_RA.cnts);
    const firsts = _raClear(_RA.firsts);
    const lasts = _raClear(_RA.lasts);
    const labNames = _raClear(_RA.labNames);
    const labPos = _raClear(_RA.labPos);
    const backT = _raClear(_RA.backT);
    const backJ = _raClear(_RA.backJ);
    const usedS = _RA.usedS;
    for (let u = 0; u < 6; u++) usedS[u] = false;
    let bail = false;
    let hasCall = false;
    let hasIndirectJmp = false;
    let hasPushPop = false;

    const offIdx = _RA.offIdx || (_RA.offIdx = Object.create(null));
    for (const k in offIdx) delete offIdx[k];
    const mentMask = _RA.mentMask;
    while (mentMask.length < cnt) mentMask.push(0);
    for (let i = 0; i < cnt; i++) mentMask[i] = 0;
    const noteMent = (i, name) => {
        const p = physId(arch, name);
        if (p >= 0 && p <= 30) mentMask[i] = mentMask[i] | (1 << p);
    };

    const noteFp = (off, i) => {
        if (typeof off !== "number") return;
        const prev = offIdx[off];
        if (prev === undefined) {
            offIdx[off] = offs.length;
            offs.push(off); cnts.push(1); firsts.push(i); lasts.push(i);
        } else {
            cnts[prev] = cnts[prev] + 1;
            lasts[prev] = i;
        }
    };

    const homeOf = (t) => (tempHomes && isTemp(t)) ? tempHomes[t] : undefined;

    for (let i = 0; i < cnt; i++) {
        const n = ops[i];
        if (n === RC.LOAD || n === RC.STORE) {
            const base = (n === RC.LOAD) ? rb[i] : ra[i];
            const off = (n === RC.LOAD) ? rc[i] : rb[i];
            if (base === VReg.FP) {
                if (typeof off === "number" && off > -48) { bail = true; break; }
                noteFp(off, i);
            } else if (base === VReg.SP) {
                bail = true; break;
            }
            markS(usedS, ra[i]); markS(usedS, rb[i]); markS(usedS, rc[i]);
            noteMent(i, ra[i]); noteMent(i, rb[i]); noteMent(i, rc[i]);
            const h0 = homeOf(ra[i]); if (typeof h0 === "number") noteFp(h0, i);
            const h1 = homeOf(rb[i]); if (typeof h1 === "number") noteFp(h1, i);
            const h2 = homeOf(rc[i]); if (typeof h2 === "number") noteFp(h2, i);
        } else if (n === RC.LABEL) {
            labNames.push(ra[i]);
            labPos.push(i);
        } else if (n !== RC.PROLOGUE && n !== RC.EPILOGUE) {
            const a = ra[i];
            const b = rb[i];
            const c = rc[i];
            if (a === VReg.SP || b === VReg.SP || c === VReg.SP ||
                a === VReg.FP || b === VReg.FP || c === VReg.FP) {
                bail = true; break;
            }
            markS(usedS, a); markS(usedS, b); markS(usedS, c);
            noteMent(i, a); noteMent(i, b); noteMent(i, c);
            const ha = homeOf(a); if (typeof ha === "number") noteFp(ha, i);
            const hb = homeOf(b); if (typeof hb === "number") noteFp(hb, i);
            const hc = homeOf(c); if (typeof hc === "number") noteFp(hc, i);
            if (n === RC.PUSH || n === RC.POP) hasPushPop = true;
            if (isCallOp(n)) hasCall = true;
            else if (n === RC.JMPINDIRECT) hasIndirectJmp = true;
            else if (isJumpOp(n)) {
                for (let k = labNames.length - 1; k >= 0; k--) {
                    if (labNames[k] === a) { backT.push(labPos[k]); backJ.push(i); break; }
                }
            }
        }
    }

    if (bail) {
        return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
    }

    // 活区间:CFG 可把 loop-carried 往头块延伸,但不得短于 mention。
    // LLVM LiveInterval 覆盖全部 def/use;`new Uint8Array(dest)` 一类
    // 构造器内部大量 label 会把 CFG 切碎,漏掉后续 `src` 的 T* MOV,
    // 区间收在首次 call 之前 → 升 caller-saved → 第二形参被冲掉。
    if (offs.length > 0) {
        const mentFirst = _raClear(_RA.mentFirst || (_RA.mentFirst = []));
        const mentLast = _raClear(_RA.mentLast || (_RA.mentLast = []));
        for (let k = 0; k < offs.length; k++) {
            mentFirst.push(firsts[k]);
            mentLast.push(lasts[k]);
        }
        if (hasIndirectJmp) {
            for (let k = 0; k < offs.length; k++) { firsts[k] = 0; lasts[k] = cnt - 1; }
        } else if (!applyCfgLive(ops, ra, rb, rc, cnt, offs, firsts, lasts, offIdx, tempHomes)) {
            if (backT.length > 0) {
                let changed = true;
                while (changed) {
                    changed = false;
                    for (let k = 0; k < offs.length; k++) {
                        for (let e = 0; e < backT.length; e++) {
                            const t = backT[e];
                            const j = backJ[e];
                            if (firsts[k] <= j && lasts[k] >= t) {
                                if (firsts[k] > t) { firsts[k] = t; changed = true; }
                                if (lasts[k] < j) { lasts[k] = j; changed = true; }
                            }
                        }
                    }
                }
            }
        } else {
            for (let k = 0; k < offs.length; k++) {
                if (mentFirst[k] < firsts[k]) firsts[k] = mentFirst[k];
                if (mentLast[k] > lasts[k]) lasts[k] = mentLast[k];
            }
        }
    }

    const promOffs = _raClear(_RA.promOffs);
    const promRegs = _raClear(_RA.promRegs);
    const extList = _raClear(_RA.extList);
    const homePhys = Object.create(null); // fpOff -> VReg

    if (offs.length > 0) {
        const poolS = _raClear(_RA.poolS);
        const poolSExt = _raClear(_RA.poolSExt);
        if (!usedS[3]) { poolS.push(VReg.S3); poolSExt.push(false); }
        if (!usedS[2]) { poolS.push(VReg.S2); poolSExt.push(false); }
        if (!usedS[1]) { poolS.push(VReg.S1); poolSExt.push(false); }
        if (!usedS[0]) { poolS.push(VReg.S0); poolSExt.push(false); }
        if (!usedS[4]) { poolS.push(VReg.S4); poolSExt.push(true); }
        if (!usedS[5] && !hasCall && arch === "arm64") {
            poolS.push(VReg.S5); poolSExt.push(true);
        }
        const order = _raClear(_RA.order);
        for (let k = 0; k < offs.length; k++) order.push(k);
        // 按区间起点升序(经典线性扫描);同起点时多用优先
        for (let x = 0; x < order.length; x++) {
            let m = x;
            for (let y = x + 1; y < order.length; y++) {
                const fy = firsts[order[y]];
                const fm = firsts[order[m]];
                if (fy < fm || (fy === fm && cnts[order[y]] > cnts[order[m]])) m = y;
            }
            const tmp = order[x]; order[x] = order[m]; order[m] = tmp;
        }

        const sBusy = _raClear(_RA.sBusy);
        for (let p = 0; p < poolS.length; p++) sBusy.push(-1);

        const callAt = _raClear(_RA.callAt);
        if (hasCall) {
            for (let i = 0; i < cnt; i++) {
                if (isCallOp(ops[i])) callAt.push(i);
            }
        }
        const crossesCall = (lo, hi) => {
            for (let c = 0; c < callAt.length; c++) {
                const p = callAt[c];
                if (p >= lo && p <= hi) return true;
            }
            return false;
        };
        const physBusyUntil = Object.create(null);
        const vPool = callerPool(arch);

        for (let x = 0; x < order.length; x++) {
            const k = order[x];
            // 仅入口 A-reg 快照槽(__argreg_*)钉 FP:升到 x64 V1≡A3 会在
            // 快照 A0 时冲掉尚未入槽的 A3。普通形参靠 mention∪CFG 区间
            // 跨 call 着 S,call-free 着 V,不再一律钉死(热循环会慢)。
            if (pinned[offs[k]]) continue;
            let assigned = null;
            let assignedExt = false;

            // LLVM: call-free 优先 caller-saved(按 phys 着色,别名只占一个颜色),
            // S 留给跨 call 的值。区间内已出现的 phys(含别名)不分配。
            if (vPool.length > 0 && cnts[k] >= 2 && !crossesCall(firsts[k], lasts[k])) {
                for (let vi = 0; vi < vPool.length; vi++) {
                    const R = vPool[vi];
                    const pid = physId(arch, R);
                    const busy = physBusyUntil[pid];
                    if (typeof busy === "number" && busy >= firsts[k]) continue;
                    if (rangeHasPhys(mentMask, firsts[k], lasts[k], pid)) continue;
                    physBusyUntil[pid] = lasts[k];
                    assigned = R;
                    break;
                }
            }

            if (!assigned) for (let p = 0; p < poolS.length; p++) {
                if (sBusy[p] >= firsts[k]) continue;
                const minUse = poolSExt[p] ? 4 : 2;
                if (cnts[k] < minUse) continue;
                sBusy[p] = lasts[k];
                assigned = poolS[p];
                assignedExt = poolSExt[p];
                const sp = physId(arch, assigned);
                if (sp >= 0) physBusyUntil[sp] = lasts[k];
                break;
            }
            if (!assigned) continue;

            promOffs.push(offs[k]);
            promRegs.push(assigned);
            homePhys[offs[k]] = assigned;
            if (assignedExt) {
                let seen = false;
                for (let t = 0; t < extList.length; t++) {
                    if (extList[t] === assigned) { seen = true; break; }
                }
                if (!seen) extList.push(assigned);
            }
        }
    }

    // 重写 T*:有 phys → mov;否则 MOV→load/store home
    for (let i = 0; i < cnt; i++) {
        if (ops[i] !== RC.MOV) {
            if (isTemp(ra[i]) || isTemp(rb[i]) || isTemp(rc[i])) {
                return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
            }
            continue;
        }
        let a = ra[i];
        let b = rb[i];
        const destT = isTemp(a);
        const srcT = isTemp(b);
        if (!destT && !srcT) continue;

        if (destT && srcT) {
            const hD = homeOf(a);
            const hS = homeOf(b);
            if (typeof hD !== "number" || typeof hS !== "number") {
                return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
            }
            if (hD === hS) {
                ra[i] = VReg.RET; rb[i] = VReg.RET; rc[i] = 0;
                continue;
            }
            const pD = homePhys[hD];
            const pS = homePhys[hS];
            if (pD && pS) { ra[i] = pD; rb[i] = pS; continue; }
            if (pD && !pS) {
                ops[i] = RC.LOAD; ra[i] = pD; rb[i] = VReg.FP; rc[i] = hS; continue;
            }
            if (!pD && pS) {
                ops[i] = RC.STORE; ra[i] = VReg.FP; rb[i] = hD; rc[i] = pS; continue;
            }
            // 两 spill:留给重放 _emitTempMov(经 RET 中转,与未晋升 a=b 同形)
            continue;
        }

        if (destT) {
            const h = homeOf(a);
            if (typeof h !== "number") {
                return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
            }
            const p = homePhys[h];
            if (p) { ra[i] = p; continue; }
            ops[i] = RC.STORE; ra[i] = VReg.FP; rb[i] = h; rc[i] = b; continue;
        }

        // srcT
        const h = homeOf(b);
        if (typeof h !== "number") {
            return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
        }
        const p = homePhys[h];
        if (p) { rb[i] = p; continue; }
        ops[i] = RC.LOAD; ra[i] = a; rb[i] = VReg.FP; rc[i] = h;
    }

    // push/pop 虚拟化(无 PUSH/POP 时整段跳过;RA_NO_PP=1 对照其税)
    const prIdx = _raClear(_RA.prIdx);
    const prReg = _raClear(_RA.prReg);
    if (cnt > 0 && !hasIndirectJmp && hasPushPop &&
        !(typeof process !== "undefined" && process.env && process.env.RA_NO_PP)) {
        const busyReg = _raClear(_RA.busyReg);
        const busyS = _raClear(_RA.busyS);
        const busyE = _raClear(_RA.busyE);
        for (let k = 0; k < promOffs.length; k++) {
            for (let q = 0; q < offs.length; q++) {
                if (offs[q] === promOffs[k]) {
                    busyReg.push(promRegs[k]);
                    busyS.push(firsts[q]);
                    busyE.push(lasts[q]);
                    break;
                }
            }
        }

        let pairOk = true;
        const stk = _raClear(_RA.stk);
        for (let i = 0; i < cnt && pairOk; i++) {
            const n = ops[i];
            if (n === RC.PUSH) stk.push(i);
            else if (n === RC.POP) {
                if (stk.length === 0) { pairOk = false; break; }
                const p = stk.pop();
                if (i <= p + 1) continue;
                let ok = true;
                let regionCall = false;
                for (let q = p + 1; q < i; q++) {
                    const m = ops[q];
                    if (m === RC.LABEL || m === RC.PROLOGUE || m === RC.EPILOGUE ||
                        m === RC.RET || m === RC.JMPINDIRECT || isJumpOp(m)) { ok = false; break; }
                    if (isCallOp(m)) regionCall = true;
                }
                if (!ok) continue;
                const cands = _raClear(_RA.cands);
                if (!regionCall) {
                    const vp = callerPool(arch);
                    for (let vi = 0; vi < vp.length; vi++) cands.push(vp[vi]);
                }
                if (!usedS[3]) cands.push(VReg.S3);
                if (!usedS[2]) cands.push(VReg.S2);
                if (!usedS[1]) cands.push(VReg.S1);
                if (!usedS[0]) cands.push(VReg.S0);
                for (let t = 0; t < extList.length; t++) cands.push(extList[t]);
                for (let ci = 0; ci < cands.length; ci++) {
                    const R = cands[ci];
                    const pid = physId(arch, R);
                    let free = true;
                    if (pid >= 0 && rangeHasPhys(mentMask, p + 1, i - 1, pid)) free = false;
                    if (free) for (let q = p + 1; q < i; q++) {
                        if (ra[q] === R || rb[q] === R || rc[q] === R) { free = false; break; }
                    }
                    if (!free) continue;
                    for (let t = 0; t < busyReg.length; t++) {
                        if (busyReg[t] === R && busyS[t] <= i && busyE[t] >= p) { free = false; break; }
                    }
                    if (!free) continue;
                    prIdx.push(p); prReg.push(R);
                    prIdx.push(i); prReg.push(R);
                    busyReg.push(R); busyS.push(p); busyE.push(i);
                    break;
                }
            }
        }
        if (!pairOk || stk.length !== 0) {
            while (prIdx.length > 0) { prIdx.pop(); prReg.pop(); }
        }
    }

    return { bail: false, promOffs, promRegs, extList, prIdx, prReg };
}

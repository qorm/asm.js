// asm.js 用户函数寄存器分配(LSRA + spill home)
// 仅 beginRecord/endRecord 用户函数体;runtime 手写 VReg 不经此。
// T* 与其 spill home(FP 槽)共享同一活跃区间,避免双重分配。

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

    const noteFp = (off, i) => {
        if (typeof off !== "number") return;
        let found = -1;
        for (let k = 0; k < offs.length; k++) {
            if (offs[k] === off) { found = k; break; }
        }
        if (found === -1) {
            offs.push(off); cnts.push(1); firsts.push(i); lasts.push(i);
        } else {
            cnts[found] = cnts[found] + 1;
            lasts[found] = i;
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

    // 回边扩展(不再算 crossesCall:已取消升 V,callee-saved S 跨 call 安全)
    if (offs.length > 0) {
        if (hasIndirectJmp) {
            for (let k = 0; k < offs.length; k++) { firsts[k] = 0; lasts[k] = cnt - 1; }
        } else if (backT.length > 0) {
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
        // 不把局部升到 V5-V7:first/last 区间对跨 call 存活偏乐观时,caller-saved
        // 会被 callee 冲掉。与旧 P1 一致,只升 callee-saved S;push/pop 虚拟化仍可临时用 V。

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

        for (let x = 0; x < order.length; x++) {
            const k = order[x];
            let assigned = null;
            let assignedExt = false;

            for (let p = 0; p < poolS.length; p++) {
                if (sBusy[p] >= firsts[k]) continue;
                const minUse = poolSExt[p] ? 4 : 2;
                if (cnts[k] < minUse) continue;
                sBusy[p] = lasts[k];
                assigned = poolS[p];
                assignedExt = poolSExt[p];
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
            // 两 spill:单 op 无法完成 — 放弃
            return { bail: true, promOffs: [], promRegs: [], extList: [], prIdx: [], prReg: [] };
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
                if (arch === "arm64" && !regionCall) {
                    cands.push(VReg.V7); cands.push(VReg.V6); cands.push(VReg.V5);
                }
                if (!usedS[3]) cands.push(VReg.S3);
                if (!usedS[2]) cands.push(VReg.S2);
                if (!usedS[1]) cands.push(VReg.S1);
                if (!usedS[0]) cands.push(VReg.S0);
                for (let t = 0; t < extList.length; t++) cands.push(extList[t]);
                for (let ci = 0; ci < cands.length; ci++) {
                    const R = cands[ci];
                    let free = true;
                    for (let q = p + 1; q < i; q++) {
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

// asm.js 虚拟机 - 核心抽象层
// 提供统一的指令接口，由后端翻译为目标平台代码

import { VReg } from "./registers.js";
import { OpCode, Instruction } from "./instructions.js";
import { ARM64Backend } from "../backend/arm64.js";
import { X64Backend } from "../backend/x64.js";
import { WasmBackend } from "../backend/wasm32.js";

// [#22 P1] 录制 opcode(整数——gen1 里字符串比较/每 op 数组分配付不起簿记税,
// 首版字符串形态实测自编译 +30%;编号 = 重放链频率序,热 op 先命中)
// 录制上限:超过 REC_CAP 个 op 的函数当场原样冲出并放弃晋升——大函数贡献绝大多数
// op 量(录制/分析/重放税 ~20%),却几乎不受益于单槽晋升;设限后税只落在小函数上。
const REC_CAP = 256;
const RC_STORE = 1;
const RC_LOAD = 2;
const RC_MOV = 3;
const RC_MOVIMM = 4;
const RC_CMPIMM = 5;
const RC_JEQ = 6;
const RC_JNE = 7;
const RC_CALL = 8;
const RC_ADDIMM = 9;
const RC_LABEL = 10;
const RC_CMP = 11;
const RC_JMP = 12;
const RC_ADD = 13;
const RC_PUSH = 14;
const RC_POP = 15;
const RC_SUB = 16;
const RC_SUBIMM = 17;
const RC_LEA = 18;
const RC_JLT = 19;
const RC_JLE = 20;
const RC_JGT = 21;
const RC_JGE = 22;
const RC_MOVIMM64 = 23;
const RC_LOADBYTE = 24;
const RC_STOREBYTE = 25;
const RC_JBE = 26;
const RC_JB = 27;
const RC_JA = 28;
const RC_JAE = 29;
const RC_AND = 30;
const RC_ANDIMM = 31;
const RC_OR = 32;
const RC_ORIMM = 33;
const RC_XOR = 34;
const RC_XORIMM = 35;
const RC_SHLIMM = 36;
const RC_SHRIMM = 37;
const RC_SARIMM = 38;
const RC_SHL = 39;
const RC_SHR = 40;
const RC_SAR = 41;
const RC_MUL = 42;
const RC_DIV = 43;
const RC_MOD = 44;
const RC_NOT = 45;
const RC_NEG = 46;
const RC_TEST = 47;
const RC_TESTIMM = 48;
const RC_PROLOGUE = 49;
const RC_EPILOGUE = 50;
const RC_RET = 51;
const RC_CALLINDIRECT = 52;
const RC_JMPINDIRECT = 53;
const RC_PREPARECALL = 54;
const RC_SYSCALL = 55;
const RC_SYSCALLREG = 56;
const RC_NOP = 57;
const RC_FMOVTOFLOAT = 58;
const RC_FMOVTOINT = 59;
const RC_FADD = 60;
const RC_FSUB = 61;
const RC_FMUL = 62;
const RC_FDIV = 63;
const RC_FCVTZS = 64;
const RC_SCVTF = 65;
const RC_FMOD = 66;
const RC_FCMPZERO = 67;
const RC_FCMP = 68;
const RC_FMOV = 69;
const RC_FABS = 70;
const RC_FNEG = 71;
const RC_FTRUNC = 72;
const RC_FFLOOR = 73;
const RC_FCEIL = 74;
const RC_FROUND = 75;
const RC_FMOVTOINTSINGLE = 76;
const RC_FMOVTOFLOATSINGLE = 77;
const RC_JFLT = 78;
const RC_JFLE = 79;
const RC_JFGT = 80;
const RC_JFGE = 81;
const RC_CALLWINDOWSWRITECONSOLE = 82;
const RC_CALLWINDOWSEXITPROCESS = 83;
const RC_CALLWINDOWSGETCOMMANDLINE = 84;
const RC_CALLWINDOWSAPI = 85;
const RC_CALLIAT = 86;
const RC_JNAN = 87;   // fcmp 后 unordered(任一操作数 NaN)分支:arm64 BVS / x64 JP
const RC_FSQRT = 88;  // 浮点平方根

export class VirtualMachine {
    constructor(arch, os, asm) {
        this._arch = arch;
        this._os = os;
        this.asm = asm;
        this.backend = this._createBackend(arch, os, asm);
        this.instructions = []; // 用于调试/优化
            // [#12 阶段2·窗口版] 紧邻 store→load 转发:仅记录最近一次 FP 槽 store,
        // 用汇编缓冲长度做天然失效(任何字节发射即失效)——零簿记,自举税相容。
        // 全量块内缓存已实验并回退:簿记(每指令属性查找)在自举编译器里净负 5-9%。
        this._sfOff = -1;
        this._sfSrc = null;
        this._sfPos = -1;
        // [#22 P1 槽位提升] 函数体 op 录制(_recN<0 即直发,否则为写入下标)。
        // 编译器在用户函数体周围 beginRecord/endRecord;endRecord 做函数粒度分析
        // (热 FP 槽 → S4)后重放。缓冲为一次性预分配、跨函数复用的扁平并行数组
        // (整数 op 码 + 三个操作数槽,不足补 0),索引写零分配零增长。
        this._recN = -1;
        this._recOp = null;
        this._recA = null;
        this._recB = null;
        this._recC = null;
    }


    // ==================== P1 槽位提升:函数体录制/分析/重放(#22) ====================
    // 阶段2 实测判死逐指令簿记 → 一切分析摊销到函数粒度:先录 op 数组,函数尾
    // 一遍分析 + 一遍重放。嵌套 beginRecord(函数体中途编译内层函数)时把外层
    // 原样冲出并放弃其晋升(保守正确)。
    beginRecord() {
        if (process.env.P1_OFF) return; // 诊断口:整体关闭录制/晋升(注:编译产物读不到 env,仅 node 驱动的构建生效)
        if (this._recN >= 0) {
            this._flushRecordVerbatim(); // 外层放弃晋升
        }
        if (this._recOp === null) {
            this._recOp = [];
            this._recA = [];
            this._recB = [];
            this._recC = [];
            for (let i = 0; i < REC_CAP; i++) {
                this._recOp.push(0);
                this._recA.push(0);
                this._recB.push(0);
                this._recC.push(0);
            }
        }
        this._recN = 0;
    }

    _flushRecordVerbatim() {
        const cnt = this._recN;
        this._recN = -1; // 先置直发:重放经由公开方法,不得再落缓冲
        const ops = this._recOp;
        const ra = this._recA;
        const rb = this._recB;
        const rc = this._recC;
        for (let i = 0; i < cnt; i++) this._replayOp(ops[i], ra[i], rb[i], rc[i]);
    }

    endRecord() {
        if (this._recN < 0) return; // 未在录制(未开录/已被嵌套冲出/超限冲出)
        const cnt = this._recN;
        this._recN = -1;
        const ops = this._recOp;
        const ra = this._recA;
        const rb = this._recB;
        const rc = this._recC;

        // ---- 分析 v3(#29 线性扫描):FP 槽活跃区间 + S 占用 + 回边/调用位置 ----
        // SP 引用/参数区偏移/FP 取址 → 整体放弃(与 P1 同,保守正确)。
        let bail = false;
        const offs = [];
        const cnts = [];
        const firsts = []; // 槽首次访问 op 下标
        const lasts = [];  // 槽末次访问 op 下标
        const usedS = [false, false, false, false, false, false];
        let hasCall = false;
        let hasIndirectJmp = false; // jmpIndirect:控制流不可知 → 区间退化全函数
        const labNames = []; // 已见标签(名字实例通常与跳转同引用;=== 内容等价兜底)
        const labPos = [];
        const backT = []; // 回边 [标签位, 跳转位]
        const backJ = [];
        const markS = (x) => {
            if (x === VReg.S0) usedS[0] = true;
            else if (x === VReg.S1) usedS[1] = true;
            else if (x === VReg.S2) usedS[2] = true;
            else if (x === VReg.S3) usedS[3] = true;
            else if (x === VReg.S4) usedS[4] = true;
            else if (x === VReg.S5) usedS[5] = true;
        };
        const isJumpOp = (n) =>
            n === RC_JMP || n === RC_JEQ || n === RC_JNE ||
            n === RC_JLT || n === RC_JLE || n === RC_JGT || n === RC_JGE ||
            n === RC_JB || n === RC_JBE || n === RC_JA || n === RC_JAE ||
            n === RC_JFLT || n === RC_JFLE || n === RC_JFGT || n === RC_JFGE ||
            n === RC_JNAN;
        for (let i = 0; i < cnt; i++) {
            const n = ops[i];
            if (n === RC_LOAD || n === RC_STORE) {
                const base = (n === RC_LOAD) ? rb[i] : ra[i];
                const off = (n === RC_LOAD) ? rc[i] : rb[i];
                if (base === VReg.FP) {
                    if (off > -48) { bail = true; break; } // 非常规局部区(参数区/别名风险)
                    let found = -1;
                    for (let k = 0; k < offs.length; k++) { if (offs[k] === off) { found = k; break; } }
                    if (found === -1) { offs.push(off); cnts.push(1); firsts.push(i); lasts.push(i); }
                    else { cnts[found] = cnts[found] + 1; lasts[found] = i; }
                } else if (base === VReg.SP) {
                    bail = true; break; // SP 派生访问,保守放弃
                }
                // dest/src/base 若为 S 寄存器(方法体用 S0-S2 跨 call 保活等)→ 占用
                markS(ra[i]); markS(rb[i]); markS(rc[i]);
            } else if (n === RC_LABEL) {
                labNames.push(ra[i]);
                labPos.push(i);
            } else if (n !== RC_PROLOGUE && n !== RC_EPILOGUE) {
                // 任何操作数引用 SP/FP(取址/搬运)→ 放弃(空槽为 0,不会误判)
                const a = ra[i];
                const b = rb[i];
                const c = rc[i];
                if (a === VReg.SP || a === VReg.FP || b === VReg.SP || b === VReg.FP || c === VReg.SP || c === VReg.FP) {
                    bail = true; break;
                }
                markS(a); markS(b); markS(c);
                if (n === RC_CALL || n === RC_CALLINDIRECT ||
                    n === RC_CALLIAT || n === RC_CALLWINDOWSAPI ||
                    n === RC_CALLWINDOWSWRITECONSOLE || n === RC_CALLWINDOWSEXITPROCESS ||
                    n === RC_CALLWINDOWSGETCOMMANDLINE) {
                    hasCall = true;
                } else if (n === RC_JMPINDIRECT) {
                    hasIndirectJmp = true;
                } else if (isJumpOp(n)) {
                    // 目标标签已见 → 回边(循环);前向跳不构环,忽略
                    for (let k = labNames.length - 1; k >= 0; k--) {
                        if (labNames[k] === a) { backT.push(labPos[k]); backJ.push(i); break; }
                    }
                }
            }
        }

        // ---- 回边扩展到不动点:区间与循环 [t,j] 相交 → 并入整个循环 ----
        // (跨回边存活的值不得被区间复用者踩;jmpIndirect 时退化为全函数区间)
        if (!bail && offs.length > 0) {
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

        // ---- 分配(#29 线性扫描):槽活跃区间 → callee-saved 寄存器,区间复用 ----
        // 寄存器池:体内未占用的 S0-S3(零成本:prologue 本就保存,全调用链
        //   callee-saved 契约成立含运行时;偏好 S3→S0——运行时 helper 从 S0/S1
        //   保存起,晋升那里会形成 call 后恢复-装载依赖链,实测 num ±40%);
        //   S4 计费扩展(整函数任一分配即扩展 prologue);S5 仅 arm64 叶子
        //   (_strconcat 冲 S5 且传递不可知;x64 S5 是栈槽)。
        // 线性扫描:区间按起点排序,active 过期即归还寄存器 → 不相交区间共享。
        // 落选即"不晋升"(维持内存槽),永远 sound,无溢出代码。
        // 异常无碍:throw 是函数内 jmp exceptionLabel,无跨函数 unwind。
        const promOffs = [];
        const promRegs = [];
        const extList = []; // 实际启用的扩展寄存器(须入 prologue/epilogue,整函数一次)
        if (!bail && offs.length > 0) {
            const pool = [];      // 寄存器池(顺序即偏好)
            const poolExt = [];   // 对应位是否计费(S4/S5)
            if (!usedS[3]) { pool.push(VReg.S3); poolExt.push(false); }
            if (!usedS[2]) { pool.push(VReg.S2); poolExt.push(false); }
            if (!usedS[1]) { pool.push(VReg.S1); poolExt.push(false); }
            if (!usedS[0]) { pool.push(VReg.S0); poolExt.push(false); }
            if (!usedS[4]) { pool.push(VReg.S4); poolExt.push(true); }
            if (!usedS[5] && !hasCall && this._arch === "arm64") { pool.push(VReg.S5); poolExt.push(true); }

            if (pool.length > 0) {
                // 候选槽按区间起点升序(选择排序;REC_CAP 约束下规模小)
                const order = [];
                for (let k = 0; k < offs.length; k++) order.push(k);
                for (let x = 0; x < order.length; x++) {
                    let m = x;
                    for (let y = x + 1; y < order.length; y++) {
                        if (firsts[order[y]] < firsts[order[m]]) m = y;
                    }
                    const tmp = order[x]; order[x] = order[m]; order[m] = tmp;
                }
                const poolBusyUntil = []; // 每寄存器的占用截止 op 下标(-1 空闲)
                for (let p = 0; p < pool.length; p++) poolBusyUntil.push(-1);
                for (let x = 0; x < order.length; x++) {
                    const k = order[x];
                    // 门槛:免费位 ≥2 次,计费位 ≥4 次
                    for (let p = 0; p < pool.length; p++) {
                        if (poolBusyUntil[p] >= firsts[k]) continue; // 区间重叠,占用中
                        const minUse = poolExt[p] ? 4 : 2;
                        if (cnts[k] < minUse) continue;
                        poolBusyUntil[p] = lasts[k];
                        promOffs.push(offs[k]);
                        promRegs.push(pool[p]);
                        if (poolExt[p]) {
                            let seen = false;
                            for (let t = 0; t < extList.length; t++) { if (extList[t] === pool[p]) { seen = true; break; } }
                            if (!seen) extList.push(pool[p]);
                        }
                        break;
                    }
                }
            }
        }
        const promote = promOffs.length > 0;

        // ---- push/pop 对虚拟化(#29 二期"无限虚寄存器"第一刀)----
        // 表达式操作数暂存的栈往返(push src … pop dst)改写为空闲寄存器 mov。
        // 保守约束(保证 sound):区域内无标签/跳转/间接跳/嵌套 prologue/epilogue/ret
        // (单入单出直线区);V 寄存器仅 arm64 且区域无 call(后端 scratchReg 恒选
        // X16/X17,V5-V7=X13-X15 从不被下沉当临时;x64 下沉仍用 R10/R11=V5/V6,
        // V7=RSI=A1 别名,故 x64 只用 S);S 须全函数未占用且与槽分配/已改写对
        // 区间不重叠;配对不平衡(录制截断等)整体放弃。紧邻对留给后端窥孔。
        const prIdx = [];
        const prReg = [];
        if (!bail && cnt > 0 && !hasIndirectJmp) {
            // 槽分配的寄存器占用区间(避让用)
            const busyReg = [];
            const busyS = [];
            const busyE = [];
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
            const isCallOp = (m) =>
                m === RC_CALL || m === RC_CALLINDIRECT || m === RC_CALLIAT ||
                m === RC_CALLWINDOWSAPI || m === RC_CALLWINDOWSWRITECONSOLE ||
                m === RC_CALLWINDOWSEXITPROCESS || m === RC_CALLWINDOWSGETCOMMANDLINE ||
                m === RC_SYSCALL || m === RC_SYSCALLREG || m === RC_PREPARECALL; // 保守:V 池一律避开
            let pairOk = true;
            const stk = [];
            for (let i = 0; i < cnt && pairOk; i++) {
                const n = ops[i];
                if (n === RC_PUSH) {
                    stk.push(i);
                } else if (n === RC_POP) {
                    if (stk.length === 0) { pairOk = false; break; }
                    const p = stk.pop();
                    if (i <= p + 1) continue; // 紧邻对:后端窥孔做字节级撤销,更优
                    let ok = true;
                    let regionCall = false;
                    for (let q = p + 1; q < i; q++) {
                        const m = ops[q];
                        if (m === RC_LABEL || m === RC_PROLOGUE || m === RC_EPILOGUE ||
                            m === RC_RET || m === RC_JMPINDIRECT || isJumpOp(m)) { ok = false; break; }
                        if (isCallOp(m)) regionCall = true;
                    }
                    if (!ok) continue;
                    const cands = [];
                    if (this._arch === "arm64" && !regionCall) {
                        cands.push(VReg.V7); cands.push(VReg.V6); cands.push(VReg.V5);
                    }
                    if (!usedS[3]) cands.push(VReg.S3);
                    if (!usedS[2]) cands.push(VReg.S2);
                    if (!usedS[1]) cands.push(VReg.S1);
                    if (!usedS[0]) cands.push(VReg.S0);
                    for (let t = 0; t < extList.length; t++) cands.push(extList[t]); // 已计费的 S4/S5 顺带可用
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
                        busyReg.push(R); busyS.push(p); busyE.push(i); // 供后续对避让
                        break;
                    }
                }
            }
            if (!pairOk || stk.length !== 0) {
                // 不平衡:放弃全部改写(标记数组用哨兵重建,避免 length 截断)
                while (prIdx.length > 0) { prIdx.pop(); prReg.pop(); }
            }
        }

        // ---- 重放(晋升槽 load/store → 寄存器 mov;push/pop 对 → mov;
        //      prologue/epilogue 按需扩展) ----
        for (let i = 0; i < cnt; i++) {
            const n = ops[i];
            if ((n === RC_PUSH || n === RC_POP) && prIdx.length > 0) {
                let pr = null;
                for (let k = 0; k < prIdx.length; k++) { if (prIdx[k] === i) { pr = prReg[k]; break; } }
                if (pr !== null) {
                    if (n === RC_PUSH) {
                        if (ra[i] !== pr) this.mov(pr, ra[i]);
                    } else {
                        if (ra[i] !== pr) this.mov(ra[i], pr);
                    }
                    continue;
                }
            }
            if (promote) {
                if (n === RC_LOAD && rb[i] === VReg.FP) {
                    let pr = null;
                    for (let k = 0; k < promOffs.length; k++) { if (promOffs[k] === rc[i]) { pr = promRegs[k]; break; } }
                    if (pr !== null) {
                        if (ra[i] !== pr) this.mov(ra[i], pr);
                        continue;
                    }
                }
                if (n === RC_STORE && ra[i] === VReg.FP) {
                    let pr = null;
                    for (let k = 0; k < promOffs.length; k++) { if (promOffs[k] === rb[i]) { pr = promRegs[k]; break; } }
                    if (pr !== null) {
                        this.mov(pr, rc[i]);
                        continue;
                    }
                }
                // 偶数对齐垫:须选 caller-saved 且不与 RET 别名的寄存器。
                // arm64 用 V0(X8,与 RET=X0 独立,恢复垃圾无害;保持产物逐字节不变);
                // x64 的 V0=RAX=RET——epilogue pop 会把返回值冲成 prologue 时的旧 RAX
                // (#37 rest.length 假 0 根因),改用 V5(R10,后端下沉临时,边界无活值)。
                const padReg = this._arch === "x64" ? VReg.V5 : VReg.V0;
                if (extList.length > 0 && n === RC_PROLOGUE) {
                    const ext = rb[i].slice();
                    for (let k = 0; k < extList.length; k++) ext.push(extList[k]);
                    if ((ext.length & 1) === 1) ext.push(padReg);
                    this.prologue(ra[i], ext);
                    continue;
                }
                if (extList.length > 0 && n === RC_EPILOGUE) {
                    const ext = ra[i].slice();
                    for (let k = 0; k < extList.length; k++) ext.push(extList[k]);
                    if ((ext.length & 1) === 1) ext.push(padReg);
                    this.epilogue(ext, rb[i]);
                    continue;
                }
            }
            this._replayOp(n, ra[i], rb[i], rc[i]);
        }
    }

    _replayOp(n, a, b, c) {
        if (n === RC_STORE) { this.store(a, b, c); return; }
        if (n === RC_LOAD) { this.load(a, b, c); return; }
        if (n === RC_MOV) { this.mov(a, b); return; }
        if (n === RC_MOVIMM) { this.movImm(a, b); return; }
        if (n === RC_CMPIMM) { this.cmpImm(a, b); return; }
        if (n === RC_JEQ) { this.jeq(a); return; }
        if (n === RC_JNE) { this.jne(a); return; }
        if (n === RC_CALL) { this.call(a); return; }
        if (n === RC_ADDIMM) { this.addImm(a, b, c); return; }
        if (n === RC_LABEL) { this.label(a); return; }
        if (n === RC_CMP) { this.cmp(a, b); return; }
        if (n === RC_JMP) { this.jmp(a); return; }
        if (n === RC_ADD) { this.add(a, b, c); return; }
        if (n === RC_PUSH) { this.push(a); return; }
        if (n === RC_POP) { this.pop(a); return; }
        if (n === RC_SUB) { this.sub(a, b, c); return; }
        if (n === RC_SUBIMM) { this.subImm(a, b, c); return; }
        if (n === RC_LEA) { this.lea(a, b); return; }
        if (n === RC_JLT) { this.jlt(a); return; }
        if (n === RC_JLE) { this.jle(a); return; }
        if (n === RC_JGT) { this.jgt(a); return; }
        if (n === RC_JGE) { this.jge(a); return; }
        if (n === RC_MOVIMM64) { this.movImm64(a, b); return; }
        if (n === RC_LOADBYTE) { this.loadByte(a, b, c); return; }
        if (n === RC_STOREBYTE) { this.storeByte(a, b, c); return; }
        if (n === RC_JBE) { this.jbe(a); return; }
        if (n === RC_JB) { this.jb(a); return; }
        if (n === RC_JA) { this.ja(a); return; }
        if (n === RC_JAE) { this.jae(a); return; }
        if (n === RC_AND) { this.and(a, b, c); return; }
        if (n === RC_ANDIMM) { this.andImm(a, b, c); return; }
        if (n === RC_OR) { this.or(a, b, c); return; }
        if (n === RC_ORIMM) { this.orImm(a, b, c); return; }
        if (n === RC_XOR) { this.xor(a, b, c); return; }
        if (n === RC_XORIMM) { this.xorImm(a, b, c); return; }
        if (n === RC_SHLIMM) { this.shlImm(a, b, c); return; }
        if (n === RC_SHRIMM) { this.shrImm(a, b, c); return; }
        if (n === RC_SARIMM) { this.sarImm(a, b, c); return; }
        if (n === RC_SHL) { this.shl(a, b, c); return; }
        if (n === RC_SHR) { this.shr(a, b, c); return; }
        if (n === RC_SAR) { this.sar(a, b, c); return; }
        if (n === RC_MUL) { this.mul(a, b, c); return; }
        if (n === RC_DIV) { this.div(a, b, c); return; }
        if (n === RC_MOD) { this.mod(a, b, c); return; }
        if (n === RC_NOT) { this.not(a, b); return; }
        if (n === RC_NEG) { this.neg(a, b); return; }
        if (n === RC_TEST) { this.test(a, b); return; }
        if (n === RC_TESTIMM) { this.testImm(a, b); return; }
        if (n === RC_PROLOGUE) { this.prologue(a, b); return; }
        if (n === RC_EPILOGUE) { this.epilogue(a, b); return; }
        if (n === RC_RET) { this.ret(); return; }
        if (n === RC_CALLINDIRECT) { this.callIndirect(a); return; }
        if (n === RC_JMPINDIRECT) { this.jmpIndirect(a); return; }
        if (n === RC_PREPARECALL) { this.prepareCall(a); return; }
        if (n === RC_SYSCALL) { this.syscall(a); return; }
        if (n === RC_SYSCALLREG) { this.syscallReg(a); return; }
        if (n === RC_NOP) { this.nop(); return; }
        if (n === RC_FMOVTOFLOAT) { this.fmovToFloat(a, b); return; }
        if (n === RC_FMOVTOINT) { this.fmovToInt(a, b); return; }
        if (n === RC_FADD) { this.fadd(a, b, c); return; }
        if (n === RC_FSUB) { this.fsub(a, b, c); return; }
        if (n === RC_FMUL) { this.fmul(a, b, c); return; }
        if (n === RC_FDIV) { this.fdiv(a, b, c); return; }
        if (n === RC_FCVTZS) { this.fcvtzs(a, b); return; }
        if (n === RC_SCVTF) { this.scvtf(a, b); return; }
        if (n === RC_FMOD) { this.fmod(a, b, c); return; }
        if (n === RC_FCMPZERO) { this.fcmpZero(a); return; }
        if (n === RC_FCMP) { this.fcmp(a, b); return; }
        if (n === RC_FMOV) { this.fmov(a, b); return; }
        if (n === RC_FABS) { this.fabs(a, b); return; }
        if (n === RC_FNEG) { this.fneg(a, b); return; }
        if (n === RC_FTRUNC) { this.ftrunc(a, b); return; }
        if (n === RC_FFLOOR) { this.ffloor(a, b); return; }
        if (n === RC_FCEIL) { this.fceil(a, b); return; }
        if (n === RC_FROUND) { this.fround(a, b); return; }
        if (n === RC_FMOVTOINTSINGLE) { this.fmovToIntSingle(a, b); return; }
        if (n === RC_FMOVTOFLOATSINGLE) { this.fmovToFloatSingle(a, b); return; }
        if (n === RC_JFLT) { this.jflt(a); return; }
        if (n === RC_JFLE) { this.jfle(a); return; }
        if (n === RC_JFGT) { this.jfgt(a); return; }
        if (n === RC_JFGE) { this.jfge(a); return; }
        if (n === RC_JNAN) { this.jnan(a); return; }
        if (n === RC_FSQRT) { this.fsqrt(a, b); return; }
        if (n === RC_CALLWINDOWSWRITECONSOLE) { this.callWindowsWriteConsole(); return; }
        if (n === RC_CALLWINDOWSEXITPROCESS) { this.callWindowsExitProcess(); return; }
        if (n === RC_CALLWINDOWSGETCOMMANDLINE) { this.callWindowsGetCommandLine(); return; }
        if (n === RC_CALLWINDOWSAPI) { this.callWindowsAPI(a); return; }
        if (n === RC_CALLIAT) { this.callIAT(a); return; }
        throw new Error("replay: unknown op " + n);
    }

    _createBackend(arch, os, asm) {
        if (arch === "arm64") {
            return new ARM64Backend(asm, os);
        } else if (arch === "wasm32") {
            return new WasmBackend(asm, os);
        } else {
            return new X64Backend(asm, os);
        }
    }

    // ========== 平台信息 ==========

    // 获取架构名称 (arm64, x64)
    get arch() {
        return this._arch;
    }

    // 获取平台名称 (linux, macos, windows)
    get platform() {
        return this._os;
    }

    // 获取操作系统 (platform 的别名)
    get os() {
        return this._os;
    }

    // 目标可执行文件的镜像基址（合法指针下界 floor）。
    // 运行时用它把「损坏的裸串/被当指针的小地址垃圾」挡在解引用之外：
    // 合法的数据段/堆指针恒 >= 镜像基址。基址随目标格式不同：
    //   ELF(linux)=0x400000, Mach-O(macos)=0x100000000, PE(windows)=0x140000000。
    // 注意：macos/windows 保持历史 0x100000000（windows 指针 >=0x140000000 仍通过），
    // 只有 linux 需要下调，否则数据段字符串常量(0x40xxxx)全被误判为损坏 → 返回空串。
    get ptrFloor() {
        // wasi:线性内存地址小,取与 linux 相同的 2^22(代码序号空间/数据段/堆均 >= 4MB,
        // 影子栈在其下——栈地址本就不该被当装箱指针)。
        if (this._os === "wasi") return 0x400000n;
        return this._os === "linux" ? 0x400000n : 0x100000000n;
    }

    // ========== 数据移动 ==========

    // 寄存器到寄存器
    mov(dest, src) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_MOV; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.mov(dest, src);
    }

    // 立即数到寄存器
    movImm(dest, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_MOVIMM; this._recA[k] = dest; this._recB[k] = imm; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.movImm(dest, imm);
    }

    // 64位立即数到寄存器 (用于 BigInt 或大数)
    movImm64(dest, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_MOVIMM64; this._recA[k] = dest; this._recB[k] = imm; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.movImm64(dest, imm);
    }

    // 从内存加载: dest = [base + offset]
    load(dest, base, offset) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_LOAD; this._recA[k] = dest; this._recB[k] = base; this._recC[k] = offset; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        // 紧邻 store→load 转发:store [FP+k],src 后一条就是 load [FP+k] 时,
        // src 必仍持槽值(中间零字节发射)→ 省 load 或改 reg-reg mov。
        if (base === VReg.FP && offset === this._sfOff && this._sfPos === this.asm.code.length) {
            if (dest === this._sfSrc) return; // 值已在原寄存器,整条省略(可连续命中)
            this.backend.mov(dest, this._sfSrc);
            return;
        }
        this.backend.load(dest, base, offset);
    }

    // 加载字节: dest = [base + offset] (零扩展)
    loadByte(dest, base, offset) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_LOADBYTE; this._recA[k] = dest; this._recB[k] = base; this._recC[k] = offset; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.loadByte(dest, base, offset);
    }

    // 存储到内存: [base + offset] = src
    store(base, offset, src) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_STORE; this._recA[k] = base; this._recB[k] = offset; this._recC[k] = src; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.store(base, offset, src);
        if (base === VReg.FP) {
            this._sfOff = offset;
            this._sfSrc = src;
            this._sfPos = this.asm.code.length;
        } else {
            this._sfOff = -1; // SP/派生指针可能别名栈槽
        }
    }

    // 存储字节到内存: [base + offset] = src (低8位)
    storeByte(base, offset, src) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_STOREBYTE; this._recA[k] = base; this._recB[k] = offset; this._recC[k] = src; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.storeByte(base, offset, src);
        this._sfOff = -1;
    }

    // 加载标签地址
    lea(dest, label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_LEA; this._recA[k] = dest; this._recB[k] = label; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.lea(dest, label);
    }

    // [M2 / G-M-P] 把当前 M 上下文指针绑定到平台保留的 P/M 寄存器(arm64=x28)。
    // 仅在 _start / 线程蹦床(未来 M3)调用——这些点在录制区之外,直接落后端;
    // 无 bindContextReg 的后端(x64 无空闲 GPR、wasm)为 no-op(段寄存器 TLS 后续),
    // GOMAXPROCS=1 语义不受影响。docs/PARALLEL_DESIGN.md §3。
    bindMContext(srcReg) {
        if (this.backend.bindContextReg) this.backend.bindContextReg(srcReg);
    }

    // [argc ABI] 运行时闭包调用点前置实参个数:_call_argc = n。tmpA/tmpB 为该
    // 调用点当下空闲的两个 scratch(勿传 A0-A5/已装参寄存器)。
    setCallArgcImm(n, tmpA, tmpB) {
        this.lea(tmpA, "_call_argc");
        this.movImm(tmpB, n);
        this.store(tmpA, 0, tmpB);
    }

    // ========== 算术运算 ==========

    add(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_ADD; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.add(dest, a, b);
    }

    addImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_ADDIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.addImm(dest, src, imm);
    }

    sub(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SUB; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.sub(dest, a, b);
    }

    subImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SUBIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.subImm(dest, src, imm);
    }

    mul(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_MUL; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.mul(dest, a, b);
    }

    div(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_DIV; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.div(dest, a, b);
    }

    mod(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_MOD; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.mod(dest, a, b);
    }

    // ========== 位运算 ==========

    and(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_AND; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.and(dest, a, b);
    }

    or(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_OR; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.or(dest, a, b);
    }

    xor(dest, a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_XOR; this._recA[k] = dest; this._recB[k] = a; this._recC[k] = b; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.xor(dest, a, b);
    }

    shl(dest, src, count) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SHL; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = count; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.shl(dest, src, count);
    }

    shlImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SHLIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.shlImm(dest, src, imm);
    }

    shr(dest, src, count) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SHR; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = count; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.shr(dest, src, count);
    }

    shrImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SHRIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.shrImm(dest, src, imm);
    }

    // 算术右移 (保留符号位)
    sar(dest, src, count) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SAR; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = count; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.sar(dest, src, count);
    }

    sarImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SARIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.sarImm(dest, src, imm);
    }

    // 按位非
    not(dest, src) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_NOT; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.not(dest, src);
    }

    // 取反 (0 - x)
    neg(dest, src) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_NEG; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.neg(dest, src);
    }

    // 位测试 (AND but only sets flags)
    test(a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_TEST; this._recA[k] = a; this._recB[k] = b; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.test(a, b);
    }

    testImm(a, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_TESTIMM; this._recA[k] = a; this._recB[k] = imm; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.testImm(a, imm);
    }

    // 立即数版本的位运算
    andImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_ANDIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.andImm(dest, src, imm);
    }

    // ── 装箱值负载掩码(0x0000FFFFFFFFFFFF)后端分派原语 ──────────────────────────
    // 内联 `movImm64(reg, mask); and(dest, src, reg)` 的等价拆分,按后端择优:
    //   • emitMaskLoad(reg):   arm64 → 空发射(AND-immediate 无需先物化掩码);
    //                           x64   → movImm64(reg, mask)(与今日逐字节一致)。
    //   • andMaskReg(d,s,reg): arm64 → andImm(d,s,mask)(单条 bitmask-imm,仅经此到达
    //                                   arm64.andImm 的掩码特例,x64 永不触);
    //                           x64   → and(d,s,reg)(与今日逐字节一致)。
    // 二者都委托到既有可录制方法(movImm64/and/andImm),故 P1 录制/重放透明,无需新
    // opcode。x64 发射序列 = 今日的 movImm64+and,同序同寄存器 → 逐字节不变。
    emitMaskLoad(reg) {
        if (this._arch === "arm64") return; // arm64:掩码由 AND-imm 内含,无需物化
        this.movImm64(reg, 0x0000ffffffffffffn);
    }

    andMaskReg(dest, src, maskReg) {
        if (this._arch === "arm64") {
            this.andImm(dest, src, 0x0000ffffffffffffn);
        } else {
            this.and(dest, src, maskReg);
        }
    }

    orImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_ORIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.orImm(dest, src, imm);
    }

    xorImm(dest, src, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_XORIMM; this._recA[k] = dest; this._recB[k] = src; this._recC[k] = imm; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.xorImm(dest, src, imm);
    }

    // 无符号比较跳转
    jb(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JB; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jb(label);
    }

    jbe(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JBE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jbe(label);
    }

    ja(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JA; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.ja(label);
    }

    jae(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JAE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jae(label);
    }

    // 系统调用
    syscall(num) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SYSCALL; this._recA[k] = num; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.syscall(num);
    }

    // Windows API 调用
    callWindowsWriteConsole() {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALLWINDOWSWRITECONSOLE; this._recA[k] = 0; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        if (this.backend.callWindowsWriteConsole) {
            this.backend.callWindowsWriteConsole();
        }
    }

    callWindowsExitProcess() {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALLWINDOWSEXITPROCESS; this._recA[k] = 0; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        if (this.backend.callWindowsExitProcess) {
            this.backend.callWindowsExitProcess();
        }
    }

    // GetCommandLineA() -> 命令行字符串指针(RET)
    callWindowsGetCommandLine() {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALLWINDOWSGETCOMMANDLINE; this._recA[k] = 0; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        if (this.backend.callWindowsGetCommandLine) {
            this.backend.callWindowsGetCommandLine();
        }
    }

    // Windows API 通用调用 (通过 IAT slot)
    callWindowsAPI(slotIndex) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALLWINDOWSAPI; this._recA[k] = slotIndex; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        if (this.backend.callWindowsAPI) {
            this.backend.callWindowsAPI(slotIndex);
        }
    }

    // Windows API 调用 (通过函数名或 slot)
    callIAT(funcNameOrSlot) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALLIAT; this._recA[k] = funcNameOrSlot; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        if (this.backend.callIAT) {
            this.backend.callIAT(funcNameOrSlot);
        }
    }

    // ========== 比较与跳转 ==========

    cmp(a, b) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CMP; this._recA[k] = a; this._recB[k] = b; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.cmp(a, b);
    }

    cmpImm(a, imm) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CMPIMM; this._recA[k] = a; this._recB[k] = imm; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.cmpImm(a, imm);
    }

    jmp(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JMP; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jmp(label);
    }

    jeq(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JEQ; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jeq(label);
    }

    jne(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JNE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jne(label);
    }

    jlt(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JLT; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jlt(label);
    }

    jle(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JLE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jle(label);
    }

    jgt(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JGT; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jgt(label);
    }

    jge(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JGE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jge(label);
    }

    // 浮点比较跳转：arm64 映射到与整数相同的有符号条件码；
    // x64 映射到无符号条件码（ucomisd 后 CF/ZF 有效）。
    jflt(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JFLT; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jflt(label);
    }

    jfle(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JFLE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jfle(label);
    }

    jfgt(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JFGT; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jfgt(label);
    }

    jfge(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JFGE; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jfge(label);
    }

    // fcmp 后跳转:任一操作数为 NaN(unordered)则跳。arm64 BVS(V=1)/x64 JP(PF=1)。
    jnan(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JNAN; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jnan(label);
    }

    // ========== 函数调用 ==========

    // 函数序言
    prologue(stackSize, savedRegs) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_PROLOGUE; this._recA[k] = stackSize; this._recB[k] = savedRegs; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.prologue(stackSize, savedRegs || []);
    }

    // 函数尾声
    epilogue(savedRegs, stackSize) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_EPILOGUE; this._recA[k] = savedRegs; this._recB[k] = stackSize; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.epilogue(savedRegs || [], stackSize || 0);
    }

    // 调用函数
    call(label) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALL; this._recA[k] = label; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.call(label);
    }

    // 间接调用（通过寄存器）
    callIndirect(reg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_CALLINDIRECT; this._recA[k] = reg; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        if (this.backend.callIndirect) {
            this.backend.callIndirect(reg);
        } else {
            // 后备实现
            this.backend.callReg(reg);
        }
    }

    // [引擎库] cache 维护指令(仅用于 runtime 生成器,非录制上下文;录制时先冲刷)。
    dcCvau(reg) { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.dcCvau(reg); }
    icIvau(reg) { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.icIvau(reg); }
    dsbIsh() { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.dsbIsh(); }
    isb() { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.isb(); }

    // [M3] 原子 RMW 原语(仅并行调度器 runtime 生成器发射,非录制上下文)。
    ldaxr(dst, addr) { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.ldaxr(dst, addr); }
    stlxr(status, val, addr) { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.stlxr(status, val, addr); }
    clrex() { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.clrex(); }
    stlr(val, addr) { if (this._recN >= 0) this._flushRecordVerbatim(); this.backend.stlr(val, addr); }

    // 间接跳转（通过寄存器，不保存返回地址）
    jmpIndirect(reg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_JMPINDIRECT; this._recA[k] = reg; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.jmpIndirect(reg);
    }

    // 返回
    ret() {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_RET; this._recA[k] = 0; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.ret();
    }

    // ========== 高级调用辅助 ==========

    // 准备函数调用参数
    // args: [{ reg: VReg, value: VReg|number }]
    prepareCall(args) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_PREPARECALL; this._recA[k] = args; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.prepareCall(args);
    }

    // 获取第 n 个参数寄存器
    getArgReg(n) {
        return this.backend.getArgReg(n);
    }

    syscallReg(reg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SYSCALLREG; this._recA[k] = reg; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.syscallReg(reg);
    }

    // 获取返回值寄存器
    getRetReg() {
        return VReg.RET;
    }

    // ========== 栈操作 ==========

    push(reg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_PUSH; this._recA[k] = reg; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.push(reg);
    }

    pop(reg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_POP; this._recA[k] = reg; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.pop(reg);
    }

    // ========== 标签与其他 ==========

    label(name) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_LABEL; this._recA[k] = name; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this._sfOff = -1; // 跳转汇入点,且 label 零字节发射,须显式失效
        this.backend.label(name);
    }

    nop() {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_NOP; this._recA[k] = 0; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.nop();
    }

    // Float to Int conversion (for array indexing etc.)
    // Takes a Number object and extracts integer value
    f2i(dest, src) {
        this.backend.f2i(dest, src);
    }

    // ========== 浮点运算 (跨平台抽象) ==========

    // 将整数寄存器的位模式移动到浮点寄存器
    // fpReg: 浮点寄存器编号 (0-7), gpReg: 虚拟寄存器
    fmovToFloat(fpReg, gpReg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMOVTOFLOAT; this._recA[k] = fpReg; this._recB[k] = gpReg; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmovToFloat(fpReg, gpReg);
    }

    // 将浮点寄存器的位模式移动到整数寄存器
    fmovToInt(gpReg, fpReg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMOVTOINT; this._recA[k] = gpReg; this._recB[k] = fpReg; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmovToInt(gpReg, fpReg);
    }

    // 浮点加法: fpDest = fpA + fpB
    fadd(fpDest, fpA, fpB) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FADD; this._recA[k] = fpDest; this._recB[k] = fpA; this._recC[k] = fpB; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fadd(fpDest, fpA, fpB);
    }

    // 浮点减法: fpDest = fpA - fpB
    fsub(fpDest, fpA, fpB) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FSUB; this._recA[k] = fpDest; this._recB[k] = fpA; this._recC[k] = fpB; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fsub(fpDest, fpA, fpB);
    }

    // 浮点乘法: fpDest = fpA * fpB
    fmul(fpDest, fpA, fpB) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMUL; this._recA[k] = fpDest; this._recB[k] = fpA; this._recC[k] = fpB; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmul(fpDest, fpA, fpB);
    }

    // 浮点除法: fpDest = fpA / fpB
    fdiv(fpDest, fpA, fpB) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FDIV; this._recA[k] = fpDest; this._recB[k] = fpA; this._recC[k] = fpB; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fdiv(fpDest, fpA, fpB);
    }

    // 浮点转整数 (截断): gpDest = trunc(fpSrc)
    fcvtzs(gpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FCVTZS; this._recA[k] = gpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fcvtzs(gpDest, fpSrc);
    }

    // 浮点取模: fpDest = fpA % fpB
    fmod(fpDest, fpA, fpB) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMOD; this._recA[k] = fpDest; this._recB[k] = fpA; this._recC[k] = fpB; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmod(fpDest, fpA, fpB);
    }

    // 浮点比较与零
    fcmpZero(fpReg) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FCMPZERO; this._recA[k] = fpReg; this._recB[k] = 0; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fcmpZero(fpReg);
    }

    // 浮点绝对值: fpDest = abs(fpSrc)
    fabs(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FABS; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fabs(fpDest, fpSrc);
    }

    // 浮点取反: fpDest = -fpSrc
    fneg(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FNEG; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fneg(fpDest, fpSrc);
    }

    // 浮点截断: fpDest = trunc(fpSrc)
    ftrunc(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FTRUNC; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.ftrunc(fpDest, fpSrc);
    }

    // 浮点向下取整 (floor): fpDest = floor(fpSrc)
    ffloor(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FFLOOR; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.ffloor(fpDest, fpSrc);
    }

    // 浮点向上取整 (ceil): fpDest = ceil(fpSrc)
    fceil(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FCEIL; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fceil(fpDest, fpSrc);
    }

    // 浮点四舍五入: fpDest = round(fpSrc)
    fround(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FROUND; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fround(fpDest, fpSrc);
    }

    // 浮点平方根: fpDest = sqrt(fpSrc)
    fsqrt(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FSQRT; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fsqrt(fpDest, fpSrc);
    }

    // 整数转浮点: fpDest = (double)gpSrc
    scvtf(fpDest, gpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_SCVTF; this._recA[k] = fpDest; this._recB[k] = gpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.scvtf(fpDest, gpSrc);
    }

    // 双精度转单精度: fpDest = (float)fpSrc
    fcvtd2s(fpDest, fpSrc) {
        this.backend.fcvtd2s(fpDest, fpSrc);
    }

    // 单精度转双精度: fpDest = (double)fpSrc
    fcvts2d(fpDest, fpSrc) {
        this.backend.fcvts2d(fpDest, fpSrc);
    }

    // 将单精度浮点寄存器的位模式移到整数寄存器 (32位)
    fmovToIntSingle(gpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMOVTOINTSINGLE; this._recA[k] = gpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmovToIntSingle(gpDest, fpSrc);
    }

    // 将单精度整数位模式移到浮点寄存器
    fmovToFloatSingle(fpDest, gpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMOVTOFLOATSINGLE; this._recA[k] = fpDest; this._recB[k] = gpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmovToFloatSingle(fpDest, gpSrc);
    }

    // 浮点比较两个寄存器
    fcmp(fpA, fpB) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FCMP; this._recA[k] = fpA; this._recB[k] = fpB; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fcmp(fpA, fpB);
    }

    // 浮点移动 (寄存器间)
    fmov(fpDest, fpSrc) {
        if (this._recN >= 0) { const k = this._recN; if (k < REC_CAP) { this._recOp[k] = RC_FMOV; this._recA[k] = fpDest; this._recB[k] = fpSrc; this._recC[k] = 0; this._recN = k + 1; return; } this._flushRecordVerbatim(); }
        this.backend.fmov(fpDest, fpSrc);
    }

    // ========== 辅助方法 ==========

    _emit(op, operands) {
        this.instructions.push(new Instruction(op, operands));
    }

    // 获取底层汇编器（用于特殊情况）
    getAsm() {
        return this.backend.asm;
    }

    // 清空指令记录
    reset() {
        this.instructions = [];
    }

    // 打印指令序列（调试用）
    dump() {
        for (let inst of this.instructions) {
            console.log("  " + inst.toString());
        }
    }
}

export { VReg } from "./registers.js";
export { OpCode } from "./instructions.js";

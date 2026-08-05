// asm.js ARM64 后端
// 将虚拟指令翻译为 ARM64 机器码

import { Backend } from "./base.js";
import { VReg } from "../vm/registers.js";

// [M2 / G-M-P] per-M 槽重定向表(docs/PARALLEL_DESIGN.md §1.2 D 组)。对这些全局
// 标签的 lea 在 arm64 改为 `add xd, x28, #OFF`(x28 = 当前 M 上下文,_start 绑定
// &_m0_context)→ 迁入的执行态槽随执行线程走。偏移**必须**与
// runtime/core/allocator.js 的 MCTX_* 严格一致。AOT 代码与 L2 引擎 _engine_symaddr
// 表(同走 vm.lea)因此一致寻址同一槽。x64/wasm 后端不重定向,保留扁平数据标签
// (runtime/core/process.js 仍声明这些 label 供其使用);段寄存器 TLS 见 §3.2(后续)。
const M_CTX_REDIRECT = {
    "_exception_pending": 48, // MCTX_EXC_PENDING
    "_exception_value": 56,   // MCTX_EXC_VALUE
    "_exc_ctx_top": 64,       // MCTX_EXC_CTX_TOP(try 帧链头;帧在栈上,值随线程)
    "_call_argc": 40,         // MCTX_CALL_ARGC(最热 ABI 槽;每调用点写、被调 prologue 读)
    "_gen_last_coro": 104,    // MCTX_GEN_LAST_CORO(生成器 stub 回填 scratch;裸协程指针,随线程)
    "_parse_lenient": 88,     // MCTX_PARSE_LENIENT(parseFloat 宽松旗;调用前置 1 后清 0,随线程)
    "_print_buf": 96,         // MCTX_PRINT_BUF(打印格式化缓冲指针;已指针化,_start 填址)
    // [M3] C 组:当前/主协程指针 per-M —— 第二个 M 并发 resume 协程的**硬前提**
    // (_coroutine_resume/entry/yield/return 全经此二槽做栈切换;全局共享 = 两 M 互踩)。
    // GOMAXPROCS=1 下 x28=_m0_context,行为与旧全局槽逐字节等价。_scheduler_current
    // 兼任 GC 推迟判据(allocator.js);M>1 的 GC 安全属 M4/M5,本轮冒烟任务不分配以规避。
    "_scheduler_current": 24, // MCTX_SCHED_CURRENT
    "_scheduler_main": 32,    // MCTX_SCHED_MAIN
    // [M3] 当前 M 挂接的 P 指针(per-P runq/窃取从此取本 M 的 P)。并行调度器专用。
    "_m_current_p": 112,      // MCTX_P
};

// ARM64 物理寄存器（从 bootstrap 借用概念）
export const Reg = {
    X0: 0,
    X1: 1,
    X2: 2,
    X3: 3,
    X4: 4,
    X5: 5,
    X6: 6,
    X7: 7,
    X8: 8,
    X9: 9,
    X10: 10,
    X11: 11,
    X12: 12,
    X13: 13,
    X14: 14,
    X15: 15,
    X16: 16,
    X17: 17,
    X18: 18,
    X19: 19,
    X20: 20,
    X21: 21,
    X22: 22,
    X23: 23,
    X24: 24,
    X25: 25,
    X26: 26,
    X27: 27,
    X28: 28,
    FP: 29,
    LR: 30,
    SP: 31,
    XZR: 31,
};

export class ARM64Backend extends Backend {
    constructor(asm, platform) {
        super(asm);
        this.platform = platform || "linux"; // "linux" | "macos"

        // 虚拟寄存器 -> ARM64 物理寄存器映射
        this.regMap = {
            // 通用/临时寄存器 (避开 X0 参数/返回值寄存器)
            [VReg.V0]: Reg.X8,
            [VReg.V1]: Reg.X9,
            [VReg.V2]: Reg.X10,
            [VReg.V3]: Reg.X11,
            [VReg.V4]: Reg.X12,
            [VReg.V5]: Reg.X13,
            [VReg.V6]: Reg.X14,
            [VReg.V7]: Reg.X15,

            // Callee-saved 寄存器
            [VReg.S0]: Reg.X19,
            [VReg.S1]: Reg.X20,
            [VReg.S2]: Reg.X21,
            [VReg.S3]: Reg.X22,
            [VReg.S4]: Reg.X23,
            [VReg.S5]: Reg.X24,

            // 参数寄存器
            [VReg.A0]: Reg.X0,
            [VReg.A1]: Reg.X1,
            [VReg.A2]: Reg.X2,
            [VReg.A3]: Reg.X3,
            [VReg.A4]: Reg.X4,
            [VReg.A5]: Reg.X5,

            // 特殊寄存器
            [VReg.RET]: Reg.X0,
            [VReg.FP]: Reg.FP,
            [VReg.SP]: Reg.SP,
            [VReg.LR]: Reg.LR,
        };
    }

    get name() {
        return "arm64";
    }

    mapReg(vreg) {
        // If vreg is a number (physical register constant like Reg.X0), return it directly
        if (typeof vreg === 'number') {
            return vreg;
        }
        const phys = this.regMap[vreg];
        if (phys === undefined) {
            const stack = new Error().stack.split('\n').slice(1, 15).join('\n');
            console.log('mapReg failed for vreg:', JSON.stringify(vreg), 'type:', typeof vreg);
            console.log('Stack:', stack);
            throw new Error("Unknown virtual register: " + vreg);
        }
        return phys;
    }

    scratchReg(...regs) {
        const avoid = regs.map((reg) => typeof reg === "number" ? reg : this.mapReg(reg));
        for (const candidate of [Reg.X16, Reg.X17, Reg.X15, Reg.X14]) {
            if (!avoid.includes(candidate)) {
                return candidate;
            }
        }
        return Reg.X13;
    }

    // ========== 数据移动 ==========

    mov(dest, src) {
        // 同物理寄存器自消除:RET==A0==V0==X0 等别名令 mov(A0,RET) 类调用密度极高,
        // 自编译产物中 self-mov 达 12.8 万条(占总指令 4%),全为废指令。
        const d = this.mapReg(dest);
        const s = this.mapReg(src);
        if (d === s) return;
        this.asm.movReg(d, s);
    }

    movImm(dest, imm) {
        this.asm.movImm(this.mapReg(dest), imm);
    }

    movImm64(dest, imm) {
        // 64位立即数，直接使用 asm.movImm64
        this.asm.movImm64(this.mapReg(dest), imm);
    }

    load(dest, base, offset) {
        const rd = this.mapReg(dest);
        const rb = this.mapReg(base);
        if (offset >= -256 && offset <= 255) {
            // LDUR/LDR 可以直接使用的范围
            if (offset < 0) {
                this.asm.ldur(rd, rb, offset);
            } else {
                this.asm.ldr(rd, rb, offset);
            }
        } else if (offset >= 0 && (offset & 7) === 0 && offset < 32768) {
            // 正偏移且 8 字节对齐，可以使用 LDR 的 scaled offset
            this.asm.ldr(rd, rb, offset);
        } else {
            if (offset >= -4095 && offset <= 4095) {
                if (offset >= 0) {
                    this.asm.addImm(Reg.X16, rb, offset);
                } else {
                    this.asm.subImm(Reg.X16, rb, -offset);
                }
            } else {
                // 超大偏移：先 MOV offset 到 X16，再 ADD
                this.asm.movImm(Reg.X16, offset);
                this.asm.addReg(Reg.X16, rb, Reg.X16);
            }
            this.asm.ldr(rd, Reg.X16, 0);
        }
    }

    store(base, offset, src) {
        const rs = this.mapReg(src);
        const rb = this.mapReg(base);
        if (offset >= -256 && offset <= 255) {
            // STUR/STR 可以直接使用的范围
            if (offset < 0) {
                this.asm.stur(rs, rb, offset);
            } else {
                this.asm.str(rs, rb, offset);
            }
        } else if (offset >= 0 && (offset & 7) === 0 && offset < 32768) {
            // 正偏移且 8 字节对齐，可以使用 STR 的 scaled offset
            this.asm.str(rs, rb, offset);
        } else {
            // 超出范围：使用 X16 作为临时寄存器计算地址
            // ADD X16, base, #offset （可能需要多条指令）
            if (offset >= -4095 && offset <= 4095) {
                if (offset >= 0) {
                    this.asm.addImm(Reg.X16, rb, offset);
                } else {
                    this.asm.subImm(Reg.X16, rb, -offset);
                }
            } else {
                // 超大偏移：先 MOV offset 到 X16，再 ADD
                this.asm.movImm(Reg.X16, offset);
                this.asm.addReg(Reg.X16, rb, Reg.X16);
            }
            this.asm.str(rs, Reg.X16, 0);
        }
    }

    // 存储字节 (8位)
    storeByte(base, offset, src) {
        const rs = this.mapReg(src);
        const rb = this.mapReg(base);
        this.asm.strb(rs, rb, offset);
    }

    // 加载字节 (零扩展到64位)
    loadByte(dest, base, offset) {
        const rd = this.mapReg(dest);
        const rb = this.mapReg(base);
        this.asm.ldrb(rd, rb, offset);
    }

    lea(dest, label) {
        // [M2] per-M 执行态槽:寻址改为 x28(M 上下文)+ 偏移,而非 PC-relative 全局。
        const mctxOff = M_CTX_REDIRECT[label];
        if (mctxOff !== undefined) {
            this.asm.addImm(this.mapReg(dest), Reg.X28, mctxOff);
            return;
        }
        this.asm.leaRipRel(this.mapReg(dest), label);
    }

    // [M2 / G-M-P] 绑定 P/M 上下文寄存器。arm64 保留 x28(Go 同构:x28 存 g)作当前
    // M struct 指针;regMap 不映射 x25-x28、scratchReg 亦不取,故 x28 永不被分配器占用,
    // 一经 _start(及未来线程蹦床)`mov x28, src` 绑定即全程存活(callee-saved 无人改、
    // 裸 syscall 保留)。docs/PARALLEL_DESIGN.md §3.1。
    bindContextReg(srcVReg) {
        this.asm.movReg(Reg.X28, this.mapReg(srcVReg));
    }

    // ========== 算术运算 ==========

    add(dest, a, b) {
        this.asm.addReg(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    addImm(dest, src, imm) {
        this.asm.addImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    sub(dest, a, b) {
        this.asm.subReg(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    subImm(dest, src, imm) {
        this.asm.subImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    mul(dest, a, b) {
        this.asm.mul(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    div(dest, a, b) {
        this.asm.sdiv(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    mod(dest, a, b) {
        // ARM64 没有直接的取模指令: a % b = a - (a / b) * b
        const rd = this.mapReg(dest);
        const ra = this.mapReg(a);
        const rb = this.mapReg(b);
        const tmp = this.scratchReg(rd, ra, rb);
        this.asm.sdiv(tmp, ra, rb); // tmp = a / b
        this.asm.msub(rd, tmp, rb, ra); // rd = a - tmp * b
    }

    // ========== 位运算 ==========

    and(dest, a, b) {
        this.asm.andReg(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    or(dest, a, b) {
        this.asm.orrReg(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    xor(dest, a, b) {
        this.asm.eorReg(this.mapReg(dest), this.mapReg(a), this.mapReg(b));
    }

    shl(dest, src, count) {
        if (typeof count === "number") {
            this.asm.lslImm(this.mapReg(dest), this.mapReg(src), count);
        } else {
            this.asm.lslReg(this.mapReg(dest), this.mapReg(src), this.mapReg(count));
        }
    }

    shlImm(dest, src, imm) {
        this.asm.lslImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    shr(dest, src, count) {
        if (typeof count === "number") {
            this.asm.lsrImm(this.mapReg(dest), this.mapReg(src), count);
        } else {
            this.asm.lsrReg(this.mapReg(dest), this.mapReg(src), this.mapReg(count));
        }
    }

    shrImm(dest, src, imm) {
        this.asm.lsrImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    // 算术右移 (保留符号位)
    sar(dest, src, count) {
        if (typeof count === "number") {
            this.asm.asrImm(this.mapReg(dest), this.mapReg(src), count);
        } else {
            this.asm.asrReg(this.mapReg(dest), this.mapReg(src), this.mapReg(count));
        }
    }

    sarImm(dest, src, imm) {
        this.asm.asrImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    // 按位非: dest = ~src
    not(dest, src) {
        this.asm.mvn(this.mapReg(dest), this.mapReg(src));
    }

    // 取反: dest = 0 - src
    neg(dest, src) {
        this.asm.negReg(this.mapReg(dest), this.mapReg(src));
    }

    // 位测试
    test(a, b) {
        this.asm.tst(this.mapReg(a), this.mapReg(b));
    }

    testImm(a, imm) {
        this.asm.tstImm(this.mapReg(a), imm);
    }

    // 立即数版本的位运算
    andImm(dest, src, imm) {
        this.asm.andImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    orImm(dest, src, imm) {
        this.asm.orrImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    xorImm(dest, src, imm) {
        this.asm.eorImm(this.mapReg(dest), this.mapReg(src), imm);
    }

    // ========== 比较与跳转 ==========

    cmp(a, b) {
        this.asm.cmpReg(this.mapReg(a), this.mapReg(b));
    }

    cmpImm(a, imm) {
        if (imm >= 0 && imm <= 4095) {
            this.asm.cmpImm(this.mapReg(a), imm);
        } else {
            const ra = this.mapReg(a);
            const tmp = this.scratchReg(ra);
            this.asm.movImm(tmp, imm);
            this.asm.cmpReg(ra, tmp);
        }
    }

    jmp(label) {
        this.asm.b(label);
    }

    jeq(label) {
        this.asm.beq(label);
    }

    jne(label) {
        this.asm.bne(label);
    }

    jlt(label) {
        this.asm.blt(label);
    }

    jle(label) {
        this.asm.ble(label);
    }

    jgt(label) {
        this.asm.bgt(label);
    }

    jge(label) {
        this.asm.bge(label);
    }

    // 浮点比较跳转 [#26]:fcmp unordered(NaN)置 NZCV=0011,LT(N!=V)/LE 会被
    // 误取 → NaN<x 得 true。改无符号形:LO(C==0,仅有序小于)/LS(C==0||Z==1)。
    // GT(Z==0&&N==V)/GE(N==V)对 unordered 天然不取,维持不变。
    jflt(label) {
        this.asm.blo(label);
    }

    jfle(label) {
        this.asm.bls(label);
    }

    jfgt(label) {
        this.asm.bgt(label);
    }

    jfge(label) {
        this.asm.bge(label);
    }

    // fcmp unordered(任一 NaN)→ NZCV=0011,V=1 → BVS(cond 6)
    jnan(label) {
        this.asm.bvs(label);
    }

    // 无符号比较跳转
    jb(label) {
        // Below (无符号小于): C=0
        this.asm.blo(label);
    }

    jbe(label) {
        // Below or Equal (无符号小于等于): C=0 or Z=1
        this.asm.bls(label);
    }

    ja(label) {
        // Above (无符号大于): C=1 and Z=0
        this.asm.bhi(label);
    }

    jae(label) {
        // Above or Equal (无符号大于等于): C=1
        this.asm.bhs(label);
    }

    // ========== 函数调用 ==========

    prologue(stackSize, savedRegs) {
        // 保存 FP 和 LR
        this.asm.stpPre(Reg.FP, Reg.LR, Reg.SP, -16);
        this.asm.movReg(Reg.FP, Reg.SP);

        // 保存 callee-saved 寄存器
        // 计算实际要保存的寄存器对数（向上取整确保偶数）
        const numPairs = Math.ceil(savedRegs.length / 2);
        for (let i = 0; i < numPairs * 2; i += 2) {
            const r1 = this.mapReg(savedRegs[i]);
            const r2 = i + 1 < savedRegs.length ? this.mapReg(savedRegs[i + 1]) : Reg.XZR;
            this.asm.stpPre(r1, r2, Reg.SP, -16);
        }

        // 分配栈空间
        if (stackSize > 0) {
            this.asm.subImm(Reg.SP, Reg.SP, stackSize);
        }
    }

    epilogue(savedRegs, stackSize) {
        // 恢复栈空间
        if (stackSize > 0) {
            this.asm.addImm(Reg.SP, Reg.SP, stackSize);
        }

        // 恢复 callee-saved 寄存器（反序）
        // 计算实际要恢复的寄存器对数（向上取整确保偶数，与 prologue 一致）
        const numPairs = Math.ceil(savedRegs.length / 2);
        for (let p = numPairs - 1; p >= 0; p--) {
            const i = p * 2;
            const r1 = this.mapReg(savedRegs[i]);
            const r2 = i + 1 < savedRegs.length ? this.mapReg(savedRegs[i + 1]) : Reg.XZR;
            this.asm.ldpPost(r1, r2, Reg.SP, 16);
        }

        // 恢复 FP 和 LR
        this.asm.ldpPost(Reg.FP, Reg.LR, Reg.SP, 16);
        this.asm.ret();
    }

    call(label) {
        this.asm.bl(label);
    }

    callIndirect(reg) {
        // BLR Xn - 间接调用
        this.asm.blr(this.mapReg(reg));
    }

    // [引擎库] cache 维护(写码后刷 I-cache,防陈旧执行 SIGILL)
    dcCvau(reg) { this.asm.dcCvau(this.mapReg(reg)); }
    icIvau(reg) { this.asm.icIvau(this.mapReg(reg)); }
    dsbIsh() { this.asm.dsbIsh(); }
    isb() { this.asm.isb(); }

    // [M3] 原子 RMW 原语(LL/SC)—— 仅 linux-arm64 并行调度器发射。
    ldaxr(dst, addr) { this.asm.ldaxr(this.mapReg(dst), this.mapReg(addr)); }
    stlxr(status, val, addr) { this.asm.stlxr(this.mapReg(status), this.mapReg(val), this.mapReg(addr)); }
    clrex() { this.asm.clrex(); }
    stlr(val, addr) { this.asm.stlr(this.mapReg(val), this.mapReg(addr)); }

    jmpIndirect(reg) {
        // BR Xn - 间接跳转 (不保存返回地址)
        this.asm.br(this.mapReg(reg));
    }

    ret() {
        this.asm.ret();
    }

    prepareCall(args) {
        // 将参数放入寄存器
        for (let i = 0; i < args.length && i < 8; i++) {
            const arg = args[i];
            if (typeof arg === "number") {
                this.asm.movImm(i, arg); // X0-X7
            } else {
                this.asm.movReg(i, this.mapReg(arg));
            }
        }
    }

    // ========== 栈操作 ==========

    push(reg) {
        // 相邻 push/pop 配对窥孔(见 pop 注释)
        const start = this.asm.code.length;
        this.asm.stpPre(this.mapReg(reg), Reg.XZR, Reg.SP, -16);
        this._pairPush = { vreg: reg, start: start, end: this.asm.code.length };
    }

    pop(reg) {
        const p = this._pairPush;
        this._pairPush = null;
        if (p && p.end === this.asm.code.length) {
            // 紧邻配对:撤销 push 字节(pop 循环;length 赋值截断是 gen1-hostile),
            // 退化为 mov——同物理寄存器由 mov 自消除。中间任何发射使 end≠length 自动
            // 失效;label 定义在 base.label 显式失效(标签是潜在跳转目标)。
            while (this.asm.code.length > p.start) this.asm.code.pop();
            this.mov(reg, p.vreg);
            return;
        }
        this.asm.ldpPost(this.mapReg(reg), Reg.XZR, Reg.SP, 16);
    }

    // ========== 系统调用 ==========

    syscall(num) {
        if (this.platform === "linux") {
            this.asm.movImm(Reg.X8, num);
            this.asm.svc(0);
        } else {
            // macOS
            this.asm.movImm(Reg.X16, num);
            this.asm.svc(128);
        }
    }

    // 动态系统调用号：从寄存器读取调用号
    syscallReg(reg) {
        const rs = this.mapReg(reg);
        if (this.platform === "linux") {
            this.asm.movReg(Reg.X8, rs);
            this.asm.svc(0);
        } else {
            this.asm.movReg(Reg.X16, rs);
            this.asm.svc(128);
            // macOS:把进位标志表示的错误翻译成负 errno(见 asm 注释)。仅动态号路径
            // (__syscall 内建 → fs 等),不动静态号 syscall(write/exit/mmap 等原语)。
            this.asm.syscallNegErrno();
        }
    }

    // ========== 类型转换 ==========

    // Float to Int: 从 Number 对象中提取整数值
    // src 是指向 Number 对象的指针，dest 接收整数值
    f2i(dest, src) {
        const rd = this.mapReg(dest);
        const rs = this.mapReg(src);
        const tmp = this.scratchReg(rd, rs);
        // Number 对象: offset 0 = type, offset 8 = float64 bits
        // 加载 float64 位模式
        this.asm.ldr(tmp, rs, 8); // tmp = float64 bits
        // 将位模式移到 D0
        this.asm.fmovToFloat(0, tmp); // D0 = float from bits
        // 转换为整数
        this.asm.fcvtzs(rd, 0); // rd = int(D0)
    }

    // ========== 浮点运算 (VM 抽象接口实现) ==========

    // 将整数寄存器的位模式移动到浮点寄存器
    fmovToFloat(fpReg, gpReg) {
        this.asm.fmovToFloat(fpReg, this.mapReg(gpReg));
    }

    // 将浮点寄存器的位模式移动到整数寄存器
    fmovToInt(gpReg, fpReg) {
        this.asm.fmovToInt(this.mapReg(gpReg), fpReg);
    }

    // 浮点加法
    fadd(fpDest, fpA, fpB) {
        this.asm.fadd(fpDest, fpA, fpB);
    }

    // 浮点减法
    fsub(fpDest, fpA, fpB) {
        this.asm.fsub(fpDest, fpA, fpB);
    }

    // 浮点乘法
    fmul(fpDest, fpA, fpB) {
        this.asm.fmul(fpDest, fpA, fpB);
    }

    // 浮点除法
    fdiv(fpDest, fpA, fpB) {
        this.asm.fdiv(fpDest, fpA, fpB);
    }

    // 浮点转整数 (截断)
    fcvtzs(gpDest, fpSrc) {
        this.asm.fcvtzs(this.mapReg(gpDest), fpSrc);
    }

    // 浮点取模: fpDest = fpA % fpB
    fmod(fpDest, fpA, fpB) {
        // 浮点取模: a % b = a - trunc(a / b) * b
        // 使用 D7 作为临时寄存器
        this.asm.fdiv(7, fpA, fpB); // D7 = a / b
        this.asm.frintz(7, 7); // D7 = trunc(D7)
        this.asm.fmul(7, 7, fpB); // D7 = D7 * b
        this.asm.fsub(fpDest, fpA, 7); // fpDest = a - D7
    }

    // 浮点与零比较
    fcmpZero(fpReg) {
        this.asm.fcmpZero(fpReg);
    }

    // 浮点绝对值
    fabs(fpDest, fpSrc) {
        this.asm.fabs(fpDest, fpSrc);
    }

    // 浮点取反 (negate)
    fneg(fpDest, fpSrc) {
        this.asm.fneg(fpDest, fpSrc);
    }

    // 浮点截断
    ftrunc(fpDest, fpSrc) {
        this.asm.frintz(fpDest, fpSrc);
    }

    // 浮点向下取整 (floor)
    ffloor(fpDest, fpSrc) {
        this.asm.frintm(fpDest, fpSrc);
    }

    // 浮点平方根
    fsqrt(fpDest, fpSrc) {
        this.asm.fsqrt(fpDest, fpSrc);
    }

    // 浮点向上取整 (ceil)
    fceil(fpDest, fpSrc) {
        this.asm.frintp(fpDest, fpSrc);
    }

    // 浮点四舍五入
    fround(fpDest, fpSrc) {
        this.asm.frinta(fpDest, fpSrc);
    }

    // 整数转浮点: fpDest = (double)gpSrc
    scvtf(fpDest, gpSrc) {
        this.asm.scvtf(fpDest, this.mapReg(gpSrc));
    }

    // 双精度转单精度
    fcvtd2s(fpDest, fpSrc) {
        this.asm.fcvt(fpDest, fpSrc, "d", "s");
    }

    // 单精度转双精度
    fcvts2d(fpDest, fpSrc) {
        this.asm.fcvt(fpDest, fpSrc, "s", "d");
    }

    // 将单精度浮点寄存器的位模式移到整数寄存器 (32位)
    fmovToIntSingle(gpDest, fpSrc) {
        this.asm.fmovToIntSingle(this.mapReg(gpDest), fpSrc);
    }

    // 将单精度整数位模式移到浮点寄存器
    fmovToFloatSingle(fpDest, gpSrc) {
        this.asm.fmovToFloatSingle(fpDest, this.mapReg(gpSrc));
    }

    // 浮点比较
    fcmp(fpA, fpB) {
        this.asm.fcmp(fpA, fpB);
    }

    // 浮点寄存器间移动
    fmov(fpDest, fpSrc) {
        this.asm.fmovReg(fpDest, fpSrc);
    }
}

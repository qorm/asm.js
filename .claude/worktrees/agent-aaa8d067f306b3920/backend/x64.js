// asm.js x64 后端
// 将虚拟指令翻译为 x86_64 机器码

import { Backend } from "./base.js";
import { VReg } from "../vm/registers.js";

// x64 物理寄存器
export const Reg = {
    RAX: 0,
    RCX: 1,
    RDX: 2,
    RBX: 3,
    RSP: 4,
    RBP: 5,
    RSI: 6,
    RDI: 7,
    R8: 8,
    R9: 9,
    R10: 10,
    R11: 11,
    R12: 12,
    R13: 13,
    R14: 14,
    R15: 15,
};

export class X64Backend extends Backend {
    constructor(asm, platform) {
        super(asm);
        this.platform = platform || "linux"; // "linux" | "macos" | "windows"

        // System V ABI (Linux/macOS) vs Windows ABI
        const isWindows = platform === "windows";

        // x64 只有 5 个 callee-saved 寄存器，S5 需要使用栈槽位
        this.s5StackOffset = -8; // S5 在栈上的偏移量（相对于 RBP）

        // 虚拟寄存器 -> x64 物理寄存器映射
        this.regMap = {
            // 通用/临时寄存器
            [VReg.V0]: Reg.RAX,
            [VReg.V1]: Reg.RCX,
            [VReg.V2]: Reg.RDX,
            [VReg.V3]: Reg.R8,
            [VReg.V4]: Reg.R9,
            [VReg.V5]: Reg.R10,
            [VReg.V6]: Reg.R11,
            [VReg.V7]: Reg.RSI,

            // Callee-saved 寄存器
            [VReg.S0]: Reg.RBX,
            [VReg.S1]: Reg.R12,
            [VReg.S2]: Reg.R13,
            [VReg.S3]: Reg.R14,
            [VReg.S4]: Reg.R15,
            // S5 使用栈槽位，不在 regMap 中

            // 参数寄存器 - Windows 与 SysV 采用**完全相同**的内部约定。
            // 原先 Windows 用 C ABI 的 RCX/RDX/R8/R9 作 A0-A3,导致 V1-V4(RCX/RDX/R8/R9)
            // 与 A0-A3 别名:所有共享运行时里形如 shrImm(V1, A0, 48) 的首指令会把 A0 自己
            // 算没(SysV 下 A0=RDI 不被任何 V 别名,故安全)——字符串索引/比较/大小写等
            // 系统性错乱。改为内部一律 SysV(A0=RDI…A5=R9),让全部共享运行时寄存器关系
            // 与已验证的 macos/linux-x64 逐指令一致;Win32 ABI 的 RCX/RDX/R8/R9 搬运只在
            // 真正调 API 的三处胶水(callWindowsAPI/WriteConsole/ExitProcess + winfs)内做。
            // 非 Windows 映射不变,四平台产物字节零影响。
            [VReg.A0]: Reg.RDI,
            [VReg.A1]: Reg.RSI,
            [VReg.A2]: Reg.RDX,
            [VReg.A3]: Reg.RCX,
            [VReg.A4]: Reg.R8,
            [VReg.A5]: Reg.R9,

            // 特殊寄存器
            [VReg.RET]: Reg.RAX,
            [VReg.FP]: Reg.RBP,
            [VReg.SP]: Reg.RSP,
            [VReg.LR]: Reg.RAX, // x64 没有 LR，用 RAX 占位
        };

        // 参数传递顺序
        this.callRegs = isWindows ? [Reg.RCX, Reg.RDX, Reg.R8, Reg.R9] : [Reg.RDI, Reg.RSI, Reg.RDX, Reg.RCX, Reg.R8, Reg.R9];
    }

    get name() {
        return "x64";
    }

    mapReg(vreg) {
        // S5 使用栈槽位，不能直接映射
        if (vreg === VReg.S5) {
            throw new Error("S5 uses stack slot on x64, cannot map directly. Use mov/load/store with S5 handling.");
        }
        const phys = this.regMap[vreg];
        if (phys === undefined) {
            throw new Error("Unknown virtual register: " + vreg);
        }
        return phys;
    }

    // 检查是否是 S5
    isS5(vreg) {
        return vreg === VReg.S5;
    }

    // ========== 数据移动 ==========

    mov(dest, src) {
        // 处理 S5 (栈槽位)
        if (this.isS5(dest) && this.isS5(src)) {
            // S5 到 S5：无操作
            return;
        }
        if (this.isS5(dest)) {
            // mov S5, src -> store to stack
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, this.mapReg(src));
            return;
        }
        if (this.isS5(src)) {
            // mov dest, S5 -> load from stack
            this.asm.movLoadOffset(this.mapReg(dest), Reg.RBP, this.s5StackOffset);
            return;
        }
        // 同物理寄存器自消除(RET==V0==RAX、A1==V7==RSI 等别名下 self-mov 密度高,纯废指令)
        const d = this.mapReg(dest);
        const s = this.mapReg(src);
        if (d === s) return;
        this.asm.movReg(d, s);
    }

    movImm(dest, imm) {
        if (this.isS5(dest)) {
            // movImm S5, imm -> 需要临时寄存器
            if (imm === 0) {
                this.asm.xorReg(Reg.RAX, Reg.RAX);
            } else {
                this.asm.movImm(Reg.RAX, imm);
            }
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RAX);
            return;
        }
        if (imm === 0) {
            this.asm.xorReg(this.mapReg(dest), this.mapReg(dest));
        } else {
            this.asm.movImm(this.mapReg(dest), imm);
        }
    }

    movImm64(dest, imm) {
        // 64位立即数，对于 x64 直接使用 asm.movImm64
        if (this.isS5(dest)) {
            this.asm.movImm64(Reg.RAX, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RAX);
            return;
        }
        this.asm.movImm64(this.mapReg(dest), imm);
    }

    load(dest, base, offset) {
        // 处理 S5 作为 dest 或 base
        if (this.isS5(base)) {
            // load dest, [S5 + offset] -> 先加载 S5 到临时寄存器
            this.asm.movLoadOffset(Reg.RAX, Reg.RBP, this.s5StackOffset);
            if (this.isS5(dest)) {
                // load S5, [S5 + offset]
                this.asm.movLoadOffset(Reg.RAX, Reg.RAX, offset);
                this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RAX);
            } else {
                this.asm.movLoadOffset(this.mapReg(dest), Reg.RAX, offset);
            }
            return;
        }
        if (this.isS5(dest)) {
            // load S5, [base + offset]
            this.asm.movLoadOffset(Reg.RAX, this.mapReg(base), offset);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RAX);
            return;
        }
        this.asm.movLoadOffset(this.mapReg(dest), this.mapReg(base), offset);
    }

    store(base, offset, src) {
        // 处理 S5 作为 base 或 src
        if (this.isS5(base)) {
            // store [S5 + offset], src
            this.asm.movLoadOffset(Reg.RAX, Reg.RBP, this.s5StackOffset);
            if (this.isS5(src)) {
                // store [S5 + offset], S5 -> 需要两个临时寄存器
                this.asm.push(Reg.RCX);
                this.asm.movLoadOffset(Reg.RCX, Reg.RBP, this.s5StackOffset);
                this.asm.movStoreOffset(Reg.RAX, offset, Reg.RCX);
                this.asm.pop(Reg.RCX);
            } else {
                this.asm.movStoreOffset(Reg.RAX, offset, this.mapReg(src));
            }
            return;
        }
        if (this.isS5(src)) {
            // store [base + offset], S5
            this.asm.movLoadOffset(Reg.RAX, Reg.RBP, this.s5StackOffset);
            this.asm.movStoreOffset(this.mapReg(base), offset, Reg.RAX);
            return;
        }
        this.asm.movStoreOffset(this.mapReg(base), offset, this.mapReg(src));
    }

    // 存储字节 (8位)
    storeByte(base, offset, src) {
        const rb = this._getReg(base, Reg.R10);
        const rs = this._getReg(src, Reg.R11);
        this.asm.movStoreOffset8(rb, offset, rs);
    }

    // 加载字节 (零扩展到64位)
    loadByte(dest, base, offset) {
        const tempReg = Reg.R10;
        const rb = this._getReg(base, tempReg);

        if (this.isS5(dest)) {
            // 需要另一个临时寄存器来存结果
            const tempResult = Reg.R11;
            this.asm.movLoadOffset8(tempResult, rb, offset);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempResult);
        } else {
            this.asm.movLoadOffset8(this.mapReg(dest), rb, offset);
        }
    }

    lea(dest, label) {
        if (this.isS5(dest)) {
            this.asm.leaRipRel(Reg.RAX, label);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RAX);
            return;
        }
        this.asm.leaRipRel(this.mapReg(dest), label);
    }

    // 辅助：获取寄存器值（处理 S5）
    _getReg(vreg, tempReg = Reg.RAX) {
        if (this.isS5(vreg)) {
            this.asm.movLoadOffset(tempReg, Reg.RBP, this.s5StackOffset);
            return tempReg;
        }
        return this.mapReg(vreg);
    }

    // 辅助：设置寄存器值（处理 S5）
    _setReg(vreg, physReg) {
        if (this.isS5(vreg)) {
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, physReg);
            return;
        }
        if (this.mapReg(vreg) !== physReg) {
            this.asm.movReg(this.mapReg(vreg), physReg);
        }
    }

    // ========== 算术运算 ==========

    add(dest, a, b) {
        // 使用 R10 作为临时寄存器避免与参数冲突
        const tempA = Reg.R10;
        const tempB = Reg.R11;

        // 加载操作数
        const ra = this._getReg(a, tempA);
        const rb = this._getReg(b, tempB);

        // 执行运算
        if (this.isS5(dest)) {
            if (ra === tempA) {
                this.asm.addReg(tempA, rb);
            } else {
                this.asm.movReg(tempA, ra);
                this.asm.addReg(tempA, rb);
            }
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempA);
        } else {
            const rd = this.mapReg(dest);
            // 如果 dest == b，需要特别处理以避免覆盖 b 的值
            if (rd === rb && rd !== ra) {
                // dest == b, dest != a:加法可交换,直接 `add rd, ra`(= b + a = a + b),
                // 无需 R10 临时。原先的 3 指令临时法(mov R10,ra; add R10,rb; mov rd,R10)会
                // **破坏 R10=V5**——运行时把 V5/V6(R10/R11)当活值寄存器用时(如 _d4_shl 在
                // `add(V0,A0,V0)` 处 V5 仍存 j),会被清成垃圾 → 越界读 SIGBUS(x64 数字→串
                // Dragon4 全线崩、含 eval 启动期数字格式化)。交换式免临时,arm64 后端不涉此文件
                // 故自举门字节零扰动。
                this.asm.addReg(rd, ra);
            } else if (rd !== ra) {
                this.asm.movReg(rd, ra);
                this.asm.addReg(rd, rb);
            } else {
                this.asm.addReg(rd, rb);
            }
        }
    }

    addImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.addImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.addImm(rd, imm);
        }
    }

    sub(dest, a, b) {
        const tempA = Reg.R10;
        const tempB = Reg.R11;

        const ra = this._getReg(a, tempA);
        const rb = this._getReg(b, tempB);

        if (this.isS5(dest)) {
            if (ra === tempA) {
                this.asm.subReg(tempA, rb);
            } else {
                this.asm.movReg(tempA, ra);
                this.asm.subReg(tempA, rb);
            }
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempA);
        } else {
            const rd = this.mapReg(dest);
            // 如果 dest == b，需要特别处理以避免覆盖 b 的值
            if (rd === rb && rd !== ra) {
                // dest == b, dest != a: 需要先把 a 和 b 存到临时寄存器
                this.asm.movReg(tempA, ra);
                this.asm.subReg(tempA, rb);
                this.asm.movReg(rd, tempA);
            } else if (rd !== ra) {
                this.asm.movReg(rd, ra);
                this.asm.subReg(rd, rb);
            } else {
                this.asm.subReg(rd, rb);
            }
        }
    }

    subImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.subImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.subImm(rd, imm);
        }
    }

    mul(dest, a, b) {
        const tempA = Reg.R10;
        const tempB = Reg.R11;

        const ra = this._getReg(a, tempA);
        const rb = this._getReg(b, tempB);

        if (this.isS5(dest)) {
            if (ra === tempA) {
                this.asm.imulReg(tempA, rb);
            } else {
                this.asm.movReg(tempA, ra);
                this.asm.imulReg(tempA, rb);
            }
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempA);
        } else {
            const rd = this.mapReg(dest);
            // 如果 dest == b，需要特别处理以避免覆盖 b 的值
            if (rd === rb && rd !== ra) {
                // dest == b, dest != a:乘法可交换,直接 `imul rd, ra`(= b*a = a*b),免 R10
                // 临时(R10=V5 可能是运行时活值,原临时法会破坏之;同 add 交换式修复)。
                this.asm.imulReg(rd, ra);
            } else if (rd !== ra) {
                this.asm.movReg(rd, ra);
                this.asm.imulReg(rd, rb);
            } else {
                this.asm.imulReg(rd, rb);
            }
        }
    }

    div(dest, a, b) {
        // x64 除法: RAX / reg -> RAX (商), RDX (余数)
        // idiv 会破坏 RAX(商) 和 RDX(余数)。为遵守"div 只写 dest"的约定
        // （arm64 后端如此，通用 codegen 依赖之——如 _intToStr 中 mod 后的
        // digit 存于 V0(=RAX)，紧接的 div 若不保存会把它冲掉），
        // 对非目标的 RAX/RDX 做保存/恢复。
        const ra = this._getReg(a, Reg.R10);
        const rb = this._getReg(b, Reg.R11);

        const destIsRAX = !this.isS5(dest) && this.mapReg(dest) === Reg.RAX;
        const destIsRDX = !this.isS5(dest) && this.mapReg(dest) === Reg.RDX;

        if (!destIsRAX) this.asm.push(Reg.RAX);
        if (!destIsRDX) this.asm.push(Reg.RDX);

        // 除数撞 RAX/RDX:mov RAX,ra 会踩 rb==RAX,cqo 必踩 rb==RDX
        // (曾致 div(V3,V3,V0=RAX) 除数被换成被除数 → 15 位小数循环 x64 死循环)。
        // 原值先压栈,改用栈上内存除数;弹栈用 add rsp,8(不碰任何寄存器)。
        const rbClash = (rb === Reg.RAX || rb === Reg.RDX);
        if (rbClash) this.asm.push(rb);

        // 将被除数放入 RAX
        if (ra !== Reg.RAX) {
            this.asm.movReg(Reg.RAX, ra);
        }

        // 符号扩展 RAX -> RDX:RAX
        this.asm.cqo();

        if (rbClash) {
            this.asm.idivMemRsp(0);
            this.asm.addImm(Reg.RSP, 8);
        } else {
            // 如果 rb 是 R11（S5 加载用过），需要重新加载因为 cqo 可能破坏了
            let divisor = rb;
            if (this.isS5(b)) {
                this.asm.movLoadOffset(Reg.R11, Reg.RBP, this.s5StackOffset);
                divisor = Reg.R11;
            }
            this.asm.idivReg(divisor);
        }

        // 商在 RAX，移动到目标（在恢复 RAX 之前）
        if (this.isS5(dest)) {
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RAX);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== Reg.RAX) {
                this.asm.movReg(rd, Reg.RAX);
            }
        }
        // 逆序恢复
        if (!destIsRDX) this.asm.pop(Reg.RDX);
        if (!destIsRAX) this.asm.pop(Reg.RAX);
    }

    mod(dest, a, b) {
        // 类似 div，但取余数 (RDX)；同样保存非目标的 RAX/RDX
        const ra = this._getReg(a, Reg.R10);
        const rb = this._getReg(b, Reg.R11);

        const destIsRAX = !this.isS5(dest) && this.mapReg(dest) === Reg.RAX;
        const destIsRDX = !this.isS5(dest) && this.mapReg(dest) === Reg.RDX;

        if (!destIsRAX) this.asm.push(Reg.RAX);
        if (!destIsRDX) this.asm.push(Reg.RDX);

        // 除数撞 RAX/RDX 同 div 修复:原值压栈 + 栈上内存除数
        const rbClash = (rb === Reg.RAX || rb === Reg.RDX);
        if (rbClash) this.asm.push(rb);
        if (ra !== Reg.RAX) {
            this.asm.movReg(Reg.RAX, ra);
        }
        this.asm.cqo();

        if (rbClash) {
            this.asm.idivMemRsp(0);
            this.asm.addImm(Reg.RSP, 8);
        } else {
            // 如果 rb 是 R11（S5 加载用过），需要重新加载
            let divisor = rb;
            if (this.isS5(b)) {
                this.asm.movLoadOffset(Reg.R11, Reg.RBP, this.s5StackOffset);
                divisor = Reg.R11;
            }
            this.asm.idivReg(divisor);
        }

        // 余数在 RDX，移动到目标（在恢复 RDX 之前）
        if (this.isS5(dest)) {
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.RDX);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== Reg.RDX) {
                this.asm.movReg(rd, Reg.RDX);
            }
        }
        // 逆序恢复
        if (!destIsRDX) this.asm.pop(Reg.RDX);
        if (!destIsRAX) this.asm.pop(Reg.RAX);
    }

    // ========== 位运算 ==========

    and(dest, a, b) {
        const tempReg = Reg.R10;
        const tempReg2 = Reg.R11;
        const ra = this._getReg(a, tempReg);
        const rb = this._getReg(b, tempReg2);

        if (this.isS5(dest)) {
            if (ra !== tempReg) {
                this.asm.movReg(tempReg, ra);
            }
            this.asm.andReg(tempReg, rb);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            // 如果 dest == b，需要特别处理以避免覆盖 b 的值
            if (rd === rb && rd !== ra) {
                // dest == b:与运算可交换,`and rd, ra`(= b & a),免 R10 临时(R10=V5 可能是
                // 运行时活值;同 add/mul 交换式修复)。
                this.asm.andReg(rd, ra);
            } else if (rd !== ra) {
                this.asm.movReg(rd, ra);
                this.asm.andReg(rd, rb);
            } else {
                this.asm.andReg(rd, rb);
            }
        }
    }

    or(dest, a, b) {
        const tempReg = Reg.R10;
        const tempReg2 = Reg.R11;
        const ra = this._getReg(a, tempReg);
        const rb = this._getReg(b, tempReg2);

        if (this.isS5(dest)) {
            if (ra !== tempReg) {
                this.asm.movReg(tempReg, ra);
            }
            this.asm.orReg(tempReg, rb);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            // 如果 dest == b，需要特别处理以避免覆盖 b 的值
            if (rd === rb && rd !== ra) {
                // dest == b:或运算可交换,`or rd, ra`,免 R10 临时(同 add/mul/and 修复)。
                this.asm.orReg(rd, ra);
            } else if (rd !== ra) {
                this.asm.movReg(rd, ra);
                this.asm.orReg(rd, rb);
            } else {
                this.asm.orReg(rd, rb);
            }
        }
    }

    xor(dest, a, b) {
        const tempReg = Reg.R10;
        const tempReg2 = Reg.R11;
        const ra = this._getReg(a, tempReg);
        const rb = this._getReg(b, tempReg2);

        if (this.isS5(dest)) {
            if (ra !== tempReg) {
                this.asm.movReg(tempReg, ra);
            }
            this.asm.xorReg(tempReg, rb);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            // 如果 dest == b，需要特别处理以避免覆盖 b 的值
            if (rd === rb && rd !== ra) {
                // dest == b:异或可交换,`xor rd, ra`,免 R10 临时(同 add/mul/and/or 修复)。
                this.asm.xorReg(rd, ra);
            } else if (rd !== ra) {
                this.asm.movReg(rd, ra);
                this.asm.xorReg(rd, rb);
            } else {
                this.asm.xorReg(rd, rb);
            }
        }
    }

    shl(dest, src, count) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (typeof count === "number") {
            if (this.isS5(dest)) {
                if (rs !== tempReg) {
                    this.asm.movReg(tempReg, rs);
                }
                this.asm.shlImm(tempReg, count);
                this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
            } else {
                const rd = this.mapReg(dest);
                if (rd !== rs) {
                    this.asm.movReg(rd, rs);
                }
                this.asm.shlImm(rd, count);
            }
            return;
        }

        // 变长计数:x64 要求 count 在 CL(=RCX=V1=A3)。旧实现无保护地
        // `mov RCX, count` —— ①毁调用方 V1/A3;②dest==RCX 时 src 先被 count
        // 覆盖。mark_one 位图定位在 shl 后仍用 V1 → x64 GC 标错位(任务 #21
        // 的统一根因;v1.1.x 因 GC 默认 4GB 不触发而从未暴露)。
        // 栈编排实现:count 原值先上栈、pop 直入 CL,对 dest/src/count 与
        // RCX/R10/R11 的一切撞位组合免疫,除 (dest,src,count) 外不碰任何寄存器。
        const rcnt = this._getReg(count, Reg.R11);
        if (!this.isS5(dest) && this.mapReg(dest) === Reg.RCX) {
            // dest==RCX:src 原值上栈,count 进 CL(RCX=dest 可覆盖),栈顶内存
            // 移位后 pop 回 RCX —— 全程零外部寄存器触碰(曾借 R10 当工作寄存器
            // → 踩掉调用方 V5,dedup 位图写偏,#21 修复自身复发的教训)。
            this.asm.push(rs); // rs==RCX 时压的就是原值 ✓
            if (rcnt !== Reg.RCX) this.asm.movReg(Reg.RCX, rcnt); // rcnt==RCX 时原值即 count
            this.asm.shlClMemRsp(); // [rsp] <<= CL
            this.asm.pop(Reg.RCX); // 结果 → dest(RCX)
            return;
        }
        const rd = this.isS5(dest) ? tempReg : this.mapReg(dest);
        this.asm.push(Reg.RCX); // 保调用方 RCX
        this.asm.push(rcnt); // count 原值(此刻寄存器均未被破坏)
        if (rd !== rs) {
            if (rs === Reg.RCX) {
                this.asm.movLoadOffset(rd, Reg.RSP, 8); // src 原值 = 栈上保存的 RCX
            } else {
                this.asm.movReg(rd, rs);
            }
        }
        this.asm.pop(Reg.RCX); // count → CL
        this.asm.shlCl(rd);
        this.asm.pop(Reg.RCX); // 恢复调用方 RCX
        if (this.isS5(dest)) {
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, rd);
        }
    }

    shlImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.shlImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.shlImm(rd, imm);
        }
    }

    shr(dest, src, count) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (typeof count === "number") {
            if (this.isS5(dest)) {
                if (rs !== tempReg) {
                    this.asm.movReg(tempReg, rs);
                }
                this.asm.shrImm(tempReg, count);
                this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
            } else {
                const rd = this.mapReg(dest);
                if (rd !== rs) {
                    this.asm.movReg(rd, rs);
                }
                this.asm.shrImm(rd, count);
            }
            return;
        }

        // 变长计数:x64 要求 count 在 CL(=RCX=V1=A3)。旧实现无保护地
        // `mov RCX, count` —— ①毁调用方 V1/A3;②dest==RCX 时 src 先被 count
        // 覆盖。mark_one 位图定位在 shl 后仍用 V1 → x64 GC 标错位(任务 #21
        // 的统一根因;v1.1.x 因 GC 默认 4GB 不触发而从未暴露)。
        // 栈编排实现:count 原值先上栈、pop 直入 CL,对 dest/src/count 与
        // RCX/R10/R11 的一切撞位组合免疫,除 (dest,src,count) 外不碰任何寄存器。
        const rcnt = this._getReg(count, Reg.R11);
        if (!this.isS5(dest) && this.mapReg(dest) === Reg.RCX) {
            // dest==RCX:src 原值上栈,count 进 CL(RCX=dest 可覆盖),栈顶内存
            // 移位后 pop 回 RCX —— 全程零外部寄存器触碰(曾借 R10 当工作寄存器
            // → 踩掉调用方 V5,dedup 位图写偏,#21 修复自身复发的教训)。
            this.asm.push(rs); // rs==RCX 时压的就是原值 ✓
            if (rcnt !== Reg.RCX) this.asm.movReg(Reg.RCX, rcnt); // rcnt==RCX 时原值即 count
            this.asm.shrClMemRsp(); // [rsp] <<= CL
            this.asm.pop(Reg.RCX); // 结果 → dest(RCX)
            return;
        }
        const rd = this.isS5(dest) ? tempReg : this.mapReg(dest);
        this.asm.push(Reg.RCX); // 保调用方 RCX
        this.asm.push(rcnt); // count 原值(此刻寄存器均未被破坏)
        if (rd !== rs) {
            if (rs === Reg.RCX) {
                this.asm.movLoadOffset(rd, Reg.RSP, 8); // src 原值 = 栈上保存的 RCX
            } else {
                this.asm.movReg(rd, rs);
            }
        }
        this.asm.pop(Reg.RCX); // count → CL
        this.asm.shrCl(rd);
        this.asm.pop(Reg.RCX); // 恢复调用方 RCX
        if (this.isS5(dest)) {
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, rd);
        }
    }

    shrImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.shrImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.shrImm(rd, imm);
        }
    }

    // 算术右移 (保留符号位)
    sar(dest, src, count) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (typeof count === "number") {
            if (this.isS5(dest)) {
                if (rs !== tempReg) {
                    this.asm.movReg(tempReg, rs);
                }
                this.asm.sarImm(tempReg, count);
                this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
            } else {
                const rd = this.mapReg(dest);
                if (rd !== rs) {
                    this.asm.movReg(rd, rs);
                }
                this.asm.sarImm(rd, count);
            }
            return;
        }

        // 变长计数:x64 要求 count 在 CL(=RCX=V1=A3)。旧实现无保护地
        // `mov RCX, count` —— ①毁调用方 V1/A3;②dest==RCX 时 src 先被 count
        // 覆盖。mark_one 位图定位在 shl 后仍用 V1 → x64 GC 标错位(任务 #21
        // 的统一根因;v1.1.x 因 GC 默认 4GB 不触发而从未暴露)。
        // 栈编排实现:count 原值先上栈、pop 直入 CL,对 dest/src/count 与
        // RCX/R10/R11 的一切撞位组合免疫,除 (dest,src,count) 外不碰任何寄存器。
        const rcnt = this._getReg(count, Reg.R11);
        if (!this.isS5(dest) && this.mapReg(dest) === Reg.RCX) {
            // dest==RCX:src 原值上栈,count 进 CL(RCX=dest 可覆盖),栈顶内存
            // 移位后 pop 回 RCX —— 全程零外部寄存器触碰(曾借 R10 当工作寄存器
            // → 踩掉调用方 V5,dedup 位图写偏,#21 修复自身复发的教训)。
            this.asm.push(rs); // rs==RCX 时压的就是原值 ✓
            if (rcnt !== Reg.RCX) this.asm.movReg(Reg.RCX, rcnt); // rcnt==RCX 时原值即 count
            this.asm.sarClMemRsp(); // [rsp] <<= CL
            this.asm.pop(Reg.RCX); // 结果 → dest(RCX)
            return;
        }
        const rd = this.isS5(dest) ? tempReg : this.mapReg(dest);
        this.asm.push(Reg.RCX); // 保调用方 RCX
        this.asm.push(rcnt); // count 原值(此刻寄存器均未被破坏)
        if (rd !== rs) {
            if (rs === Reg.RCX) {
                this.asm.movLoadOffset(rd, Reg.RSP, 8); // src 原值 = 栈上保存的 RCX
            } else {
                this.asm.movReg(rd, rs);
            }
        }
        this.asm.pop(Reg.RCX); // count → CL
        this.asm.sarCl(rd);
        this.asm.pop(Reg.RCX); // 恢复调用方 RCX
        if (this.isS5(dest)) {
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, rd);
        }
    }

    sarImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.sarImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.sarImm(rd, imm);
        }
    }

    // 按位非: dest = ~src
    not(dest, src) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.not(tempReg);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.not(rd);
        }
    }

    // 取反: dest = 0 - src
    neg(dest, src) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.neg(tempReg);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.neg(rd);
        }
    }

    // 位测试
    test(a, b) {
        const ra = this._getReg(a, Reg.R10);
        const rb = this._getReg(b, Reg.R11);
        this.asm.testReg(ra, rb);
    }

    testImm(a, imm) {
        const ra = this._getReg(a, Reg.R10);
        this.asm.testImm(ra, imm);
    }

    // 立即数版本的位运算
    andImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.andImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.andImm(rd, imm);
        }
    }

    orImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.orImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.orImm(rd, imm);
        }
    }

    xorImm(dest, src, imm) {
        const tempReg = Reg.R10;
        const rs = this._getReg(src, tempReg);

        if (this.isS5(dest)) {
            if (rs !== tempReg) {
                this.asm.movReg(tempReg, rs);
            }
            this.asm.xorImm(tempReg, imm);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, tempReg);
        } else {
            const rd = this.mapReg(dest);
            if (rd !== rs) {
                this.asm.movReg(rd, rs);
            }
            this.asm.xorImm(rd, imm);
        }
    }

    // ========== 比较与跳转 ==========

    cmp(a, b) {
        const ra = this._getReg(a, Reg.R10);
        const rb = this._getReg(b, Reg.R11);
        this.asm.cmpReg(ra, rb);
    }

    cmpImm(a, imm) {
        const ra = this._getReg(a, Reg.R10);
        this.asm.cmpImm(ra, imm);
    }

    jmp(label) {
        this.asm.jmp(label);
    }

    jeq(label) {
        this.asm.je(label);
    }

    jne(label) {
        this.asm.jne(label);
    }

    jlt(label) {
        this.asm.jl(label);
    }

    jle(label) {
        this.asm.jle(label);
    }

    jgt(label) {
        this.asm.jg(label);
    }

    jge(label) {
        this.asm.jge(label);
    }

    // 浮点比较跳转：ucomisd 后须用无符号条件码（CF/ZF）
    // left<right: CF=1 -> jb; left>right: CF=0&ZF=0 -> ja;
    // <=: CF=1|ZF=1 -> jbe; >=: CF=0 -> jae
    // [#26] unordered(NaN)置 ZF=PF=CF=1,jb/jbe 会被误取 → 先发 jp rel8(+6,
    // 恰跨过 6 字节的 0F 8x rel32)把 NaN 旁路;ja/jae 要 CF=0 天然不取,不变。
    jflt(label) {
        this.asm.emit(0x7a); // jp rel8 +6
        this.asm.emit(0x06);
        this.asm.jb(label);
    }

    jfle(label) {
        this.asm.emit(0x7a); // jp rel8 +6
        this.asm.emit(0x06);
        this.asm.jbe(label);
    }

    jfgt(label) {
        this.asm.ja(label);
    }

    jfge(label) {
        this.asm.jae(label);
    }

    // ucomisd 后 unordered(任一 NaN)置 PF=1 → JP(rel32)
    jnan(label) {
        this.asm.jp(label);
    }

    // 无符号比较跳转
    jb(label) {
        this.asm.jb(label);
    }

    jbe(label) {
        this.asm.jbe(label);
    }

    ja(label) {
        this.asm.ja(label);
    }

    jae(label) {
        this.asm.jae(label);
    }

    // ========== 函数调用 ==========

    prologue(stackSize, savedRegs) {
        // 保存 RBP
        this.asm.push(Reg.RBP);
        this.asm.movReg(Reg.RBP, Reg.RSP);

        // 过滤 S5（它使用栈槽位，不是 push/pop）
        const regsWithoutS5 = savedRegs.filter((r) => !this.isS5(r));
        const hasS5 = savedRegs.some((r) => this.isS5(r));

        // 保存 callee-saved 寄存器
        for (const vreg of regsWithoutS5) {
            this.asm.push(this.mapReg(vreg));
        }

        // 计算栈空间：原始 stackSize + S5 槽位（如果需要）
        let totalStack = stackSize;
        if (hasS5) {
            totalStack += 8; // S5 槽位
        }

        // 分配栈空间（16 字节对齐）
        const aligned = totalStack > 0 ? Math.ceil(totalStack / 16) * 16 : 0;
        if (aligned > 0) {
            this.asm.subImm(Reg.RSP, aligned);
        }

        // S5 槽位在分配的栈空间的最高地址处（紧贴 pushed regs 下方）
        // 栈布局：
        //   [RBP + 8]  返回地址
        //   [RBP]      old RBP
        //   [RBP - 8]  第一个 saved reg
        //   [RBP - 16] 第二个 saved reg
        //   ...
        //   [RBP - N*8] 最后一个 saved reg (N = regsWithoutS5.length)
        //   [RBP - N*8 - 8] S5 槽位 (如果 hasS5)
        //   ... 剩余栈空间 ...
        //   [RSP] 栈底
        if (hasS5) {
            const savedRegBytes = regsWithoutS5.length * 8;
            this.s5StackOffset = -(savedRegBytes + 8);
        }
    }

    epilogue(savedRegs, stackSize) {
        // 过滤 S5（它使用栈槽位，不是 push/pop）
        const regsWithoutS5 = savedRegs.filter((r) => !this.isS5(r));
        const hasS5 = savedRegs.some((r) => this.isS5(r));

        // 计算总栈空间
        let totalStack = stackSize;
        if (hasS5) {
            totalStack += 8; // S5 槽位
        }
        const aligned = totalStack > 0 ? Math.ceil(totalStack / 16) * 16 : 0;

        // 恢复栈空间（使 RSP 指向 saved regs）
        if (aligned > 0) {
            this.asm.addImm(Reg.RSP, aligned);
        }

        // 恢复 callee-saved 寄存器（反序 pop）
        for (let i = regsWithoutS5.length - 1; i >= 0; i--) {
            this.asm.pop(this.mapReg(regsWithoutS5[i]));
        }

        // 恢复 RBP 并返回
        this.asm.pop(Reg.RBP);
        this.asm.ret();
    }

    call(label) {
        this.asm.call(label);
    }

    callIndirect(reg) {
        // CALL reg - 间接调用
        const r = this._getReg(reg, Reg.R10);
        this.asm.callReg(r);
    }

    // [引擎库] cache 维护(x86 I-cache 与 D-cache 一致,写码后无需显式刷新 —— 同线程
    // JIT 靠后续的分支/跳转自然序列化;故 x64 版为 no-op,与 arm64 的 dc cvau/ic ivau
    // 对齐接口。_engine_iflush 在 x64 上退化为无副作用的空循环)。
    dcCvau(reg) { /* x86: no-op */ }
    icIvau(reg) { /* x86: no-op */ }
    dsbIsh() { /* x86: no-op */ }
    isb() { /* x86: no-op */ }

    // [M3] 原子 RMW:x64 多 M 调度器走段寄存器 TLS(§3.2,后置)→ 本轮并行调度器
    // 仅 linux-arm64 有真体,x64 从不发射这些。留显式 throw 以便未来接线时立即暴露。
    ldaxr() { throw new Error("[M3] atomic ldaxr not implemented on x64 (segment-TLS multi-M deferred)"); }
    stlxr() { throw new Error("[M3] atomic stlxr not implemented on x64 (segment-TLS multi-M deferred)"); }
    clrex() { throw new Error("[M3] atomic clrex not implemented on x64"); }
    stlr() { throw new Error("[M3] atomic stlr not implemented on x64"); }

    jmpIndirect(reg) {
        // JMP reg - 间接跳转 (不保存返回地址)
        const r = this._getReg(reg, Reg.R10);
        this.asm.jmpReg(r);
    }

    ret() {
        this.asm.ret();
    }

    prepareCall(args) {
        // 将参数放入寄存器
        for (let i = 0; i < args.length && i < this.callRegs.length; i++) {
            const arg = args[i];
            const targetReg = this.callRegs[i];
            if (typeof arg === "number") {
                this.asm.movImm(targetReg, arg);
            } else {
                const srcReg = this._getReg(arg, Reg.R10);
                if (srcReg !== targetReg) {
                    this.asm.movReg(targetReg, srcReg);
                }
            }
        }
    }

    // ========== 栈操作 ==========

    push(reg) {
        const r = this._getReg(reg, Reg.R10);
        this.asm.push(r);
    }

    pop(reg) {
        if (this.isS5(reg)) {
            this.asm.pop(Reg.R10);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.R10);
        } else {
            this.asm.pop(this.mapReg(reg));
        }
    }

    // ========== 系统调用 ==========

    syscall(num) {
        // macOS/Linux x64 syscall 约定:
        // 参数: rdi, rsi, rdx, r10, r8, r9 (注意第 4 个是 r10，不是 rcx)
        // syscall 指令会破坏 rcx 和 r11
        // 我们的 A3 映射到 rcx，需要复制到 r10
        this.asm.movReg(Reg.R10, Reg.RCX);
        this.asm.movImm(Reg.RAX, num);
        this.asm.syscall();
    }

    // 动态系统调用号：从寄存器读取调用号（__syscall 内建用）。
    // 调用者用 V1(=RCX) 传号，A0..A2 已就位。号必须进 RAX。
    // 注意 x64 上 V1==A3==RCX：>=4 参数的系统调用会冲突(A3 被号覆盖)，
    // 但 self-host 的 I/O(write/read/open/close/exit 等)均 <=3 参数，未触发。
    syscallReg(reg) {
        const rs = this._getReg(reg, Reg.RAX);
        if (rs !== Reg.RAX) {
            this.asm.movReg(Reg.RAX, rs);
        }
        this.asm.movReg(Reg.R10, Reg.RCX); // A3 -> R10 (第4参数；未用时无害)
        this.asm.syscall();
    }

    // Windows API 调用
    // slotIndex: IAT 槽索引 (0=VirtualAlloc, 1=GetStdHandle, 2=WriteConsoleA, 3=ExitProcess)
    callWindowsAPI(slotIndex) {
        // Windows x64 调用约定:
        // 参数: rcx, rdx, r8, r9 (前 4 个)
        // 返回值: rax
        // 需要 32 字节 shadow space
        // 调用者需要 16 字节栈对齐

        // 内部约定现为 SysV:A0=RDI, A1=RSI, A2=RDX, A3=RCX。
        // 搬进 Win ABI 的 RCX/RDX/R8/R9。顺序保证 dest 覆盖前先读完 source:
        // 先 R9←RCX(A3)、R8←RDX(A2)(RCX/RDX 随后被当 dest 覆盖),再 RDX←RSI、RCX←RDI。
        this.asm.movReg(Reg.R9, Reg.RCX); // arg3 = A3
        this.asm.movReg(Reg.R8, Reg.RDX); // arg2 = A2
        this.asm.movReg(Reg.RDX, Reg.RSI); // arg1 = A1
        this.asm.movReg(Reg.RCX, Reg.RDI); // arg0 = A0

        // 分配 shadow space (32 字节) + 栈对齐
        this.asm.subImm(Reg.RSP, 40); // 32 shadow + 8 对齐

        // 通过 IAT 调用
        // 假设 IAT 基址在某个位置，这里使用 RIP 相对寻址
        // call qword ptr [rip + iat_offset]
        // 需要生成: FF 15 xx xx xx xx (call [rip+disp32])
        this.asm.callIAT(slotIndex);

        // 恢复栈
        this.asm.addImm(Reg.RSP, 40);
    }

    // Windows WriteConsoleA 调用
    // 输入: A1=buffer, A2=length
    // IAT 槽: 1=GetStdHandle, 2=WriteConsoleA
    callWindowsWriteConsole() {
        // 保存 callee-saved 寄存器
        this.asm.push(Reg.RBX);
        this.asm.push(Reg.R12);
        this.asm.push(Reg.R13);

        // 内部约定为 SysV:A1=RSI=buffer, A2=RDX=length(A0=fd 忽略,用 GetStdHandle)
        this.asm.movReg(Reg.R12, Reg.RSI); // buffer (A1=RSI)
        this.asm.movReg(Reg.R13, Reg.RDX); // length (A2=RDX)

        // 分配栈空间: 32 shadow + 8 lpWritten + 8 5th param + 48 for XMM0-XMM5 + 对齐
        // 总共 104 字节，但需要 16 字节对齐
        // 当前: 3 个 push 后栈偏移了 24 字节
        // 104 + 24 = 128，128 % 16 = 0，对齐OK
        // 但 56 + 48 = 104，不是 8 的倍数...让我们用 112 (56 + 56 for 7 XMM slots)
        this.asm.subImm(Reg.RSP, 104);

        // 保存 XMM0-XMM5 到栈上 (偏移从 56 开始，在 shadow space 和 lpWritten 之后)
        this.asm.movsdToStack(56, 0); // XMM0
        this.asm.movsdToStack(64, 1); // XMM1
        this.asm.movsdToStack(72, 2); // XMM2
        this.asm.movsdToStack(80, 3); // XMM3
        this.asm.movsdToStack(88, 4); // XMM4
        this.asm.movsdToStack(96, 5); // XMM5

        // GetStdHandle(STD_OUTPUT_HANDLE = -11)
        this.asm.movImm(Reg.RCX, -11);
        this.asm.callRipRel("__imp_GetStdHandle_1");

        // RAX = stdout handle，保存到 RBX
        this.asm.movReg(Reg.RBX, Reg.RAX);

        // WriteConsoleA(hConsoleOutput, lpBuffer, nNumberOfCharsToWrite, lpNumberOfCharsWritten, lpReserved)
        this.asm.movReg(Reg.RCX, Reg.RBX); // hConsoleOutput
        this.asm.movReg(Reg.RDX, Reg.R12); // lpBuffer
        this.asm.movReg(Reg.R8, Reg.R13); // nNumberOfCharsToWrite
        this.asm.leaReg(Reg.R9, Reg.RSP, 40); // lpNumberOfCharsWritten (栈上)
        // lpReserved = NULL (第 5 个参数在 RSP+32)
        this.asm.movImm(Reg.RAX, 0);
        this.asm.movStoreOffset(Reg.RSP, 32, Reg.RAX);
        // 用 WriteFile 而非 WriteConsoleA:后者对管道/重定向句柄(CI、shell 捕获)
        // 静默失败,前者对真控制台与管道都有效。参数形状相同(5 参,lpOverlapped=NULL)。
        this.asm.callRipRel("__imp_WriteFile_7");

        // 恢复 XMM0-XMM5
        this.asm.movsdFromStack(0, 56); // XMM0
        this.asm.movsdFromStack(1, 64); // XMM1
        this.asm.movsdFromStack(2, 72); // XMM2
        this.asm.movsdFromStack(3, 80); // XMM3
        this.asm.movsdFromStack(4, 88); // XMM4
        this.asm.movsdFromStack(5, 96); // XMM5

        // 恢复栈
        this.asm.addImm(Reg.RSP, 104);
        this.asm.pop(Reg.R13);
        this.asm.pop(Reg.R12);
        this.asm.pop(Reg.RBX);
    }

    // Windows ExitProcess 调用
    // 输入: A0=exit_code (RCX in Windows ABI)
    // IAT 槽: 3=ExitProcess
    // GetCommandLineA() -> 命令行字符串指针(RET/RAX)。无参,对齐 shadow space。
    callWindowsGetCommandLine() {
        this.asm.subImm(Reg.RSP, 40); // 32 shadow + 8 对齐(入口≡8 → ≡0 前调用)
        this.asm.callRipRel("__imp_GetCommandLineA_9");
        this.asm.addImm(Reg.RSP, 40);
        // 结果已在 RAX = RET
    }

    callWindowsExitProcess() {
        // 内部约定为 SysV:A0=RDI=exit_code,搬进 Win ABI 的 RCX
        this.asm.movReg(Reg.RCX, Reg.RDI);
        // 分配 shadow space
        this.asm.subImm(Reg.RSP, 40);
        this.asm.callRipRel("__imp_ExitProcess_3");
        // ExitProcess 不会返回，但为了代码完整性
        this.asm.addImm(Reg.RSP, 40);
    }

    // ========== Windows fs 面(自举需要):完整叶函数体,含 ret ==========
    // 内部约定为 SysV:A0=RDI, A1=RSI, A2=RDX。函数体内搬进 Win ABI(RCX/RDX/R8/R9)。
    // 这些是**独立函数**(经 vm.call 进入,入口 RSP≡8),内部调用约定不保证调用方
    // 调用前 16 对齐,故必须**显式对齐**:push RBP; mov RBP,RSP; and RSP,-16; sub 0x80。
    // 之后 RSP 恒 16 对齐,call [IAT] 满足 Win ABI 对齐要求(否则 kernel32 内 movaps fault)。
    // 帧布局(RSP 相对,均 <0x80):
    //   [0x00..0x20) shadow space  · [0x20/0x28/0x30] 第 5/6/7 API 参数
    //   [0x38] DWORD 输出槽(bytesRead/Written;先清零再 64 位读)
    //   [0x40..0x70) XMM0-5 保护(kernel32 可能踩易失 XMM,同 WriteConsoleA 路径)
    _emitWinFrameEnter() {
        this.asm.push(Reg.RBP);
        this.asm.movReg(Reg.RBP, Reg.RSP);
        this.asm.andImm(Reg.RSP, -16); // 对齐到 16
        this.asm.subImm(Reg.RSP, 0x80);
        for (let i = 0; i < 6; i++) this.asm.movsdToStack(0x40 + i * 8, i);
    }
    _emitWinFrameLeave() {
        for (let i = 0; i < 6; i++) this.asm.movsdFromStack(i, 0x40 + i * 8);
        this.asm.movReg(Reg.RSP, Reg.RBP);
        this.asm.pop(Reg.RBP);
        this.asm.ret();
    }

    // _win_open(A0=path cstr, A1=mode 0=r/1=w-trunc/2=a) -> HANDLE 或 -1
    emitWinOpenBody() {
        this._emitWinFrameEnter();
        this.asm.movReg(Reg.RCX, Reg.RDI); // lpFileName = path (A0=RDI);分支不碰 RCX
        // mode 留在 RSI(A1),分支直接 cmp;RSI 到 CreateFileA 前不会被踩
        this.asm.movImm(Reg.RDX, 0x80000000); // 默认读:GENERIC_READ
        this.asm.movImm(Reg.RAX, 3);          // disposition OPEN_EXISTING
        this.asm.cmpImm(Reg.RSI, 1);
        this.asm.jne("_win_open_not_w");
        this.asm.movImm(Reg.RDX, 0x40000000); // w:GENERIC_WRITE
        this.asm.movImm(Reg.RAX, 2);          // CREATE_ALWAYS
        this.asm.jmp("_win_open_disp");
        this.asm.label("_win_open_not_w");
        this.asm.cmpImm(Reg.RSI, 2);
        this.asm.jne("_win_open_disp");
        this.asm.movImm(Reg.RDX, 0x40000000); // a:GENERIC_WRITE
        this.asm.movImm(Reg.RAX, 4);          // OPEN_ALWAYS(追加定位暂未处理)
        this.asm.label("_win_open_disp");
        this.asm.movStoreOffset(Reg.RSP, 0x20, Reg.RAX); // dwCreationDisposition
        this.asm.movImm(Reg.RAX, 0x80);                  // FILE_ATTRIBUTE_NORMAL
        this.asm.movStoreOffset(Reg.RSP, 0x28, Reg.RAX);
        this.asm.movImm(Reg.RAX, 0);                     // hTemplateFile = NULL
        this.asm.movStoreOffset(Reg.RSP, 0x30, Reg.RAX);
        this.asm.movImm(Reg.R8, 3); // dwShareMode = READ|WRITE
        this.asm.movImm(Reg.R9, 0); // lpSecurityAttributes = NULL
        this.asm.callRipRel("__imp_CreateFileA_5");
        // INVALID_HANDLE_VALUE 即 -1,原样在 RAX 返回
        this._emitWinFrameLeave();
    }

    // _win_read(A0=h, A1=buf, A2=len) -> 读到的字节数(EOF 为 0)或 -1
    emitWinReadBody() {
        this._emitWinReadWriteBody("__imp_ReadFile_6", "_win_read");
    }

    // _win_write(A0=h, A1=buf, A2=len) -> 写出的字节数或 -1
    emitWinWriteBody() {
        this._emitWinReadWriteBody("__imp_WriteFile_7", "_win_write");
    }

    _emitWinReadWriteBody(impLabel, lblBase) {
        // 内部 SysV:h=A0=RDI, buf=A1=RSI, len=A2=RDX。搬进 Win ABI:
        // ReadFile/WriteFile(RCX=h, RDX=buf, R8=len, R9=lpDone, [rsp+0x20]=lpOverlapped NULL)。
        // 先 R8←RDX(len) 再 RDX←RSI(buf),避免 RDX 覆盖前丢 len。
        const failLbl = lblBase + "_fail";
        const doneLbl = lblBase + "_done";
        this._emitWinFrameEnter();
        this.asm.movReg(Reg.R8, Reg.RDX);  // len (A2=RDX) — 先读
        this.asm.movReg(Reg.RDX, Reg.RSI); // buf (A1=RSI)
        this.asm.movReg(Reg.RCX, Reg.RDI); // h   (A0=RDI)
        this.asm.movImm(Reg.RAX, 0);
        this.asm.movStoreOffset(Reg.RSP, 0x38, Reg.RAX); // 清零 DWORD 输出槽
        this.asm.movStoreOffset(Reg.RSP, 0x20, Reg.RAX); // lpOverlapped = NULL
        this.asm.leaReg(Reg.R9, Reg.RSP, 0x38);
        this.asm.callRipRel(impLabel);
        this.asm.cmpImm(Reg.RAX, 0);
        this.asm.je(failLbl);
        this.asm.movLoadOffset(Reg.RAX, Reg.RSP, 0x38); // 字节数(槽已清零,高位为 0)
        this.asm.jmp(doneLbl);
        this.asm.label(failLbl);
        this.asm.movImm(Reg.RAX, -1);
        this.asm.label(doneLbl);
        this._emitWinFrameLeave();
    }

    // _win_close(A0=h) -> 0
    emitWinCloseBody() {
        // 内部 SysV:h=A0=RDI → Win ABI RCX。复用对齐帧(0x80 够 shadow space)。
        this._emitWinFrameEnter();
        this.asm.movReg(Reg.RCX, Reg.RDI);
        this.asm.callRipRel("__imp_CloseHandle_8");
        this.asm.movImm(Reg.RAX, 0);
        this._emitWinFrameLeave();
    }

    // 通用 IAT 调用方法
    // funcName: Windows API 函数名或槽位索引
    callIAT(funcNameOrSlot) {
        // Windows API 名称到槽位的映射
        const slotMap = {
            VirtualAlloc: 0,
            GetStdHandle: 1,
            WriteConsoleA: 2,
            ExitProcess: 3,
            GetSystemTimeAsFileTime: 4,
        };

        let slotIndex;
        if (typeof funcNameOrSlot === "string") {
            slotIndex = slotMap[funcNameOrSlot];
            if (slotIndex === undefined) {
                throw new Error(`Unknown Windows API: ${funcNameOrSlot}`);
            }
        } else {
            slotIndex = funcNameOrSlot;
        }

        // Windows x64 调用约定:
        // 参数: rcx, rdx, r8, r9 (前 4 个)
        // 返回值: rax
        // 需要 32 字节 shadow space

        // 参数重映射 (System V -> Windows)
        // A0(RDI) -> RCX, A1(RSI) -> RDX, A2(RDX) -> R8, A3(RCX) -> R9
        this.asm.movReg(Reg.R10, Reg.RDI); // 保存 A0
        this.asm.movReg(Reg.R11, Reg.RSI); // 保存 A1
        this.asm.movReg(Reg.RCX, Reg.R10); // 第1参数: A0 -> RCX
        this.asm.movReg(Reg.R8, Reg.RDX); // 第3参数: A2 -> R8
        this.asm.movReg(Reg.RDX, Reg.R11); // 第2参数: A1 -> RDX

        // 分配 shadow space (32 字节) + 对齐
        this.asm.subImm(Reg.RSP, 40);

        // 通过 IAT 调用
        this.asm.callIAT(slotIndex);

        // 恢复栈
        this.asm.addImm(Reg.RSP, 40);
    }

    // ========== 类型转换 ==========

    // Float to Int: 从 Number 对象中提取整数值
    // src 是指向 Number 对象的指针，dest 接收整数值
    f2i(dest, src) {
        const rd = this.mapReg(dest);
        const rs = this._getReg(src, Reg.R10);
        // Number 对象: offset 0 = type, offset 8 = float64 bits
        // 加载 float64 位模式到 R11
        this.asm.movLoadOffset(Reg.R11, rs, 8);
        // 将位模式移到 XMM0
        this.asm.movqToXmm(0, Reg.R11);
        // 转换为整数 (cvttsd2si)
        this.asm.cvttsd2si(rd, 0);
    }

    // ========== 浮点运算 (VM 抽象接口实现) ==========

    // 将整数寄存器的位模式移动到 XMM 浮点寄存器
    fmovToFloat(fpReg, gpReg) {
        const gp = this._getReg(gpReg, Reg.R10);
        this.asm.movqToXmm(fpReg, gp);
    }

    // 将 XMM 浮点寄存器的位模式移动到整数寄存器
    fmovToInt(gpReg, fpReg) {
        if (this.isS5(gpReg)) {
            this.asm.movqFromXmm(Reg.R10, fpReg);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.R10);
        } else {
            this.asm.movqFromXmm(this.mapReg(gpReg), fpReg);
        }
    }

    // 浮点加法
    fadd(fpDest, fpA, fpB) {
        // x64 SSE: addsd 是 dest = dest + src
        if (fpDest !== fpA) {
            this.asm.movsd(fpDest, fpA);
        }
        this.asm.addsd(fpDest, fpB);
    }

    // 浮点减法
    fsub(fpDest, fpA, fpB) {
        if (fpDest !== fpA) {
            this.asm.movsd(fpDest, fpA);
        }
        this.asm.subsd(fpDest, fpB);
    }

    // 浮点乘法
    fmul(fpDest, fpA, fpB) {
        if (fpDest !== fpA) {
            this.asm.movsd(fpDest, fpA);
        }
        this.asm.mulsd(fpDest, fpB);
    }

    // 浮点除法
    fdiv(fpDest, fpA, fpB) {
        if (fpDest !== fpA) {
            this.asm.movsd(fpDest, fpA);
        }
        this.asm.divsd(fpDest, fpB);
    }

    // 浮点转整数 (截断)
    fcvtzs(gpDest, fpSrc) {
        if (this.isS5(gpDest)) {
            this.asm.cvttsd2si(Reg.R10, fpSrc);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.R10);
        } else {
            this.asm.cvttsd2si(this.mapReg(gpDest), fpSrc);
        }
    }

    // 浮点取模: fpDest = fpA % fpB
    fmod(fpDest, fpA, fpB) {
        // 浮点取模: a % b = a - trunc(a / b) * b
        // 使用 XMM7 作为临时寄存器
        this.asm.movsd(7, fpA); // XMM7 = a
        this.asm.divsd(7, fpB); // XMM7 = a / b
        this.asm.roundsd(7, 7, 3); // XMM7 = trunc(XMM7), mode 3 = toward zero
        this.asm.mulsd(7, fpB); // XMM7 = XMM7 * b
        if (fpDest !== fpA) {
            this.asm.movsd(fpDest, fpA);
        }
        this.asm.subsd(fpDest, 7); // fpDest = a - XMM7
    }

    // 浮点与零比较
    fcmpZero(fpReg) {
        // 清零 XMM7 并比较
        this.asm.xorpd(7, 7);
        this.asm.ucomisd(fpReg, 7);
    }

    // 浮点绝对值
    fabs(fpDest, fpSrc) {
        // 使用掩码清除符号位: AND with 0x7FFFFFFFFFFFFFFF
        if (fpDest !== fpSrc) {
            this.asm.movsd(fpDest, fpSrc);
        }
        // 构建掩码到 XMM7
        this.asm.movImm(Reg.RAX, 0x7fffffff);
        this.asm.shlImm(Reg.RAX, 32);
        this.asm.movImm(Reg.RCX, 0xffffffff);
        this.asm.orReg(Reg.RAX, Reg.RCX);
        this.asm.movqToXmm(7, Reg.RAX);
        this.asm.andpd(fpDest, 7);
    }

    // 浮点截断
    ftrunc(fpDest, fpSrc) {
        this.asm.roundsd(fpDest, fpSrc, 3); // mode 3 = toward zero
    }

    // 浮点取反 (negate)
    fneg(fpDest, fpSrc) {
        if (fpDest !== fpSrc) {
            this.asm.movsd(fpDest, fpSrc);
        }
        // 符号位掩码 0x8000000000000000, 用 XORPD 翻转符号位
        this.asm.movImm(Reg.RAX, 0x80000000);
        this.asm.shlImm(Reg.RAX, 32);
        this.asm.movqToXmm(7, Reg.RAX);
        this.asm.xorpd(fpDest, 7);
    }

    // 浮点向下取整 (floor)
    ffloor(fpDest, fpSrc) {
        this.asm.roundsd(fpDest, fpSrc, 1); // mode 1 = toward -inf
    }

    // 浮点平方根
    fsqrt(fpDest, fpSrc) {
        this.asm.sqrtsd(fpDest, fpSrc);
    }

    // 浮点向上取整 (ceil)
    fceil(fpDest, fpSrc) {
        this.asm.roundsd(fpDest, fpSrc, 2); // mode 2 = toward +inf
    }

    // 浮点四舍五入
    // 模拟 arm64 frinta 语义（四舍五入，中间值远离零 ties-away-from-zero），
    // 而非 roundsd mode 0 的银行家舍入（ties-to-even）。
    // half = copysign(0.5, fpSrc); result = trunc(fpSrc + half)
    fround(fpDest, fpSrc) {
        // RAX = 位模式，取符号位
        this.asm.movqFromXmm(Reg.RAX, fpSrc);
        this.asm.movImm(Reg.RCX, 0x80000000);
        this.asm.shlImm(Reg.RCX, 32); // RCX = 0x8000000000000000 符号位掩码
        this.asm.andReg(Reg.RAX, Reg.RCX); // RAX = fpSrc 的符号位
        // RCX = 0.5 的位模式 0x3FE0000000000000
        this.asm.movImm(Reg.RCX, 0x3fe00000);
        this.asm.shlImm(Reg.RCX, 32);
        this.asm.orReg(Reg.RAX, Reg.RCX); // RAX = copysign(0.5, fpSrc) 位模式
        this.asm.movqToXmm(7, Reg.RAX); // XMM7 = copysign(0.5, fpSrc)
        this.asm.addsd(7, fpSrc); // XMM7 = fpSrc + half
        this.asm.roundsd(7, 7, 3); // XMM7 = trunc(...) 向零截断
        this.asm.movsd(fpDest, 7);
    }

    // 整数转浮点: fpDest = (double)gpSrc
    scvtf(fpDest, gpSrc) {
        const gp = this._getReg(gpSrc, Reg.R10);
        this.asm.cvtsi2sd(fpDest, gp);
    }

    // 双精度转单精度
    fcvtd2s(fpDest, fpSrc) {
        this.asm.cvtsd2ss(fpDest, fpSrc);
    }

    // 单精度转双精度
    fcvts2d(fpDest, fpSrc) {
        this.asm.cvtss2sd(fpDest, fpSrc);
    }

    // 将单精度浮点寄存器的位模式移到整数寄存器 (32位)
    fmovToIntSingle(gpDest, fpSrc) {
        if (this.isS5(gpDest)) {
            this.asm.movdFromXmm(Reg.R10, fpSrc);
            this.asm.movStoreOffset(Reg.RBP, this.s5StackOffset, Reg.R10);
        } else {
            this.asm.movdFromXmm(this.mapReg(gpDest), fpSrc);
        }
    }

    // 将单精度整数位模式移到浮点寄存器
    fmovToFloatSingle(fpDest, gpSrc) {
        const gp = this._getReg(gpSrc, Reg.R10);
        this.asm.movdToXmm(fpDest, gp);
    }

    // 浮点比较
    fcmp(fpA, fpB) {
        this.asm.ucomisd(fpA, fpB);
    }

    // 浮点寄存器间移动
    fmov(fpDest, fpSrc) {
        this.asm.movsd(fpDest, fpSrc);
    }
}

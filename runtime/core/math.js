// asm.js Math 运行时
// 实现 Math 对象的运行时函数

import { VReg } from "../../vm/registers.js";

// Math 运行时生成器
export class MathGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    // 生成所有 Math 函数
    generate() {
        this.generateFloor();
        this.generateCeil();
        this.generateRound();
        this.generateAbs();
        this.generatePow();
        this.generateSqrt();
        this.generateLog();
        this.generateLog2();
        this.generateLog10();
        this.generateExp();
        this.generateCbrt();
        this.generateExpm1();
        this.generateLog1p();
        this.generateSinh();
        this.generateCosh();
        this.generateTanh();
        // 三角(fdlibm 风格范围归约 + minimax 核)与反三角/反双曲、fround/clz32。
        this.generateRemPio2();
        this.generateKernelSin();
        this.generateKernelCos();
        this.generateSin();
        this.generateCos();
        this.generateTan();
        this.generateAtan();
        this.generateAtan2();
        this.generateAsin();
        this.generateAcos();
        this.generateAsinh();
        this.generateAcosh();
        this.generateAtanh();
        this.generateFround();
        this.generateF16Round();
        this.generateClz32();
    }

    // 浮点常量装入 d 寄存器的辅助。
    _K(bits, r) { this.vm.movImm64(VReg.V1, bits); this.vm.fmovToFloat(r, VReg.V1); }

    // _math_rem_pio2(A0=x 位) -> RET=r 位(∈[-π/4,π/4] 附近), A1=象限 k&3。
    // Cody-Waite 二段归约:k=round(x·2/π),r=(x-k·pio2_1)-k·pio2_1t。中等 |x| 精度 ~1ulp;
    // 极大 |x| 未做 Payne-Hanek(记偏差:超大参数精度下降)。
    generateRemPio2() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_rem_pio2");
        vm.fmovToFloat(0, VReg.A0);                    // d0 = x
        K(0x3fe45f306dc9c883n, 1); vm.fmul(2, 0, 1);   // d2 = x·(2/π)
        K(0x3fe0000000000000n, 1); vm.fadd(2, 2, 1);   // + 0.5
        vm.ffloor(2, 2);                               // d2 = k(double)
        vm.fcvtzs(VReg.V2, 2);                         // V2 = k(int)
        vm.scvtf(2, VReg.V2);                          // d2 = (double)k
        K(0x3ff921fb54400000n, 1); vm.fmul(3, 2, 1); vm.fsub(4, 0, 3);  // d4 = x - k·pio2_1
        K(0x3dd0b4611a626331n, 1); vm.fmul(3, 2, 1); vm.fsub(4, 4, 3);  // d4 = r
        vm.fmovToInt(VReg.RET, 4);
        vm.andImm(VReg.A1, VReg.V2, 3);                // 象限
        vm.ret();
    }

    // _math_kernel_sin(A0=r 位) -> RET=sin(r);|r|≤π/4。sin=r+r³·(S1+z(S2+…+z·S6)),z=r²。
    generateKernelSin() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_kernel_sin");
        vm.fmovToFloat(0, VReg.A0);      // d0 = r
        vm.fmul(2, 0, 0);                // d2 = z
        K(0x3de5d93a5acfd57cn, 5);       // S6
        K(0xbe5ae5e68a2b9cebn, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // *z+S5
        K(0x3ec71de357b1fe7dn, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +S4
        K(0xbf2a01a019c161d5n, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +S3
        K(0x3f8111111110f8a6n, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +S2
        K(0xbfc5555555555549n, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +S1
        vm.fmul(6, 0, 2); vm.fmul(6, 6, 5); vm.fadd(0, 0, 6);       // r + r·z·poly
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // _math_kernel_cos(A0=r 位) -> RET=cos(r);|r|≤π/4。cos=1-0.5z+z²·(C1+…+z·C6),z=r²。
    generateKernelCos() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_kernel_cos");
        vm.fmovToFloat(0, VReg.A0);      // d0 = r
        vm.fmul(2, 0, 0);                // d2 = z
        K(0xbda8fae9be8838d4n, 5);       // C6
        K(0x3e21ee9ebdb4b1c4n, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +C5
        K(0xbe927e4f809c52adn, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +C4
        K(0x3efa01a019cb1590n, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +C3
        K(0xbf56c16c16c15177n, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +C2
        K(0x3fa555555555554cn, 7); vm.fmul(5,5,2); vm.fadd(5,5,7); // +C1
        vm.fmul(4, 2, 2); vm.fmul(4, 4, 5);        // z²·poly
        K(0x3fe0000000000000n, 6); vm.fmul(6, 6, 2); // 0.5z
        K(0x3ff0000000000000n, 0); vm.fsub(0,0,6); vm.fadd(0,0,4); // 1 - 0.5z + z²poly
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // ±Inf/NaN → NaN(IEEE;rem_pio2 对 Inf 得 Inf 会污染 kernel)。
    generateSin() {
        const vm = this.vm;
        vm.label("_math_sin");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        // sin(±0) 必须原样保留零的符号；范围归约里的加减会把 -0 变成 +0。
        vm.shlImm(VReg.V2, VReg.A0, 1);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_msin_nonzero");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_msin_nonzero");
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_msin_finite");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_msin_finite");
        vm.call("_math_rem_pio2");            // RET=r, A1=q
        vm.mov(VReg.S0, VReg.A1); vm.mov(VReg.S1, VReg.RET);
        vm.andImm(VReg.V0, VReg.S0, 1); vm.cmpImm(VReg.V0, 0); vm.jne("_msin_c");
        vm.mov(VReg.A0, VReg.S1); vm.call("_math_kernel_sin"); vm.jmp("_msin_s");
        vm.label("_msin_c"); vm.mov(VReg.A0, VReg.S1); vm.call("_math_kernel_cos");
        vm.label("_msin_s");
        vm.andImm(VReg.V2, VReg.S0, 2); vm.cmpImm(VReg.V2, 0); vm.jeq("_msin_d"); // (x64 V2==A2 无活值;V0≡RET 会盖掉 kernel 结果)
        vm.fmovToFloat(0, VReg.RET); vm.fneg(0,0); vm.fmovToInt(VReg.RET,0);
        vm.label("_msin_d");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // ±Inf/NaN → NaN(同 sin)。
    generateCos() {
        const vm = this.vm;
        vm.label("_math_cos");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mcos_finite");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mcos_finite");
        vm.call("_math_rem_pio2");
        vm.mov(VReg.S0, VReg.A1); vm.mov(VReg.S1, VReg.RET);
        vm.andImm(VReg.V0, VReg.S0, 1); vm.cmpImm(VReg.V0, 0); vm.jne("_mcos_s");
        vm.mov(VReg.A0, VReg.S1); vm.call("_math_kernel_cos"); vm.jmp("_mcos_g");
        vm.label("_mcos_s"); vm.mov(VReg.A0, VReg.S1); vm.call("_math_kernel_sin");
        vm.label("_mcos_g");
        vm.addImm(VReg.V2, VReg.S0, 1); vm.andImm(VReg.V2, VReg.V2, 2); vm.cmpImm(VReg.V2, 0); vm.jeq("_mcos_d"); // (x64 V2==A2 无活值;V0≡RET 会盖掉 kernel 结果)
        vm.fmovToFloat(0, VReg.RET); vm.fneg(0,0); vm.fmovToInt(VReg.RET,0);
        vm.label("_mcos_d");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    generateTan() {
        const vm = this.vm;
        vm.label("_math_tan");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_math_sin"); vm.mov(VReg.S1, VReg.RET);   // sin
        vm.mov(VReg.A0, VReg.S0); vm.call("_math_cos");    // cos
        vm.fmovToFloat(1, VReg.RET); vm.fmovToFloat(0, VReg.S1);
        vm.fdiv(0, 0, 1); vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _math_atan(A0=x) -> RET=atan(x)。fdlibm __atan:按 |x| 分 4 段归约到小区间,11 项有理多项式。
    generateAtan() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_atan");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.shrImm(VReg.S0, VReg.A0, 63);               // S0 = 符号位
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn); vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.fmovToFloat(0, VReg.V0);                    // d0 = |x|
        vm.movImm(VReg.S1, -1);                        // S1 = id(默认 -1)
        // 段选择(阈值:0.4375/0.6875/1.1875/2.4375)
        vm.movImm64(VReg.V1, 0x3fdc000000000000n); vm.fmovToFloat(1, VReg.V1); vm.fcmp(0, 1); vm.jflt("_matan_poly"); // <0.4375 → id=-1
        vm.movImm64(VReg.V1, 0x3fe6000000000000n); vm.fmovToFloat(1, VReg.V1); vm.fcmp(0, 1); vm.jfge("_matan_s1");   // >=0.6875
        // id=0: x = (2x-1)/(2+x)
        vm.movImm(VReg.S1, 0);
        K(0x4000000000000000n, 2); vm.fmul(3, 2, 0); K(0x3ff0000000000000n, 4); vm.fsub(3, 3, 4); // 2x-1
        vm.fadd(4, 2, 0);                              // 2+x
        vm.fdiv(0, 3, 4); vm.jmp("_matan_poly");
        vm.label("_matan_s1");
        vm.movImm64(VReg.V1, 0x3ff3000000000000n); vm.fmovToFloat(1, VReg.V1); vm.fcmp(0, 1); vm.jfge("_matan_s2");   // >=1.1875
        // id=1: x = (x-1)/(x+1)
        vm.movImm(VReg.S1, 1);
        K(0x3ff0000000000000n, 4); vm.fsub(3, 0, 4); vm.fadd(5, 0, 4); vm.fdiv(0, 3, 5); vm.jmp("_matan_poly");
        vm.label("_matan_s2");
        vm.movImm64(VReg.V1, 0x4003800000000000n); vm.fmovToFloat(1, VReg.V1); vm.fcmp(0, 1); vm.jfge("_matan_s3");   // >=2.4375
        // id=2: x = (x-1.5)/(1+1.5x)
        vm.movImm(VReg.S1, 2);
        K(0x3ff8000000000000n, 2); vm.fsub(3, 0, 2); K(0x3ff0000000000000n, 4); vm.fmul(5, 2, 0); vm.fadd(5, 5, 4); vm.fdiv(0, 3, 5); vm.jmp("_matan_poly");
        vm.label("_matan_s3");
        // id=3: x = -1/x
        vm.movImm(VReg.S1, 3);
        K(0x3ff0000000000000n, 4); vm.fdiv(0, 4, 0); vm.fneg(0, 0);
        vm.label("_matan_poly");
        // z = x², w = z²
        vm.fmul(2, 0, 0); vm.fmul(4, 2, 2);           // d2=z, d4=w
        // s1 = z·(aT0 + w(aT2 + w(aT4 + w(aT6 + w(aT8 + w·aT10)))))
        K(0x3f90ad3ae322da11n, 5);                    // aT10
        K(0x3fa97b4b24760debn, 7); vm.fmul(5,5,4); vm.fadd(5,5,7); // aT8
        K(0x3fb10d66a0d03d51n, 7); vm.fmul(5,5,4); vm.fadd(5,5,7); // aT6
        K(0x3fb745cdc54c206en, 7); vm.fmul(5,5,4); vm.fadd(5,5,7); // aT4
        K(0x3fc24924920083ffn, 7); vm.fmul(5,5,4); vm.fadd(5,5,7); // aT2
        K(0x3fd555555555550dn, 7); vm.fmul(5,5,4); vm.fadd(5,5,7); // aT0
        vm.fmul(5, 5, 2);                             // d5 = s1
        // s2 = w·(aT1 + w(aT3 + w(aT5 + w(aT7 + w·aT9))))
        K(0xbfa2b4442c6a6c2fn, 6);                    // aT9
        K(0xbfadde2d52defd9an, 7); vm.fmul(6,6,4); vm.fadd(6,6,7); // aT7
        K(0xbfb3b0f2af749a6dn, 7); vm.fmul(6,6,4); vm.fadd(6,6,7); // aT5
        K(0xbfbc71c6fe231671n, 7); vm.fmul(6,6,4); vm.fadd(6,6,7); // aT3
        K(0xbfc999999998ebc4n, 7); vm.fmul(6,6,4); vm.fadd(6,6,7); // aT1
        vm.fmul(6, 6, 4);                             // d6 = s2
        vm.fadd(5, 5, 6);                             // d5 = s1+s2
        // id<0: result = x - x·(s1+s2)
        vm.cmpImm(VReg.S1, 0); vm.jge("_matan_seg");
        vm.fmul(6, 0, 5); vm.fsub(0, 0, 6); vm.jmp("_matan_sign");
        vm.label("_matan_seg");
        // result = atanhi[id] - ((x·(s1+s2) - atanlo[id]) - x)
        // 取 atanhi/atanlo[id]:用分支选常量(id∈{0,1,2,3})
        vm.fmul(6, 0, 5);                             // x·(s1+s2)
        // 选 atanlo,减:d6 = x·s - atanlo[id]
        vm.cmpImm(VReg.S1, 0); vm.jeq("_matan_lo0");
        vm.cmpImm(VReg.S1, 1); vm.jeq("_matan_lo1");
        vm.cmpImm(VReg.S1, 2); vm.jeq("_matan_lo2");
        K(0x3c91a62633145c07n, 7); vm.jmp("_matan_lodone"); // atanlo3
        vm.label("_matan_lo0"); K(0x3c7a2b7f222f65e2n, 7); vm.jmp("_matan_lodone");
        vm.label("_matan_lo1"); K(0x3c81a62633145c07n, 7); vm.jmp("_matan_lodone");
        vm.label("_matan_lo2"); K(0x3c7007887af0cbbdn, 7);
        vm.label("_matan_lodone");
        vm.fsub(6, 6, 7);                             // x·s - atanlo
        vm.fsub(6, 6, 0);                             // (…) - x
        // atanhi[id]:
        vm.cmpImm(VReg.S1, 0); vm.jeq("_matan_hi0");
        vm.cmpImm(VReg.S1, 1); vm.jeq("_matan_hi1");
        vm.cmpImm(VReg.S1, 2); vm.jeq("_matan_hi2");
        K(0x3ff921fb54442d18n, 0); vm.jmp("_matan_hidone"); // atanhi3
        vm.label("_matan_hi0"); K(0x3fddac670561bb4fn, 0); vm.jmp("_matan_hidone");
        vm.label("_matan_hi1"); K(0x3fe921fb54442d18n, 0); vm.jmp("_matan_hidone");
        vm.label("_matan_hi2"); K(0x3fef730bd281f69bn, 0);
        vm.label("_matan_hidone");
        vm.fsub(0, 0, 6);                             // atanhi - (…)
        vm.label("_matan_sign");
        vm.cmpImm(VReg.S0, 0); vm.jeq("_matan_done");
        vm.fneg(0, 0);
        vm.label("_matan_done");
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _math_atan2(A0=y, A1=x) -> RET=atan2(y,x)。象限逻辑 + _math_atan(y/x)。
    generateAtan2() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_atan2");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);                     // y 位
        vm.mov(VReg.S1, VReg.A1);                     // x 位
        // 任一 NaN → NaN。必须先于 x==0 特判，否则 atan2(NaN, 0) 会误返 π/2。
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.cmp(VReg.V2, VReg.V1); vm.jne("_matan2_x_nan_chk");
        vm.movImm64(VReg.V1, 0x000fffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V2, 0); vm.jne("_matan2_nan");
        vm.label("_matan2_x_nan_chk");
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.and(VReg.V2, VReg.S1, VReg.V1);
        vm.cmp(VReg.V2, VReg.V1); vm.jne("_matan2_not_nan");
        vm.movImm64(VReg.V1, 0x000fffffffffffffn);
        vm.and(VReg.V2, VReg.S1, VReg.V1);
        vm.cmpImm(VReg.V2, 0); vm.jeq("_matan2_not_nan");
        vm.label("_matan2_nan");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_matan2_not_nan");
        // x==0 分支(位:±0 都算 0):判 x 的非符号位是否全 0
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn); vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.cmpImm(VReg.V0, 0); vm.jne("_matan2_xnz");
        // x==0:y>0 → π/2;y<0 → -π/2;y==0 → 0
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn); vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0); vm.jeq("_matan2_zero");
        vm.shrImm(VReg.V0, VReg.S0, 63); vm.cmpImm(VReg.V0, 0); vm.jne("_matan2_neghalf");
        vm.movImm64(VReg.RET, 0x3ff921fb54442d18n); vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0); // π/2
        vm.label("_matan2_neghalf");
        vm.movImm64(VReg.RET, 0xbff921fb54442d18n); vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0); // -π/2
        vm.label("_matan2_zero");
        // y=±0,x=+0 → y；x=-0 → ±π（符号取 y）。
        vm.shrImm(VReg.V2, VReg.S1, 63);
        vm.cmpImm(VReg.V2, 0); vm.jne("_matan2_zero_xneg");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_matan2_zero_xneg");
        vm.shrImm(VReg.V2, VReg.S0, 63);
        vm.cmpImm(VReg.V2, 0); vm.jne("_matan2_zero_negpi");
        vm.movImm64(VReg.RET, 0x400921fb54442d18n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_matan2_zero_negpi");
        vm.movImm64(VReg.RET, 0xc00921fb54442d18n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_matan2_xnz");
        // a = atan(y/x)
        vm.fmovToFloat(0, VReg.S0); vm.fmovToFloat(1, VReg.S1); vm.fdiv(0, 0, 1);
        vm.fmovToInt(VReg.A0, 0); vm.call("_math_atan");   // RET = atan(y/x)
        // x>0 → a;x<0 → a±π(y>=0 加,y<0 减)
        vm.shrImm(VReg.V2, VReg.S1, 63); vm.cmpImm(VReg.V2, 0); vm.jeq("_matan2_done"); // x>0(x64 V2==A2 无活值;V0≡RET 会盖掉 atan 结果)
        vm.fmovToFloat(0, VReg.RET);
        K(0x400921fb54442d18n, 1);                    // π
        vm.shrImm(VReg.V0, VReg.S0, 63); vm.cmpImm(VReg.V0, 0); vm.jne("_matan2_sub");
        vm.fadd(0, 0, 1); vm.jmp("_matan2_adj");
        vm.label("_matan2_sub"); vm.fsub(0, 0, 1);
        vm.label("_matan2_adj"); vm.fmovToInt(VReg.RET, 0);
        vm.label("_matan2_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _math_asin(A0=x) = atan2(x, sqrt(1-x²))
    generateAsin() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_asin");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.fmovToFloat(0, VReg.A0); vm.fmul(2, 0, 0); K(0x3ff0000000000000n, 1); vm.fsub(2, 1, 2); vm.fsqrt(2, 2); // sqrt(1-x²)
        vm.fmovToInt(VReg.A1, 2); vm.mov(VReg.A0, VReg.S0); vm.call("_math_atan2");
        vm.epilogue([VReg.S0], 0);
    }

    // _math_acos(A0=x) = atan2(sqrt(1-x²), x)
    generateAcos() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_acos");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.fmovToFloat(0, VReg.A0); vm.fmul(2, 0, 0); K(0x3ff0000000000000n, 1); vm.fsub(2, 1, 2); vm.fsqrt(2, 2);
        vm.fmovToInt(VReg.A0, 2); vm.mov(VReg.A1, VReg.S0); vm.call("_math_atan2");
        vm.epilogue([VReg.S0], 0);
    }

    // _math_asinh(A0=x) = log(x + sqrt(x²+1)); ±Inf → ±Inf(公式在 ±Inf 得 NaN)。
    generateAsinh() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_asinh");
        vm.prologue(0, []);
        // 指数全 1(Inf/NaN):原样返回(含符号的 ±Inf;NaN 透传)
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_masinh_finite");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([], 0);
        vm.label("_masinh_finite");
        // ±0 保号:公式 log(x+√(x²+1)) 在 -0 得 +0(−0+1=1)。
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_masinh_nz");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([], 0);
        vm.label("_masinh_nz");
        vm.fmovToFloat(0, VReg.A0); vm.fmul(2, 0, 0); K(0x3ff0000000000000n, 1); vm.fadd(2, 2, 1); vm.fsqrt(2, 2);
        vm.fadd(0, 0, 2); vm.fmovToInt(VReg.A0, 0); vm.call("_math_log");
        vm.epilogue([], 0);
    }

    // _math_acosh(A0=x) = log(x + sqrt(x²-1)), x≥1
    generateAcosh() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_acosh");
        vm.prologue(0, []);
        vm.fmovToFloat(0, VReg.A0); vm.fmul(2, 0, 0); K(0x3ff0000000000000n, 1); vm.fsub(2, 2, 1); vm.fsqrt(2, 2);
        vm.fadd(0, 0, 2); vm.fmovToInt(VReg.A0, 0); vm.call("_math_log");
        vm.epilogue([], 0);
    }

    // _math_atanh(A0=x) = 0.5·log((1+x)/(1-x))
    generateAtanh() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_atanh");
        vm.prologue(0, []);
        // ±0 保号
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_matanh_nz");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([], 0);
        vm.label("_matanh_nz");
        vm.fmovToFloat(0, VReg.A0); K(0x3ff0000000000000n, 1);
        vm.fadd(2, 1, 0); vm.fsub(3, 1, 0); vm.fdiv(2, 2, 3);   // (1+x)/(1-x)
        vm.fmovToInt(VReg.A0, 2); vm.call("_math_log");
        // NaN 归一:log 返回可打印 NaN(0x7FF0…1),后续 *0.5 会把它冲成 0x7FF8…1(int0 别名,
        // 打印成 "1")。若 log 结果是 NaN(指数全 1 且尾数非零)直接返归一 NaN,跳过 *0.5;
        // ±Inf(尾数 0,来自 atanh(±1))仍走 *0.5(Inf*0.5=Inf,atanh(1)=Inf/atanh(-1)=-Inf)。
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V2, VReg.RET, VReg.V1); // (x64 V2==A2 无活值;V0≡RET 会盖掉 log 结果)
        vm.cmp(VReg.V2, VReg.V1);
        vm.jne("_matanh_scale");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V2, VReg.RET, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_matanh_scale");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n); // NaN → 归一直接返
        vm.epilogue([], 0);
        vm.label("_matanh_scale");
        vm.fmovToFloat(0, VReg.RET); K(0x3fe0000000000000n, 1); vm.fmul(0, 0, 1); // ·0.5
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // _math_fround(A0=x) -> 舍入到最近 float32 再回 double。
    generateFround() {
        const vm = this.vm;
        vm.label("_math_fround");
        vm.fmovToFloat(0, VReg.A0);
        vm.fcvtd2s(0, 0); vm.fcvts2d(0, 0);
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // _math_f16round(A0=x bits) -> binary16 round-to-nearest-ties-even,
    // converted back to an exactly representable binary64 value.  Implemented
    // from the binary64 fields so the semantics are identical on arm64/x64
    // without relying on optional native FP16 instructions.
    generateF16Round() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4];
        vm.label("_math_f16round");
        vm.prologue(0, SAVED);
        vm.mov(VReg.S0, VReg.A0); // original bits
        vm.movImm64(VReg.V5, 0x8000000000000000n);
        vm.and(VReg.S1, VReg.S0, VReg.V5); // sign
        vm.shrImm(VReg.S2, VReg.S0, 52);
        vm.andImm(VReg.S2, VReg.S2, 0x7ff); // binary64 exponent
        vm.movImm64(VReg.V5, 0x000fffffffffffffn);
        vm.and(VReg.S3, VReg.S0, VReg.V5); // fraction

        vm.cmpImm(VReg.S2, 0x7ff);
        vm.jeq("_mf16_special");
        // Zero and every binary64 subnormal are far below half's minimum
        // subnormal (2^-24), so they round to signed zero.
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_mf16_zero");
        vm.subImm(VReg.S2, VReg.S2, 1023); // unbiased exponent e
        vm.cmpImm(VReg.S2, 15);
        vm.jgt("_mf16_inf");
        vm.movImm64(VReg.V5, 0x0010000000000000n);
        vm.or(VReg.S3, VReg.S3, VReg.V5); // 53-bit significand
        vm.cmpImm(VReg.S2, -14);
        vm.jge("_mf16_normal");
        vm.cmpImm(VReg.S2, -25);
        vm.jlt("_mf16_zero");

        // Half subnormal: n = roundTiesEven(x / 2^-24).
        // shift = 28-e maps the binary64 significand to integer n.
        vm.movImm(VReg.V6, 28);
        vm.sub(VReg.V6, VReg.V6, VReg.S2);
        vm.shr(VReg.S4, VReg.S3, VReg.V6); // q
        vm.shl(VReg.V5, VReg.S4, VReg.V6);
        vm.sub(VReg.V5, VReg.S3, VReg.V5); // remainder
        vm.subImm(VReg.V6, VReg.V6, 1);
        vm.movImm(VReg.S0, 1);
        vm.shl(VReg.S0, VReg.S0, VReg.V6); // halfway
        vm.cmp(VReg.V5, VReg.S0);
        vm.jgt("_mf16_sub_up");
        vm.jlt("_mf16_sub_rounded");
        vm.andImm(VReg.V6, VReg.S4, 1);
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_mf16_sub_rounded");
        vm.label("_mf16_sub_up");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.label("_mf16_sub_rounded");
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_mf16_zero");
        vm.cmpImm(VReg.S4, 1024);
        vm.jeq("_mf16_sub_to_normal");
        // n * 2^-24 is exactly representable in binary64.
        vm.scvtf(0, VReg.S4);
        vm.movImm64(VReg.V5, 0x3e70000000000000n); // 2^-24
        vm.fmovToFloat(1, VReg.V5);
        vm.fmul(0, 0, 1);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_mf16_sub_positive");
        vm.fneg(0, 0);
        vm.label("_mf16_sub_positive");
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue(SAVED, 0);

        vm.label("_mf16_sub_to_normal");
        vm.movImm(VReg.S2, -14);
        vm.jmp("_mf16_build_normal");

        // Half normal: retain 11 significand bits and round discarded 42 bits.
        vm.label("_mf16_normal");
        vm.shrImm(VReg.S4, VReg.S3, 42); // q (implicit bit + 10 fraction bits)
        vm.movImm64(VReg.V5, 0x000003ffffffffffn); // low 42 bits
        vm.and(VReg.V5, VReg.S3, VReg.V5);
        vm.movImm64(VReg.V6, 0x0000020000000000n); // halfway = 2^41
        vm.cmp(VReg.V5, VReg.V6);
        vm.jgt("_mf16_norm_up");
        vm.jlt("_mf16_norm_rounded");
        vm.andImm(VReg.V6, VReg.S4, 1);
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_mf16_norm_rounded");
        vm.label("_mf16_norm_up");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.label("_mf16_norm_rounded");
        vm.cmpImm(VReg.S4, 2048);
        vm.jne("_mf16_build_normal");
        vm.movImm(VReg.S4, 1024);
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.cmpImm(VReg.S2, 15);
        vm.jgt("_mf16_inf");

        vm.label("_mf16_build_normal");
        vm.subImm(VReg.S4, VReg.S4, 1024);
        vm.shlImm(VReg.S4, VReg.S4, 42);
        vm.addImm(VReg.S2, VReg.S2, 1023);
        vm.shlImm(VReg.S2, VReg.S2, 52);
        vm.or(VReg.RET, VReg.S1, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.S4);
        vm.epilogue(SAVED, 0);

        vm.label("_mf16_special");
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_mf16_nan");
        vm.label("_mf16_inf");
        vm.movImm64(VReg.V5, 0x7ff0000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V5);
        vm.epilogue(SAVED, 0);
        vm.label("_mf16_nan");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.epilogue(SAVED, 0);
        vm.label("_mf16_zero");
        vm.mov(VReg.RET, VReg.S1); // preserve -0
        vm.epilogue(SAVED, 0);
    }

    // _math_clz32(A0=x 位) -> RET=前导零数(ToUint32 后 32 位)。x 已是 canonical float:
    // 先 fcvtzs 取 int(截断),取低 32 位,循环数前导零。0 → 32。
    generateClz32() {
        const vm = this.vm;
        vm.label("_math_clz32");
        // ToUint32(NaN/±Infinity) = +0。
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.and(VReg.V2, VReg.A0, VReg.V1);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jne("_mclz_finite");
        vm.movImm(VReg.V2, 32);
        vm.scvtf(0, VReg.V2); vm.fmovToInt(VReg.RET, 0);
        vm.ret();
        vm.label("_mclz_finite");
        vm.fmovToFloat(0, VReg.A0);
        vm.fcvtzs(VReg.V0, 0);                         // 截断为 int
        vm.movImm64(VReg.V1, 0xffffffffn); vm.and(VReg.V0, VReg.V0, VReg.V1); // 低 32 位(ToUint32 近似)
        vm.movImm(VReg.V2, 0);                         // count
        vm.movImm64(VReg.V3, 0x80000000n);             // bit31 掩码
        vm.label("_mclz_loop");
        vm.cmpImm(VReg.V0, 0); vm.jeq("_mclz_done");   // 剩余为 0 → 停
        vm.and(VReg.V4, VReg.V0, VReg.V3); vm.cmpImm(VReg.V4, 0); vm.jne("_mclz_ret");
        vm.addImm(VReg.V2, VReg.V2, 1); vm.shlImm(VReg.V0, VReg.V0, 1);
        vm.movImm64(VReg.V1, 0xffffffffn); vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.jmp("_mclz_loop");
        vm.label("_mclz_done"); vm.movImm(VReg.V2, 32);
        vm.label("_mclz_ret");
        vm.scvtf(0, VReg.V2); vm.fmovToInt(VReg.RET, 0); // 返回 canonical float
        vm.ret();
    }

    // 以下 5 个从既有 _math_exp/_math_log 廉价导出(A0=x 位 → RET=位)。
    // 皆 prologue 建帧(内部 call 会毁 LR/V/A);近 0 处精度不如专用算法但满足常用域。

    // Math.expm1(x) = exp(x) - 1(expm1(0)=0 精确:exp(0)=1→0)
    generateExpm1() {
        const vm = this.vm;
        vm.label("_math_expm1");
        vm.prologue(0, []);
        // -Inf → -1;+Inf → +Inf;NaN → NaN(exp(-Inf) 现返 +0 → 0-1=-1 亦对,但 +Inf 须特判)
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mexpm1_finite");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mexpm1_nan");
        vm.shrImm(VReg.V0, VReg.A0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mexpm1_ninf");
        vm.movImm64(VReg.RET, 0x7FF0000000000000n); // +Inf
        vm.epilogue([], 0);
        vm.label("_mexpm1_ninf");
        vm.movImm64(VReg.RET, 0xbff0000000000000n); // -1
        vm.epilogue([], 0);
        vm.label("_mexpm1_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([], 0);
        vm.label("_mexpm1_finite");
        // ±0 保号:exp(0)-1 得 +0,丢 -0
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mexpm1_nz");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([], 0);
        vm.label("_mexpm1_nz");
        vm.call("_math_exp");                 // A0=x → RET=exp(x) 位
        vm.fmovToFloat(0, VReg.RET);
        vm.movImm64(VReg.V1, 0x3ff0000000000000n); // 1.0
        vm.fmovToFloat(1, VReg.V1);
        vm.fsub(0, 0, 1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // Math.log1p(x) = log(1 + x)
    generateLog1p() {
        const vm = this.vm;
        vm.label("_math_log1p");
        vm.prologue(0, []);
        // log1p(±0)=±0；1+x 会把 -0 消成 +1，须提前返回。
        vm.shlImm(VReg.V2, VReg.A0, 1);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_mlog1p_nonzero");
        vm.mov(VReg.RET, VReg.A0);
        vm.epilogue([], 0);
        vm.label("_mlog1p_nonzero");
        vm.fmovToFloat(0, VReg.A0);
        vm.movImm64(VReg.V1, 0x3ff0000000000000n); // 1.0
        vm.fmovToFloat(1, VReg.V1);
        vm.fadd(0, 0, 1);                     // 1+x
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_math_log");                 // RET=log(1+x)
        vm.epilogue([], 0);
    }

    // Math.sinh(x) = (exp(x) - exp(-x)) / 2
    // ±Inf → ±Inf;NaN → NaN;±0 保号(经公式在 ±0 亦保号,但 Inf 须特判防 exp 污染)。
    generateSinh() {
        const vm = this.vm;
        vm.label("_math_sinh");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);             // S0 = x 位
        // ±0 保号;±Inf/NaN 原样(exp 路径会污染)
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_msinh_nz");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_msinh_nz");
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_msinh_finite");
        vm.mov(VReg.RET, VReg.S0);            // ±Inf/NaN 原样(NaN 透传;±Inf 保号)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_msinh_finite");
        vm.call("_math_exp");                 // RET = exp(x)
        vm.mov(VReg.S1, VReg.RET);            // S1 = exp(x) 位
        vm.fmovToFloat(3, VReg.S0);           // d3 = x
        vm.fneg(3, 3);                        // d3 = -x
        vm.fmovToInt(VReg.A0, 3);
        vm.call("_math_exp");                 // RET = exp(-x)
        vm.fmovToFloat(0, VReg.S1);           // exp(x)
        vm.fmovToFloat(1, VReg.RET);          // exp(-x)
        vm.fsub(0, 0, 1);                     // exp(x)-exp(-x)
        vm.movImm64(VReg.V1, 0x3fe0000000000000n); // 0.5
        vm.fmovToFloat(2, VReg.V1);
        vm.fmul(0, 0, 2);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Math.cosh(x) = (exp(x) + exp(-x)) / 2
    // ±Inf → +Inf;NaN → NaN。
    generateCosh() {
        const vm = this.vm;
        vm.label("_math_cosh");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mcosh_finite");
        // Inf → +Inf;NaN → 归一 NaN
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mcosh_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000000n); // +Inf
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mcosh_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mcosh_finite");
        vm.call("_math_exp");
        vm.mov(VReg.S1, VReg.RET);
        vm.fmovToFloat(3, VReg.S0);
        vm.fneg(3, 3);
        vm.fmovToInt(VReg.A0, 3);
        vm.call("_math_exp");
        vm.fmovToFloat(0, VReg.S1);
        vm.fmovToFloat(1, VReg.RET);
        vm.fadd(0, 0, 1);
        vm.movImm64(VReg.V1, 0x3fe0000000000000n); // 0.5
        vm.fmovToFloat(2, VReg.V1);
        vm.fmul(0, 0, 2);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Math.tanh(x) = (exp(x) - exp(-x)) / (exp(x) + exp(-x))
    generateTanh() {
        const vm = this.vm; const K = (b, r) => this._K(b, r);
        vm.label("_math_tanh");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        // ±0 保号
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mtanh_nz");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mtanh_nz");
        // 指数全 1:NaN → NaN;±Inf → ±1。|x|≥20 亦饱和(exp 溢出路径得 NaN)。
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mtanh_check20");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mtanh_nan");
        vm.jmp("_mtanh_sat");
        vm.label("_mtanh_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mtanh_check20");
        vm.fmovToFloat(0, VReg.S0);
        vm.fabs(0, 0);
        K(0x4034000000000000n, 1); // 20.0
        vm.fcmp(0, 1);
        vm.jflt("_mtanh_body");
        vm.label("_mtanh_sat");
        vm.shrImm(VReg.V0, VReg.S0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mtanh_neg1");
        vm.movImm64(VReg.RET, 0x3ff0000000000000n); // +1
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mtanh_neg1");
        vm.movImm64(VReg.RET, 0xbff0000000000000n); // -1
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mtanh_body");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_math_exp");
        vm.mov(VReg.S1, VReg.RET);            // exp(x)
        vm.fmovToFloat(3, VReg.S0);
        vm.fneg(3, 3);
        vm.fmovToInt(VReg.A0, 3);
        vm.call("_math_exp");                 // RET = exp(-x)
        vm.fmovToFloat(0, VReg.S1);           // exp(x)
        vm.fmovToFloat(1, VReg.RET);          // exp(-x)
        vm.fsub(2, 0, 1);                     // d2 = num = exp(x)-exp(-x)
        vm.fadd(3, 0, 1);                     // d3 = den = exp(x)+exp(-x)
        vm.fdiv(0, 2, 3);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Math.sqrt(x) - 平方根(fsqrt 硬件指令;负数 → NaN,与 IEEE 一致)
    // A0 = x(f64 位),RET = 位。
    generateSqrt() {
        const vm = this.vm;
        vm.label("_math_sqrt");
        vm.fmovToFloat(0, VReg.A0);
        vm.fsqrt(0, 0);
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
    }

    // Math.log(x) - 自然对数。无 libm(零依赖),纯 asm:
    //   x = m·2^e(m∈[1,2)),m>√2 时折半使 |s| 小 → log(x)=e·ln2 + log(m)。
    //   log(m)=2·atanh(s),s=(m-1)/(m+1),用 11 项奇次幂级数(Horner)。
    //   ln2 拆 hi/lo 两部补偿舍入 → Math.log(Math.E)==1、log(10)/log(100) 逐位符。
    //   非完美整数处 ≤1 ulp 偏差(已记录);x≤0 未特判(gate 仅正参)。
    generateLog() {
        const vm = this.vm;
        vm.label("_math_log");
        // 定义域守卫(此前 x≤0 未特判 → 负数/0 出垃圾;acosh/atanh/log1p/log10 均委托本函数):
        //   ±0 → -Infinity;负有限 → NaN;+Inf → +Inf;-Inf/NaN → NaN。正规正数落原算法。
        vm.shlImm(VReg.V0, VReg.A0, 1);              // 去符号位
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mlog_dom_nz");
        vm.movImm64(VReg.RET, 0xFFF0000000000000n); // -Infinity
        vm.ret();
        vm.label("_mlog_dom_nz");
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);  // 指数位掩码
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mlog_dom_finite");
        // 指数全 1:Inf 或 NaN。尾数非零 → NaN
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mlog_ret_nan");                    // NaN 输入 → NaN
        vm.shrImm(VReg.V0, VReg.A0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mlog_ret_nan");                    // -Inf → NaN
        vm.mov(VReg.RET, VReg.A0);                  // +Inf → +Inf
        vm.ret();
        vm.label("_mlog_dom_finite");
        vm.shrImm(VReg.V0, VReg.A0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_mlog_positive");                   // 正有限 → 原算法
        vm.label("_mlog_ret_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n); // NaN(可打印,high16=0x7FF0 避开 int0 别名)
        vm.ret();
        vm.label("_mlog_positive");
        // A0 = x 的 f64 位
        vm.mov(VReg.V3, VReg.A0);                    // V3 = x 位
        // e = ((bits>>52)&0x7FF) - 1023
        vm.shrImm(VReg.V0, VReg.A0, 52);
        vm.andImm(VReg.V0, VReg.V0, 0x7FF);
        vm.subImm(VReg.V0, VReg.V0, 1023);           // V0 = e(可负)
        // m 位 = (bits & 0x800F…) | 0x3FF0…  → m∈[1,2)
        vm.movImm64(VReg.V1, 0x800FFFFFFFFFFFFFn);
        vm.and(VReg.V2, VReg.V3, VReg.V1);
        vm.movImm64(VReg.V1, 0x3FF0000000000000n);
        vm.or(VReg.V2, VReg.V2, VReg.V1);
        vm.fmovToFloat(0, VReg.V2);                  // d0 = m
        // m > √2 → m*=0.5, e++
        vm.movImm64(VReg.V1, 0x3ff6a09e667f3bcdn);   // √2
        vm.fmovToFloat(1, VReg.V1);
        vm.fcmp(0, 1);
        vm.jfle("_mlog_nored");
        vm.movImm64(VReg.V1, 0x3fe0000000000000n);   // 0.5
        vm.fmovToFloat(1, VReg.V1);
        vm.fmul(0, 0, 1);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.label("_mlog_nored");
        // s = (m-1)/(m+1)
        vm.movImm64(VReg.V1, 0x3ff0000000000000n);   // 1.0
        vm.fmovToFloat(1, VReg.V1);
        vm.fsub(2, 0, 1);                            // d2 = m-1
        vm.fadd(3, 0, 1);                            // d3 = m+1
        vm.fdiv(2, 2, 3);                            // d2 = s
        vm.fmul(3, 2, 2);                            // d3 = s2
        // Horner: sum = Σ s2^k · 1/(2k+1),系数 k=10→0
        const coeffs = [
            0x3fa8618618618618n, // 1/21
            0x3faaf286bca1af28n, // 1/19
            0x3fae1e1e1e1e1e1en, // 1/17
            0x3fb1111111111111n, // 1/15
            0x3fb3b13b13b13b14n, // 1/13
            0x3fb745d1745d1746n, // 1/11
            0x3fbc71c71c71c71cn, // 1/9
            0x3fc2492492492492n, // 1/7
            0x3fc999999999999an, // 1/5
            0x3fd5555555555555n, // 1/3
            0x3ff0000000000000n, // 1/1
        ];
        vm.movImm64(VReg.V1, coeffs[0]);
        vm.fmovToFloat(4, VReg.V1);                  // d4 = sum = 1/21
        for (let i = 1; i < coeffs.length; i++) {
            vm.fmul(4, 4, 3);                        // sum *= s2
            vm.movImm64(VReg.V1, coeffs[i]);
            vm.fmovToFloat(5, VReg.V1);
            vm.fadd(4, 4, 5);                        // sum += coeff
        }
        vm.fmul(4, 4, 2);                            // sum *= s
        vm.movImm64(VReg.V1, 0x4000000000000000n);   // 2.0
        vm.fmovToFloat(5, VReg.V1);
        vm.fmul(4, 4, 5);                            // d4 = 2·sum = log(m)
        // result = e·LN2HI + (log(m) + e·LN2LO)
        vm.scvtf(1, VReg.V0);                        // d1 = (double)e
        vm.movImm64(VReg.V1, 0x3fe62e42fee00000n);   // LN2HI
        vm.fmovToFloat(2, VReg.V1);
        vm.movImm64(VReg.V1, 0x3dea39ef35793c76n);   // LN2LO
        vm.fmovToFloat(3, VReg.V1);
        vm.fmul(0, 1, 2);                            // d0 = e·LN2HI
        vm.fmul(1, 1, 3);                            // d1 = e·LN2LO
        vm.fadd(4, 4, 1);                            // d4 = log(m) + e·LN2LO
        vm.fadd(4, 4, 0);                            // d4 += e·LN2HI
        vm.fmovToInt(VReg.RET, 4);
        vm.ret();
    }

    // Math.log2(x) - 以 2 为底。结构同 _math_log,唯末尾组合改为 e + log(m)/ln2:
    //   x = m·2^e(m∈[1,2)),log2(x) = e + log2(m)。x 为 2 的整数幂时 m=1 → log(m)=0
    //   → 结果 == e(精确整数,log2(8)==3、log2(1024)==10 逐位符,不落小数打印路径)。
    //   非幂处 log(m)/ln2 引入 ≤1 ulp 偏差(已记录,同 _math_log)。x≤0 未特判(gate 仅正参)。
    generateLog2() {
        const vm = this.vm;
        vm.label("_math_log2");
        // 定义域守卫(同 _math_log):±0 → -Infinity;负有限 → NaN;+Inf → +Inf;-Inf/NaN → NaN。
        vm.shlImm(VReg.V0, VReg.A0, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mlog2_dom_nz");
        vm.movImm64(VReg.RET, 0xFFF0000000000000n); // -Infinity
        vm.ret();
        vm.label("_mlog2_dom_nz");
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mlog2_dom_finite");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mlog2_ret_nan");
        vm.shrImm(VReg.V0, VReg.A0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mlog2_ret_nan");
        vm.mov(VReg.RET, VReg.A0);                  // +Inf → +Inf
        vm.ret();
        vm.label("_mlog2_dom_finite");
        vm.shrImm(VReg.V0, VReg.A0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_mlog2_positive");
        vm.label("_mlog2_ret_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n); // NaN(可打印,high16=0x7FF0 避开 int0 别名)
        vm.ret();
        vm.label("_mlog2_positive");
        vm.mov(VReg.V3, VReg.A0);                    // V3 = x 位
        vm.shrImm(VReg.V0, VReg.A0, 52);
        vm.andImm(VReg.V0, VReg.V0, 0x7FF);
        vm.subImm(VReg.V0, VReg.V0, 1023);           // V0 = e
        vm.movImm64(VReg.V1, 0x800FFFFFFFFFFFFFn);
        vm.and(VReg.V2, VReg.V3, VReg.V1);
        vm.movImm64(VReg.V1, 0x3FF0000000000000n);
        vm.or(VReg.V2, VReg.V2, VReg.V1);
        vm.fmovToFloat(0, VReg.V2);                  // d0 = m
        vm.movImm64(VReg.V1, 0x3ff6a09e667f3bcdn);   // √2
        vm.fmovToFloat(1, VReg.V1);
        vm.fcmp(0, 1);
        vm.jfle("_mlog2_nored");
        vm.movImm64(VReg.V1, 0x3fe0000000000000n);   // 0.5
        vm.fmovToFloat(1, VReg.V1);
        vm.fmul(0, 0, 1);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.label("_mlog2_nored");
        vm.movImm64(VReg.V1, 0x3ff0000000000000n);   // 1.0
        vm.fmovToFloat(1, VReg.V1);
        vm.fsub(2, 0, 1);                            // d2 = m-1
        vm.fadd(3, 0, 1);                            // d3 = m+1
        vm.fdiv(2, 2, 3);                            // d2 = s
        vm.fmul(3, 2, 2);                            // d3 = s2
        const coeffs = [
            0x3fa8618618618618n, 0x3faaf286bca1af28n, 0x3fae1e1e1e1e1e1en,
            0x3fb1111111111111n, 0x3fb3b13b13b13b14n, 0x3fb745d1745d1746n,
            0x3fbc71c71c71c71cn, 0x3fc2492492492492n, 0x3fc999999999999an,
            0x3fd5555555555555n, 0x3ff0000000000000n,
        ];
        vm.movImm64(VReg.V1, coeffs[0]);
        vm.fmovToFloat(4, VReg.V1);
        for (let i = 1; i < coeffs.length; i++) {
            vm.fmul(4, 4, 3);
            vm.movImm64(VReg.V1, coeffs[i]);
            vm.fmovToFloat(5, VReg.V1);
            vm.fadd(4, 4, 5);
        }
        vm.fmul(4, 4, 2);                            // sum *= s
        vm.movImm64(VReg.V1, 0x4000000000000000n);   // 2.0
        vm.fmovToFloat(5, VReg.V1);
        vm.fmul(4, 4, 5);                            // d4 = log(m)
        // log2(x) = e + log(m)·(1/ln2)
        vm.scvtf(1, VReg.V0);                        // d1 = (double)e
        vm.movImm64(VReg.V1, 0x3ff71547652b82fen);   // 1/ln2 = LOG2E
        vm.fmovToFloat(2, VReg.V1);
        vm.fmul(4, 4, 2);                            // d4 = log2(m)
        vm.fadd(4, 4, 1);                            // d4 = e + log2(m)
        vm.fmovToInt(VReg.RET, 4);
        vm.ret();
    }

    // Math.log10(x) - 以 10 为底。委托 _math_log 后除以 ln10;再对 10 的整数幂做吸附:
    //   n=round(结果),若 0≤n≤22 且 10^n(逐次乘累加)== x 逐位相等 → 返回精确整数 n
    //   (log10(1000)==3、log10(100)==2 逐位符,node/V8 同款特判)。非幂处保留 ≤1-2 ulp
    //   近似值(已记录)。x≤0 未特判(gate 仅正参)。
    generateLog10() {
        const vm = this.vm;
        vm.label("_math_log10");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);                     // S0 = x 位(吸附比较用)
        vm.call("_math_log");                         // RET = ln(x) 位
        // 定义域非有限:_math_log 对 x==0 返 -Inf、x<0/NaN 返可打印 NaN。NaN 若走后续 *1/ln10
        // 会冲成 int0 别名(打印错),故提前拦截:NaN → 归一直接返;±Inf → 仅乘不吸附(保号)。
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V2, VReg.RET, VReg.V1); // (x64 V2==A2 无活值;V0≡RET 会盖掉 log 结果)
        vm.cmp(VReg.V2, VReg.V1);
        vm.jne("_mlog10_finite");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V2, VReg.RET, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_mlog10_inf");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);   // NaN → 归一
        vm.epilogue([VReg.S0], 0);
        vm.label("_mlog10_inf");
        vm.fmovToFloat(0, VReg.RET);                  // ±Inf·(1/ln10)=±Inf(保号打印正确)
        vm.movImm64(VReg.V1, 0x3fdbcb7b1526e50dn);
        vm.fmovToFloat(1, VReg.V1);
        vm.fmul(0, 0, 1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_mlog10_finite");
        vm.fmovToFloat(0, VReg.RET);                  // d0 = ln(x)
        vm.movImm64(VReg.V1, 0x3fdbcb7b1526e50dn);    // 1/ln10
        vm.fmovToFloat(1, VReg.V1);
        vm.fmul(0, 0, 1);                             // d0 = log10 近似
        // n = floor(d0 + 0.5)
        vm.movImm64(VReg.V1, 0x3fe0000000000000n);    // 0.5
        vm.fmovToFloat(1, VReg.V1);
        vm.fadd(2, 0, 1);
        vm.ffloor(2, 2);
        vm.fcvtzs(VReg.V2, 2);                        // V2 = n(int)
        vm.cmpImm(VReg.V2, 0);
        vm.jlt("_mlog10_done");                       // n<0 不吸附
        vm.cmpImm(VReg.V2, 22);
        vm.jgt("_mlog10_done");                       // n>22(10^n 不再精确)不吸附
        // d3 = 10^n(逐次乘),V3 = 计数器
        vm.movImm64(VReg.V1, 0x3ff0000000000000n);    // 1.0
        vm.fmovToFloat(3, VReg.V1);
        vm.movImm64(VReg.V1, 0x4024000000000000n);    // 10.0
        vm.fmovToFloat(4, VReg.V1);
        vm.mov(VReg.V3, VReg.V2);
        vm.label("_mlog10_ploop");
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_mlog10_pdone");
        vm.fmul(3, 3, 4);
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.jmp("_mlog10_ploop");
        vm.label("_mlog10_pdone");
        vm.fmovToFloat(5, VReg.S0);                   // d5 = x
        vm.fcmp(3, 5);
        vm.jne("_mlog10_done");                       // 10^n != x → 保留近似
        vm.scvtf(0, VReg.V2);                         // 精确幂 → d0 = (double)n
        vm.label("_mlog10_done");
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // Math.exp(x) - e^x。两段策略:
    //   |x|≤1:直接 19 项泰勒(Horner,1/0!…1/18!)——无归约舍入,exp(0)==1、exp(1)==e
    //          逐位符 node(归约+重构式对 exp(1) 恒偏 +1 ulp,故小区间走直接和);
    //   |x|>1:fdlibm __ieee754_exp 风格范围归约 x=k·ln2+r(ln2 拆 hi/lo)、有理式
    //          c=r-r²·(P1+r²(P2+r²(P3+r²(P4+r²·P5))))、y=1-((lo-(r·c)/(2-c))-hi)≈exp(r)、
    //          乘 2^k((k+1023)<<52 拼指数域),≤1 ulp(已记录)。d7 作常量暂存。
    //   溢出/±Inf/NaN:指数全 1 → +Inf→+Inf、-Inf→+0、NaN→NaN。
    generateExp() {
        const vm = this.vm;
        const K = (bits, r) => { vm.movImm64(VReg.V1, bits); vm.fmovToFloat(r, VReg.V1); };
        vm.label("_math_exp");
        // Inf/NaN 特判(大 |x| 归约会污染)
        vm.movImm64(VReg.V1, 0x7FF0000000000000n);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_mexp_finite");
        vm.movImm64(VReg.V1, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mexp_nan");
        vm.shrImm(VReg.V0, VReg.A0, 63);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_mexp_ninf");
        vm.movImm64(VReg.RET, 0x7FF0000000000000n); // +Inf
        vm.ret();
        vm.label("_mexp_ninf");
        vm.movImm(VReg.RET, 0); // +0
        vm.ret();
        vm.label("_mexp_nan");
        vm.movImm64(VReg.RET, 0x7FF0000000000001n);
        vm.ret();
        vm.label("_mexp_finite");
        vm.fmovToFloat(0, VReg.A0);                   // d0 = x
        // |x| ≤ 1 → 直接泰勒
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.A0, VReg.V1);
        vm.fmovToFloat(3, VReg.V2);                   // d3 = |x|
        K(0x3ff0000000000000n, 7);                    // 1.0
        vm.fcmp(3, 7);
        vm.jfle("_mexp_direct");
        // ===== |x| > 1:范围归约 =====
        // k = floor(x·log2e + 0.5)
        K(0x3ff71547652b82fen, 7);                    // log2e
        vm.fmul(2, 0, 7);                             // d2 = x·log2e
        K(0x3fe0000000000000n, 7);                    // 0.5
        vm.fadd(2, 2, 7);
        vm.ffloor(2, 2);                              // d2 = k(double)
        vm.fcvtzs(VReg.V2, 2);                        // V2 = k(int)
        // hi = x - k·ln2hi ; lo = k·ln2lo ; r = hi - lo
        K(0x3fe62e42fee00000n, 7);                    // ln2hi
        vm.fmul(3, 2, 7);
        vm.fsub(3, 0, 3);                             // d3 = hi
        K(0x3dea39ef35793c76n, 7);                    // ln2lo
        vm.fmul(4, 2, 7);                             // d4 = lo
        vm.fsub(1, 3, 4);                             // d1 = r = hi - lo
        vm.fmul(2, 1, 1);                             // d2 = t = r·r
        // p = P1 + t·(P2 + t·(P3 + t·(P4 + t·P5)))   (Horner in d5)
        K(0x3e66376972bea4d0n, 5);                    // P5
        K(0xbebbbd41c5d26bf1n, 7); vm.fmul(5, 5, 2); vm.fadd(5, 5, 7); // *t + P4
        K(0x3f11566aaf25de2cn, 7); vm.fmul(5, 5, 2); vm.fadd(5, 5, 7); // *t + P3
        K(0xbf66c16c16bebd93n, 7); vm.fmul(5, 5, 2); vm.fadd(5, 5, 7); // *t + P2
        K(0x3fc555555555553en, 7); vm.fmul(5, 5, 2); vm.fadd(5, 5, 7); // *t + P1
        vm.fmul(6, 2, 5);                             // d6 = t·p
        vm.fsub(5, 1, 6);                             // d5 = c = r - t·p
        vm.fmul(6, 1, 5);                             // d6 = r·c
        K(0x4000000000000000n, 0);                    // d0 = 2.0
        vm.fsub(0, 0, 5);                             // d0 = 2 - c
        vm.fdiv(6, 6, 0);                             // d6 = (r·c)/(2-c)
        vm.fsub(4, 4, 6);                             // d4 = lo - (r·c)/(2-c)
        vm.fsub(4, 4, 3);                             // d4 = (…) - hi
        K(0x3ff0000000000000n, 0);                    // d0 = 1.0
        vm.fsub(0, 0, 4);                             // d0 = y = 1 - (…) ≈ exp(r)
        // 乘 2^k:拼 (k+1023)<<52 的位模式
        vm.addImm(VReg.V2, VReg.V2, 1023);
        vm.shlImm(VReg.V3, VReg.V2, 52);
        vm.fmovToFloat(6, VReg.V3);                   // d6 = 2^k
        vm.fmul(0, 0, 6);                             // d0 = exp(r)·2^k
        vm.fmovToInt(VReg.RET, 0);
        vm.ret();
        // ===== |x| ≤ 1:直接泰勒 Σ x^n/n!(n=18→0 Horner)=====
        vm.label("_mexp_direct");
        const tcoef = [
            0x3ca6827863b97d97n, // 1/18!
            0x3ce952c77030ad4an, // 1/17!
            0x3d2ae7f3e733b81fn, // 1/16!
            0x3d6ae7f3e733b81fn, // 1/15!
            0x3da93974a8c07c9dn, // 1/14!
            0x3de6124613a86d09n, // 1/13!
            0x3e21eed8eff8d898n, // 1/12!
            0x3e5ae64567f544e4n, // 1/11!
            0x3e927e4fb7789f5cn, // 1/10!
            0x3ec71de3a556c734n, // 1/9!
            0x3efa01a01a01a01an, // 1/8!
            0x3f2a01a01a01a01an, // 1/7!
            0x3f56c16c16c16c17n, // 1/6!
            0x3f81111111111111n, // 1/5!
            0x3fa5555555555555n, // 1/4!
            0x3fc5555555555555n, // 1/3!
            0x3fe0000000000000n, // 1/2!
            0x3ff0000000000000n, // 1/1!
            0x3ff0000000000000n, // 1/0!
        ];
        K(tcoef[0], 4);                               // d4 = acc
        for (let i = 1; i < tcoef.length; i++) {
            vm.fmul(4, 4, 0);                         // acc *= x
            K(tcoef[i], 5);
            vm.fadd(4, 4, 5);                         // acc += 1/n!
        }
        vm.fmovToInt(VReg.RET, 4);
        vm.ret();
    }

    // Math.cbrt(x) - 立方根。位技巧初值(exp/3)+ 6 次牛顿迭代 y=(2y+a/y²)/3。
    //   完美立方(27→3、-8→-2)精确;一般 ≤1 ulp(已记录)。±0 保号。
    generateCbrt() {
        const vm = this.vm;
        vm.label("_math_cbrt");
        // A0 = x 的 f64 位
        vm.mov(VReg.V3, VReg.A0);                    // V3 = x 位(保号用)
        vm.movImm64(VReg.V1, 0x7FFFFFFFFFFFFFFFn);
        vm.and(VReg.V2, VReg.A0, VReg.V1);           // V2 = |x| 位
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_mcbrt_zero");                       // ±0 → 原样返回
        // ±Infinity 原样；NaN 透传给调用点统一归一。位技巧/牛顿迭代会把 Inf 污成 NaN。
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.and(VReg.V4, VReg.V2, VReg.V1);
        vm.cmp(VReg.V4, VReg.V1);
        vm.jne("_mcbrt_finite");
        vm.mov(VReg.RET, VReg.V3);
        vm.ret();
        vm.label("_mcbrt_finite");
        vm.fmovToFloat(0, VReg.V2);                  // d0 = a = |x|
        // 初值:i = a_bits/3 + 0x2A9F76253119D200
        vm.movImm(VReg.V1, 3);
        vm.div(VReg.V4, VReg.V2, VReg.V1);           // V4 = a_bits/3
        vm.movImm64(VReg.V1, 0x2A9F76253119D200n);
        vm.add(VReg.V4, VReg.V4, VReg.V1);
        vm.fmovToFloat(1, VReg.V4);                  // d1 = y
        vm.movImm64(VReg.V1, 0x4000000000000000n);   // 2.0
        vm.fmovToFloat(2, VReg.V1);
        vm.movImm64(VReg.V1, 0x4008000000000000n);   // 3.0
        vm.fmovToFloat(3, VReg.V1);
        for (let k = 0; k < 6; k++) {
            vm.fmul(4, 1, 1);                        // d4 = y²
            vm.fdiv(5, 0, 4);                        // d5 = a/y²
            vm.fmul(6, 1, 2);                        // d6 = 2y
            vm.fadd(6, 6, 5);                        // d6 = 2y + a/y²
            vm.fdiv(1, 6, 3);                        // y = (2y + a/y²)/3
        }
        // x64 别名死表:RET==V0==RAX。符号位暂存必须避开 V0,否则会覆盖 RET
        // 里刚落的结果(fmovToInt 后紧接 shrImm(V0,...) → 正数得 0 的 x64 根因)。
        vm.shrImm(VReg.V5, VReg.V3, 63);             // x 符号位(V5=R10,不撞 RET)
        vm.fmovToInt(VReg.RET, 1);                   // RET = |cbrt| 位(正)
        vm.cmpImm(VReg.V5, 1);
        vm.jne("_mcbrt_done");
        vm.movImm64(VReg.V1, 0x8000000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);          // x<0 → 结果取负
        vm.jmp("_mcbrt_done");
        vm.label("_mcbrt_zero");
        vm.mov(VReg.RET, VReg.V3);
        vm.label("_mcbrt_done");
        vm.ret();
    }

    // Math.floor(x) - 返回小于或等于 x 的最大整数
    generateFloor() {
        const vm = this.vm;

        vm.label("_math_floor");
        // A0 = x (IEEE 754 位模式在 X0 中)
        // 需要先转换成浮点值
        vm.fmovToFloat(VReg.V0, VReg.A0);  // V0 = (double)A0
        vm.ffloor(VReg.V0, VReg.V0);  // V0 = floor(V0)
        vm.fmovToInt(VReg.RET, VReg.V0);  // RET = V0 (as integer bits)
        vm.ret();

        // Math.trunc(x) - 向零取整（frintz）。编译器自身大量用 Math.trunc（下标/switch
        // /数组构造），缺此 case 会被当泛型 Math 方法调用而崩，是 gen1 编 arr[literal] 崩根因。
        vm.label("_math_trunc");
        vm.fmovToFloat(VReg.V0, VReg.A0);
        vm.ftrunc(VReg.V0, VReg.V0);
        vm.fmovToInt(VReg.RET, VReg.V0);
        vm.ret();
    }

    // Math.ceil(x) - 返回大于或等于 x 的最小整数
    generateCeil() {
        const vm = this.vm;

        vm.label("_math_ceil");
        // A0 = x (IEEE 754 位模式在 X0 中)
        vm.fmovToFloat(VReg.V0, VReg.A0);  // V0 = (double)A0
        vm.fceil(VReg.V0, VReg.V0);  // V0 = ceil(V0)
        vm.fmovToInt(VReg.RET, VReg.V0);  // RET = V0 (as integer bits)
        vm.ret();
    }

    // Math.round(x) - 返回四舍五入后的整数
    generateRound() {
        const vm = this.vm;

        vm.label("_math_round");
        // JS Math.round = floor(x + 0.5)(中间值向 +∞ 舍入),而非 frinta 的
        // "远离零"(round-half-away)——二者仅在负半整数分歧:
        //   Math.round(-2.5)= -2(node)  vs  frinta = -3。
        // 特例:x∈[-0.5, -0] 舍入到 0 时须保留负号 → 返回 -0.0(node 语义)。
        // 注:编译器自身仅对非负值调用 Math.round(尾数计算),正值下 floor(x+0.5)
        //     与 frinta 逐值相同 → 自举 codegen 不变。
        // 浮点寄存器用数字编号(0/1/2),与 generatePow 一致;VReg.Vx 作 FP 参数会
        // 塌成 d0(字符串→NaN→0),不可用于需多个 FP 寄存器的场景。
        // 先保存 x 位:arm64 上 RET≡A0≡X0(返回值/首参同寄存器),下面 fmovToInt
        // 写 RET 会覆盖 A0,故末尾符号判定须读保存副本。
        vm.mov(VReg.V3, VReg.A0);                  // V3 = x 位(保号用)
        // |x|<0.5 → 带 x 符号的 0。直接算 x+0.5 会把最大的小于 0.5 的
        // representable 数舍入成 1.0，进而错误返回 1。
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.V3, VReg.V1);
        vm.movImm64(VReg.V1, 0x3fe0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jge("_math_round_ge_half");
        vm.movImm64(VReg.V1, 0x8000000000000000n);
        vm.and(VReg.RET, VReg.V3, VReg.V1);
        vm.ret();
        vm.label("_math_round_ge_half");
        // |x|>=2^52 已无小数，结果就是 x；加 0.5 可能把奇整数改成相邻偶数。
        vm.movImm64(VReg.V1, 0x4330000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_math_round_body");
        vm.mov(VReg.RET, VReg.V3);
        vm.ret();
        vm.label("_math_round_body");
        vm.fmovToFloat(0, VReg.A0);                // d0 = x
        vm.movImm64(VReg.V1, 0x3FE0000000000000n); // GP V1 = 0.5 的位模式
        vm.fmovToFloat(1, VReg.V1);                // d1 = 0.5
        vm.fadd(2, 0, 1);                          // d2 = x + 0.5
        vm.ffloor(2, 2);                           // d2 = floor(x + 0.5)
        vm.fmovToInt(VReg.RET, 2);                 // RET = 结果位模式
        // 若结果是 +0.0(位全零)且 x 为负 → 返回 -0.0
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_math_round_done");
        vm.shrImm(VReg.V0, VReg.V3, 63);           // x 的符号位(读保存副本)
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_math_round_done");
        vm.movImm64(VReg.RET, 0x8000000000000000n); // -0.0
        vm.label("_math_round_done");
        vm.ret();
    }

    // Math.abs(x) - 返回绝对值
    generateAbs() {
        const vm = this.vm;

        vm.label("_math_abs");
        // A0 = x (IEEE 754 位模式在 X0 中)
        vm.fmovToFloat(VReg.V0, VReg.A0);  // V0 = (double)A0
        vm.fabs(VReg.V0, VReg.V0);  // V0 = abs(V0)
        vm.fmovToInt(VReg.RET, VReg.V0);  // RET = V0 (as integer bits)
        vm.ret();
    }

    // Math.pow(base, exp) - 幂运算
    generatePow() {
        const vm = this.vm;

        vm.label("_math_pow");
        // A0 = base (float64 bits), A1 = exponent (float64 bits) -> RET = 位
        // [#33] 纯 asm 快速幂(原 call 外部 libc pow 从未链接,运行期跳垃圾挂死)。
        // 整数指数(含负)走平方-乘快路(精确)。[#64] 非整数指数:
        //   exp==0.5 → _math_sqrt(x)(完全平方精确;sqrt(负)=NaN → pow(-8,0.5)=NaN);
        //   exp==1/3 → _math_cbrt(x)(完全立方精确);
        //   否则 base>0 → exp(exp·log(base));base<0 → NaN;base==0 → +0 / +Inf(按 exp 符号)。
        // base/exp 先存 S0/S1:后续 call _math_log/_exp 会毁 V/A 寄存器(x64 上 A1=RSI=V7、
        // A2/A3=V2/V1 别名),callee-saved S0/S1 是跨调用唯一安全落点。
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);   // S0 = base 位
        vm.mov(VReg.S1, VReg.A1);   // S1 = exp 位
        // If exponent is NaN, the result is NaN (ES Number::exponentiate step 1).
        // Must precede integer/large-int: x64 ucomisd NaN sets ZF=1 so
        // jne after ftrunc(NaN) does not take _mpow_nonint; |NaN|>=2^53
        // → _mpow_large_int; fcvtzs(NaN)=INT64_MIN treated as negative
        // even → 1/Inf leftover +0 (`-Infinity ** NaN` → 0). Integer |exp|
        // > Inf (same bit test as NaN base). Scratch V1/V2 only.
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jle("_mpow_exp_notnan");
        vm.jmp("_mpow_nan");
        vm.label("_mpow_exp_notnan");
        // NaN 底:exp==±0 → 1(规范);其余 → NaN。须先于 ±Inf 指数表,
        // 否则 |NaN|>1 被当成普通底,NaN^(-Inf) 得 +0(A4 回归)。
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jle("_mpow_base_notnan");
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S1, VReg.V1); // |exp|;V1 刚被盖成 Inf 位,须重装符号掩码
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_mpow_nan0");
        vm.jmp("_mpow_nan");
        vm.label("_mpow_nan0");
        vm.movImm64(VReg.RET, 0x3ff0000000000000n); // 1.0
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_base_notnan");
        vm.fmovToFloat(0, VReg.S0); // d0 = base
        vm.fmovToFloat(1, VReg.S1); // d1 = exp
        vm.ftrunc(2, 1);            // d2 = trunc(exp)
        vm.fcmp(1, 2);
        vm.jne("_mpow_nonint");
        // [#85] 指数为 ±Infinity 时 ftrunc 保 Infinity、fcmp 判等,误进整数路径。
        // (-1)^Inf → NaN 而非 -1。|exp|==Inf → 转非整数路径处理(±Inf^非整→+Inf/+0)。
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S1, VReg.V1); // V2 = |exp| bits
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_mpow_nonint");     // |exp| == Infinity → 非整数路径
        // |exp|>=2^53 的整数皆为偶数(IEEE 在此精度下无法表示奇数)。
        // fcvtzs 饱和成 INT64_MAX(奇)会把 (-0)^maxfinite 算成 -0。
        vm.movImm64(VReg.V1, 0x4340000000000000n); // 2^53
        vm.cmp(VReg.V2, VReg.V1);   // V2 仍是 |exp| bits
        vm.jge("_mpow_large_int");
        vm.fcvtzs(VReg.V0, 1);      // V0 = n(整数指数)
        vm.movImm(VReg.V2, 0);      // 负指数标志
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_mpow_abs_done");
        vm.movImm(VReg.V2, 1);
        vm.neg(VReg.V0, VReg.V0);
        vm.label("_mpow_abs_done");
        vm.movImm64(VReg.V1, 0x3ff0000000000000n); // 1.0
        vm.fmovToFloat(3, VReg.V1); // d3 = result = 1.0
        vm.label("_mpow_loop");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_mpow_loop_done");
        vm.andImm(VReg.V3, VReg.V0, 1);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_mpow_even");
        vm.fmul(3, 3, 0);           // result *= base
        vm.label("_mpow_even");
        vm.fmul(0, 0, 0);           // base *= base
        vm.shrImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_mpow_loop");
        vm.label("_mpow_loop_done");
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_mpow_pos");
        vm.movImm64(VReg.V1, 0x3ff0000000000000n);
        vm.fmovToFloat(0, VReg.V1);
        // x64 fdiv 二操作数下沉在 dest==b 时先 mov dest,a 毁 b(xmm0/xmm0=1)
        // —— 先把 result 挪到 d2 再除,规避 dest==b 形
        vm.fmov(2, 3);
        vm.fdiv(3, 0, 2);           // result = 1.0 / result
        vm.label("_mpow_pos");
        vm.fmovToInt(VReg.RET, 3);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // ===== 非整数指数 =====
        // JS 语义:base<0 且 exp 非整 → 恒 NaN(含 -8**(1/3));故先按 base 符号分流,
        // sqrt/cbrt/exp·log 特路仅对 base>0 生效。NaN 用打印友好位 0x7FF0…0001
        // (0x7FF8…与 NaN-boxing int0 tag 别名会误打印 "0",见 members.js #44 详注)。
        vm.label("_mpow_nonint");
        // |exp|==Inf:规范比「负底+非整→NaN」更具体。
        //   |base|<1 ∧ +∞ → +0; |base|<1 ∧ −∞ → +∞
        //   |base|>1 ∧ +∞ → +∞; |base|>1 ∧ −∞ → +0
        //   |base|==1 → NaN(含 ±1)。±0 / ±Inf 底由下方 zerobase/infbase 先接。
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_mpow_infexp");
        // base 符号/零判定用整数位测(fcmpZero 在此上下文旗标不可靠):
        //   |bits|==0 → ±0;否则 sign(bit63)==1 → 负。
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_mpow_zerobase");   // base == ±0
        // [#85] Infinity/ -Infinity base 特殊处理:
        //   +Infinity^(y>0) → +Inf, +Infinity^(y<0) → +0
        //   -Infinity^(y>0) → +Inf(奇整指走整数路径,此路必然非整→+Inf)
        //   -Infinity^(y<0) → +0
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_mpow_infbase");
        vm.shrImm(VReg.V2, VReg.S0, 63);
        vm.cmpImm(VReg.V2, 1);
        vm.jeq("_mpow_nan");        // base < 0,非整指 → NaN
        // base > 0:exp==0.5 → sqrt(完全平方精确;pow(4,0.5)==2)
        vm.movImm64(VReg.V1, 0x3fe0000000000000n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_mpow_sqrt");
        // exp == 1/3(double 0.3333333333333333)→ cbrt(完全立方精确;pow(27,1/3)==3)
        vm.movImm64(VReg.V1, 0x3fd5555555555555n);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_mpow_cbrt");
        // 一般:result = exp(exp · log(base))
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_math_log");       // RET = log(base) 位
        vm.fmovToFloat(0, VReg.RET);
        vm.fmovToFloat(1, VReg.S1); // d1 = exp
        vm.fmul(0, 0, 1);           // d0 = exp·log(base)
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_math_exp");       // RET = e^(...)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_sqrt");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_math_sqrt");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_cbrt");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_math_cbrt");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_zerobase");
        // [#85] 0**NaN → NaN。fcmp 自比较:NaN != NaN 故 jne 取真。
        vm.fcmp(1, 1);
        vm.jne("_mpow_nan");
        // 0^y(y 非整):y>0 → +0;y<0 → +Inf(按 exp 符号位判定)
        vm.shrImm(VReg.V2, VReg.S1, 63);
        vm.cmpImm(VReg.V2, 1);
        vm.jeq("_mpow_zero_neg");
        vm.movImm(VReg.RET, 0);     // +0
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_zero_neg");
        vm.movImm64(VReg.RET, 0x7ff0000000000000n); // +Inf
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_nan");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);  // 打印友好 NaN
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // [#85] Infinity base 分支(含 -Infinity,到达时 exp 必非整)。
        // +Inf^(y 非整):y>0 → +Inf; y<0 → +0。
        // -Inf^(y 非整):y>0 → +Inf; y<0 → +0(奇整指走整数路径)。
        vm.label("_mpow_infbase");
        vm.fcmp(1, 1);               // exp NaN 自比较
        vm.jne("_mpow_nan");         // NaN 指 → NaN
        // exp 符号(bit63)定结果:bit63=0(y>0)→+Inf;bit63=1(y<0)→+0。
        vm.shrImm(VReg.V2, VReg.S1, 63);
        vm.cmpImm(VReg.V2, 1);
        vm.jeq("_mpow_infbase_neg");
        vm.movImm64(VReg.RET, 0x7ff0000000000000n); // +Inf (y>0)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_infbase_neg");
        vm.movImm(VReg.RET, 0);     // +0 (y<0)
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // |exp|==±Inf(非 NaN):按 |base| 与 1 比较。
        vm.label("_mpow_infexp");
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1); // |base|
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_mpow_zerobase");          // ±0^±Inf 走零底
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_mpow_infbase");           // ±Inf^±Inf
        vm.movImm64(VReg.V1, 0x3ff0000000000000n); // 1.0
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_mpow_nan");               // (±1)^±Inf → NaN
        vm.shrImm(VReg.V3, VReg.S1, 63);   // exp 符号
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_mpow_infexp_small");      // |base| < 1
        // |base| > 1:+Inf → +Inf; −Inf → +0
        vm.cmpImm(VReg.V3, 1);
        vm.jeq("_mpow_infexp_gt1_neg");
        vm.movImm64(VReg.RET, 0x7ff0000000000000n);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_infexp_gt1_neg");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_infexp_small");    // |base| < 1:+Inf → +0; −Inf → +Inf
        vm.cmpImm(VReg.V3, 1);
        vm.jeq("_mpow_infexp_small_neg");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_infexp_small_neg");
        vm.movImm64(VReg.RET, 0x7ff0000000000000n);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // 大偶数整数指数:±0^正 → +0; ±0^负 → +Inf;其余仍走平方-乘(n 当偶数)。
        vm.label("_mpow_large_int");
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_mpow_large_int_nonzero");
        vm.shrImm(VReg.V2, VReg.S1, 63);
        vm.cmpImm(VReg.V2, 1);
        vm.jeq("_mpow_zero_neg");          // (±0)^负大偶数 → +Inf
        vm.movImm(VReg.RET, 0);            // (±0)^正大偶数 → +0
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_mpow_large_int_nonzero");
        // ±Inf ** |exp|>=2^53: x64 fcvtzs saturates huge finite to
        // INT64_MIN (indefinite), treated as negative even → 1/Inf
        // leftover +0 (`Infinity ** MAX_VALUE` / `-Infinity ** MAX_VALUE`).
        // All |exp|>=2^53 integers are even; existing _mpow_infbase
        // (y>0 → +Inf, y<0 → +0) matches ES. V2 still |base|.
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_mpow_infbase");
        vm.fcvtzs(VReg.V0, 1);
        vm.movImm(VReg.V1, 1);
        vm.not(VReg.V1, VReg.V1);
        vm.and(VReg.V0, VReg.V0, VReg.V1); // 清最低位 → 偶数
        vm.movImm(VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_mpow_abs_done");
        vm.movImm(VReg.V2, 1);
        vm.neg(VReg.V0, VReg.V0);
        vm.jmp("_mpow_abs_done");
    }
}

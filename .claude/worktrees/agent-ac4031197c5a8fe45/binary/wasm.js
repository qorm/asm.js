// asm.js WebAssembly 模块 writer(零依赖手写,与 ELF/PE writer 同级)
// [M3 分段] 产出 K 个段函数 + 1 个蹦床:寄存器堆是模块级 mutable globals,
// 每段覆盖 segSize 个连续标签、内嵌自己的派发 loop(block_exit{ loop{ block×n{
// br_table(pc-first) } 切片… } });目标不在本段 → br_table default 落 block_exit
// 返回蹦床,蹦床按 pc/segSize 常数除法路由到段函数。调用/返回/异常 unwind/协程
// 切换全是 pc 赋值 → 跨段天然成立。切片拼装只在标签处插 end 字节,所有跳转
// 立即数已由 asm.fixupAll 以"值补丁"回填,拼装不移位。设计见 docs/WASM_DESIGN.md。

import { WASM_NUM_I64_GLOBALS, WASM_NUM_F64_GLOBALS } from "../backend/wasm32.js";

// 线性内存布局(与 compiler 入口代码、runtime wasi 分支、宿主 shim 共享)
// 影子栈顶(向下生长);也是 _stack_base 初值。置于数据段基址正下方,占满
// [WASM_ARGV_BASE, WASM_DATA_BASE) ≈ 16MB 实存(初始 memory 已覆盖到数据段尾,
// 该区间恒为已提交线性内存)。[0x400000, WASM_DATA_BASE) 曾标注为"代码序号地址
// 空间(纯逻辑值,不占内存)"——代码地址(CODE_BASE+序号)只作 pc 立即数消费,
// 从不作内存地址解引用,故此窗口的实存可安全充作栈:栈地址永不被装箱/GC 当指针
// (堆对象 ≥ WASM_HEAP_FLOOR),代码地址也永不与栈地址做范围比较。4MB→16MB 使
// 递归深度 ~600 → ~2400,追平并超过 native(~1200)。
export const WASM_STACK_TOP = 0x1000000;
export const WASM_DATA_BASE = 0x1000000;  // 数据段基址(16MB)
export const WASM_HEAP_FLOOR = 0x8000000; // 堆 arena 起点(128MB);mmap shim 从此 bump
export const WASM_PAGE_SIZE = 65536;
// 宿主 → 程序 argv/env 递交区(影子栈最深页;串在 _process_init 里即被复制进堆,
// 深栈覆写无碍):[+0]=argc(i64),[+16..]=argv 指针数组 + NULL + envp 指针数组 +
// NULL + 串字节。envp = argv+(argc+1)*8 的 POSIX 形状天然成立。宿主不写则全 0。
export const WASM_ARGV_BASE = 0x10000;

function pushUleb(arr, v) {
    let n = v >>> 0;
    while (true) {
        let b = n & 0x7f;
        n = n >>> 7;
        if (n !== 0) {
            arr.push(b | 0x80);
        } else {
            arr.push(b);
            break;
        }
    }
}

function pushBytes(arr, bytes) {
    for (let i = 0; i < bytes.length; i = i + 1) {
        arr.push(bytes[i] & 0xff);
    }
}

function pushName(arr, str) {
    pushUleb(arr, str.length);
    for (let i = 0; i < str.length; i = i + 1) {
        arr.push(str.charCodeAt(i) & 0xff);
    }
}

function pushSection(out, id, body) {
    out.push(id);
    pushUleb(out, body.length);
    pushBytes(out, body);
}

export class WasmModuleGenerator {
    // asm: Wasm32Assembler(fixupAll 已跑完)
    generate(asm) {
        const names = asm._codeLabelNames;
        const offs = asm._codeLabelOffs;
        const nLabels = names.length;
        if (nLabels === 0 || names[0] !== "_start" || offs[0] !== 0) {
            throw new Error("wasm writer: first code label must be _start at offset 0 (pc global inits to 0)");
        }
        const segSize = asm.segSize;
        const numSegs = Math.ceil(nLabels / segSize);

        const out = [];
        // magic + version
        pushBytes(out, [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

        // ---- type (id 1):t0 = (i64×7)→i64(__syscall),t1 = ()→() ----
        const typeSec = [];
        pushUleb(typeSec, 2);
        typeSec.push(0x60);
        pushUleb(typeSec, 7);
        for (let i = 0; i < 7; i = i + 1) typeSec.push(0x7e);
        pushUleb(typeSec, 1);
        typeSec.push(0x7e);
        typeSec.push(0x60);
        pushUleb(typeSec, 0);
        pushUleb(typeSec, 0);
        pushSection(out, 1, typeSec);

        // ---- import (id 2):env.__syscall → 函数索引 0 ----
        const impSec = [];
        pushUleb(impSec, 1);
        pushName(impSec, "env");
        pushName(impSec, "__syscall");
        impSec.push(0x00); // func
        pushUleb(impSec, 0); // type t0
        pushSection(out, 2, impSec);

        // ---- function (id 3):段函数(索引 1..K)+ 蹦床(索引 K+1),均 t1 ----
        const funcSec = [];
        pushUleb(funcSec, numSegs + 1);
        for (let i = 0; i < numSegs + 1; i = i + 1) pushUleb(funcSec, 1);
        pushSection(out, 3, funcSec);

        // ---- memory (id 5):初始覆盖数据段,堆由宿主 shim 按 mmap 需求 grow ----
        const dataEnd = WASM_DATA_BASE + asm.data.length;
        const initialPages = Math.floor(dataEnd / WASM_PAGE_SIZE) + 4;
        const memSec = [];
        pushUleb(memSec, 1);
        memSec.push(0x01); // 有上限
        pushUleb(memSec, initialPages);
        pushUleb(memSec, 65536); // 4GB 封顶
        pushSection(out, 5, memSec);

        // ---- global (id 6):寄存器堆 —— 0=pc(i32) + 25×i64 + 10×f64,全 mutable 初值 0 ----
        const glbSec = [];
        pushUleb(glbSec, 1 + WASM_NUM_I64_GLOBALS + WASM_NUM_F64_GLOBALS);
        glbSec.push(0x7f, 0x01, 0x41, 0x00, 0x0b); // pc: i32 mut = 0
        for (let i = 0; i < WASM_NUM_I64_GLOBALS; i = i + 1) {
            glbSec.push(0x7e, 0x01, 0x42, 0x00, 0x0b);
        }
        for (let i = 0; i < WASM_NUM_F64_GLOBALS; i = i + 1) {
            glbSec.push(0x7c, 0x01, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b);
        }
        pushSection(out, 6, glbSec);

        // ---- export (id 7):memory + _start(蹦床) ----
        const expSec = [];
        pushUleb(expSec, 2);
        pushName(expSec, "memory");
        expSec.push(0x02);
        pushUleb(expSec, 0);
        pushName(expSec, "_start");
        expSec.push(0x00);
        pushUleb(expSec, numSegs + 1);
        pushSection(out, 7, expSec);

        // ---- code (id 10):K 个段函数 + 蹦床 ----
        const codeSec = [];
        pushUleb(codeSec, numSegs + 1);
        for (let k = 0; k < numSegs; k = k + 1) {
            const body = this._buildSegmentBody(asm, k, segSize, nLabels);
            pushUleb(codeSec, body.length);
            pushBytes(codeSec, body);
        }
        const tramp = this._buildTrampolineBody(numSegs, segSize);
        pushUleb(codeSec, tramp.length);
        pushBytes(codeSec, tramp);
        pushSection(out, 10, codeSec);

        // ---- data (id 11):主动段 @ WASM_DATA_BASE ----
        const dataSec = [];
        pushUleb(dataSec, 1);
        dataSec.push(0x00); // memidx 0,主动段
        dataSec.push(0x41); // i32.const
        // sleb32(DATA_BASE):正数且 < 2^31,逐 7 位
        let dv = WASM_DATA_BASE;
        while (true) {
            let b = dv & 0x7f;
            dv = dv >> 7;
            const sign = (b & 0x40) !== 0;
            if ((dv === 0 && !sign) || (dv === -1 && sign)) {
                dataSec.push(b);
                break;
            }
            dataSec.push(b | 0x80);
        }
        dataSec.push(0x0b); // end
        pushUleb(dataSec, asm.data.length);
        pushBytes(dataSec, asm.data);
        pushSection(out, 11, dataSec);

        return out;
    }

    // 段 k 的函数体:block_exit{ loop{ block×n{ br_table(pc-first) } 切片… pc←next } }
    _buildSegmentBody(asm, k, segSize, nLabels) {
        const offs = asm._codeLabelOffs;
        const code = asm.code;
        const first = k * segSize;
        const n = Math.min(segSize, nLabels - first);

        const body = [];
        pushUleb(body, 0); // 零 locals(寄存器全在 globals,操作数纯栈)

        body.push(0x02, 0x40); // block_exit
        body.push(0x03, 0x40); // loop
        for (let i = 0; i < n; i = i + 1) {
            body.push(0x02, 0x40);
        }
        // br_table 选段内标签:idx = pc - first(pc 越界/负 → u32 巨值 → default 出段)
        body.push(0x23);
        pushUleb(body, 0); // global.get pc
        if (first > 0) {
            body.push(0x41);
            // sleb32(first):first < 2^28,逐 7 位
            let v = first;
            while (true) {
                let b = v & 0x7f;
                v = v >> 7;
                if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
                    body.push(b);
                    break;
                }
                body.push(b | 0x80);
            }
            body.push(0x6b); // i32.sub
        }
        body.push(0x0e);
        pushUleb(body, n); // br_table 目标数(不含 default)
        for (let i = 0; i < n; i = i + 1) {
            pushUleb(body, i);
        }
        pushUleb(body, n + 1); // default → block_exit(目标不在本段 → 返回蹦床)

        // 切片拼装:每个段内标签处关一层 block,再接该标签的代码切片
        for (let i = 0; i < n; i = i + 1) {
            body.push(0x0b); // end of block i
            const gi = first + i;
            const segEnd = gi + 1 < nLabels ? offs[gi + 1] : code.length;
            for (let j = offs[gi]; j < segEnd; j = j + 1) {
                body.push(code[j]);
            }
        }

        // 末切片贯穿出段:pc ← 下一全局标签,落出 loop/block_exit 返回蹦床
        body.push(0x41);
        let nv = first + n;
        while (true) {
            let b = nv & 0x7f;
            nv = nv >> 7;
            if ((nv === 0 && (b & 0x40) === 0) || (nv === -1 && (b & 0x40) !== 0)) {
                body.push(b);
                break;
            }
            body.push(b | 0x80);
        }
        body.push(0x24);
        pushUleb(body, 0); // global.set pc
        body.push(0x0b); // end loop
        body.push(0x0b); // end block_exit
        body.push(0x0b); // end function
        return body;
    }

    // 蹦床(导出 _start):loop{ block×K{ br_table(pc/segSize) } call segᵢ; br loop … }
    _buildTrampolineBody(numSegs, segSize) {
        const body = [];
        pushUleb(body, 0); // 零 locals
        body.push(0x02, 0x40); // block_oob
        body.push(0x03, 0x40); // loop
        for (let i = 0; i < numSegs; i = i + 1) {
            body.push(0x02, 0x40);
        }
        body.push(0x23);
        pushUleb(body, 0); // global.get pc
        body.push(0x41);
        let v = segSize;
        while (true) {
            let b = v & 0x7f;
            v = v >> 7;
            if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
                body.push(b);
                break;
            }
            body.push(b | 0x80);
        }
        body.push(0x6e); // i32.div_u
        body.push(0x0e);
        pushUleb(body, numSegs);
        for (let i = 0; i < numSegs; i = i + 1) {
            pushUleb(body, i);
        }
        pushUleb(body, numSegs + 1); // default → block_oob → unreachable

        for (let i = 0; i < numSegs; i = i + 1) {
            body.push(0x0b); // end of block i
            body.push(0x10);
            pushUleb(body, 1 + i); // call 段函数(导入占 0)
            body.push(0x0c);
            pushUleb(body, numSegs - 1 - i); // br 回 loop
        }
        body.push(0x0b); // end loop
        body.push(0x0b); // end block_oob
        body.push(0x00); // unreachable
        body.push(0x0b); // end function
        return body;
    }
}

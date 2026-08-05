// asm.js Symbol 运行时（ES 批次D 基础子集）
//
// 值表示：NaN-box 标签已满，Symbol 用**裸堆指针 + 用户区类型标记**表示
// （与 TYPE_GETTER 标记对象同一手法，判别 = 裸堆指针(高16位=0) 且
//  处于 [heap_base, heap_ptr) 且 [ptr+0] == TYPE_SYMBOL）。
//
// 块布局（24B 用户区）:
//   +0:  TYPE_SYMBOL (61)
//   +8:  description 字符串裸指针（boxed string 的 payload；无描述为 0）
//   +16: 保留(0)
//
// 唯一性：每次 _symbol_new 分配新块 → 指针位比较（_strict_eq 对两个裸堆
// 指针走 raw 位比较路径）天然正确。
//
// GC：保守扫描。desc 存裸指针，符号块被标灰后 _gc_drain 逐字扫用户区即
// 保活 desc；Symbol.for 注册表链表头/众所周知符号槽都在数据段 qword 区
// （_data_gc_end 之前）→ 根扫描覆盖，注册符号永不被回收。

import { VReg } from "../../../vm/registers.js";

const TYPE_SYMBOL = 61;

// 众所周知符号（占位属性：唯一 symbol 值挂在 Symbol 上，不接迭代协议）
export const WELLKNOWN_SYMBOLS = ["iterator", "asyncIterator", "hasInstance", "toPrimitive", "toStringTag"];

export class SymbolGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateDataSlots();
        this.generateSymbolNew();
        this.generateIsSymbol();
        this.generateSymbolToString();
        this.generateSymbolFor();
        this.generateSymbolKeyFor();
        this.generateSymbolWellknown();
    }

    // 数据段槽：注册表链表头 + well-known 槽。
    // 运行时 generate() 在 compiler/index.js 的 _data_gc_end 之前执行，
    // 这些 qword 落在 GC 根扫描区间内。
    generateDataSlots() {
        const asm = this.vm.asm;
        asm.addDataLabel("_symbol_registry");
        asm.addDataQword(0);
        for (let i = 0; i < WELLKNOWN_SYMBOLS.length; i++) {
            asm.addDataLabel("_symwk_" + WELLKNOWN_SYMBOLS[i]);
            asm.addDataQword(0);
        }
    }

    // _symbol_new(desc) -> 裸符号指针
    // desc: boxed string / 裸字符串指针 / 0(undefined)；其它形态（数字等）
    // description 置空（偏差：不做 ToString）。
    generateSymbolNew() {
        const vm = this.vm;

        vm.label("_symbol_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);

        // 归一化 desc → 裸字符串指针
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_symbol_new_unbox");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_symbol_new_bare");
        // 非字符串 tagged/float → 无描述
        vm.movImm(VReg.S0, 0);
        vm.jmp("_symbol_new_alloc");

        vm.label("_symbol_new_unbox");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.jmp("_symbol_new_floor");

        vm.label("_symbol_new_bare");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_symbol_new_alloc");
        vm.label("_symbol_new_floor");
        // 防御 floor：低于二进制基址的垃圾"指针"不当描述串存（与 _getStrContent 同判据）
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_symbol_new_alloc");
        vm.movImm(VReg.S0, 0);

        vm.label("_symbol_new_alloc");
        // desc(S0) 是活堆指针时跨 _alloc 安全：_alloc prologue 保存 S0-S3 入栈，
        // GC 栈扫描可见。
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc"); // RET = user ptr
        vm.movImm(VReg.V1, TYPE_SYMBOL);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.RET, 16, VReg.V1);
        vm.epilogue([VReg.S0], 0);
    }

    // _is_symbol(v) -> 0/1（判别法同 _is_bigint，但类型标记在用户区 +0）
    generateIsSymbol() {
        const vm = this.vm;

        vm.label("_is_symbol");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_is_symbol_no");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_is_symbol_no");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jb("_is_symbol_no");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jae("_is_symbol_no");
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jne("_is_symbol_no");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);
        vm.label("_is_symbol_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // _symbol_to_string(sym) -> boxed 堆字符串 "Symbol(desc)"
    // （String(sym)/_valueToStr 分派用；标准要求 String(sym) 合法而拼接
    //  TypeError——本实现拼接也得到该串，记偏差）
    generateSymbolToString() {
        const vm = this.vm;

        vm.label("_symbol_to_string");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.A0, "_str_symbol_open"); // "Symbol("
        vm.load(VReg.A1, VReg.S0, 8); // desc 裸指针（0 → _getStrContent 给空串）
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, "_str_rparen"); // ")"
        vm.call("_strconcat");
        vm.epilogue([VReg.S0], 0);
    }

    // _symbol_for(key) -> 裸符号指针
    // 全局注册表：数据段链表头 _symbol_registry，节点(堆, 24B)
    // {key串裸指针@0, sym@8, next@16}。按 key 内容比较，同键同符号。
    generateSymbolFor() {
        const vm = this.vm;

        vm.label("_symbol_for");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // key JSValue
        vm.call("_getStrContent"); // A0 已是 key
        vm.mov(VReg.S1, VReg.RET); // key 内容指针

        vm.lea(VReg.V1, "_symbol_registry");
        vm.load(VReg.S2, VReg.V1, 0); // cur
        vm.label("_symbol_for_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_symbol_for_miss");
        vm.load(VReg.A0, VReg.S2, 0); // node.key 裸串指针
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_symbol_for_hit");
        vm.load(VReg.S2, VReg.S2, 16); // next
        vm.jmp("_symbol_for_loop");

        vm.label("_symbol_for_hit");
        vm.load(VReg.RET, VReg.S2, 8);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_symbol_for_miss");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_symbol_new"); // description = key
        vm.mov(VReg.S3, VReg.RET); // sym（跨 _alloc 由其 prologue 栈存保活）
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc"); // RET = node
        vm.load(VReg.V1, VReg.S3, 8); // 归一化后的 key 裸指针 = sym.desc
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S3);
        vm.lea(VReg.V2, "_symbol_registry");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.store(VReg.RET, 16, VReg.V1); // next = 旧头
        vm.store(VReg.V2, 0, VReg.RET); // 头 = 新节点（数据段根 → 注册符号常驻）
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _symbol_keyfor(sym) -> boxed key 字符串 / 0(undefined)
    // 注册表按符号指针位比较。
    generateSymbolKeyFor() {
        const vm = this.vm;

        vm.label("_symbol_keyfor");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 脱壳保险（裸符号本就高16=0）
        vm.lea(VReg.V1, "_symbol_registry");
        vm.load(VReg.S1, VReg.V1, 0);
        vm.label("_symbol_keyfor_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_symbol_keyfor_miss");
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmp(VReg.V1, VReg.S0);
        vm.jeq("_symbol_keyfor_hit");
        vm.load(VReg.S1, VReg.S1, 16);
        vm.jmp("_symbol_keyfor_loop");

        vm.label("_symbol_keyfor_hit");
        vm.load(VReg.RET, VReg.S1, 0); // key 裸指针
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_symbol_keyfor_miss");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_symbol_keyfor_miss");
        vm.lea(VReg.RET, "_js_undefined"); // 装箱 undefined(匹配 node 打印)
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _symbol_wellknown(slot, desc) -> 裸符号指针
    // slot 为数据段 8B 槽地址：为 0 则懒创建（desc 为 boxed 描述串）并回填，
    // 否则返回既有符号 → 进程内唯一、指针稳定。
    generateSymbolWellknown() {
        const vm = this.vm;

        vm.label("_symbol_wellknown");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.RET, VReg.S0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_symbol_wellknown_done");
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_symbol_new");
        vm.store(VReg.S0, 0, VReg.RET);
        vm.label("_symbol_wellknown_done");
        vm.epilogue([VReg.S0], 0);
    }
}

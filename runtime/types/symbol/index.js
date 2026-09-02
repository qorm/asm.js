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
export const WELLKNOWN_SYMBOLS = ["iterator", "asyncIterator", "hasInstance",
    "isConcatSpreadable", "match", "matchAll", "replace", "search",
    "species", "split", "toPrimitive", "toStringTag", "unscopables"];

export class SymbolGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateDataSlots();
        this.generateSymbolNew();
        this.generateIsSymbol();
        this.generateSymbolThisValue();
        this.generateSymbolToString();
        this.generateSymbolFor();
        this.generateSymbolKeyFor();
        this.generateSymbolWellknown();
        this.generateSymbolValueOf();
        this.generateSymbolDescription();
        this.generateEnsureSymbolProto();
        this.generateSymbolWrap();
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
        // ToObject(Symbol) wrapper shares these with emitSymbolCtorObject
        // (_reEnsureSlot skips existing labels). Proto slot must exist in the
        // runtime image: _agen_toobject may wrap before Symbol is evaluated.
        asm.addDataLabel("_nsobj_symbol");
        asm.addDataQword(0);
        asm.addDataLabel("_nsobj_symbol_proto");
        asm.addDataQword(0);
    }

    // _symbol_new(desc) -> 裸符号指针
    // undefined 保留「无 description」；其余值严格执行 ToString，并保存所得
    // 字符串内容指针。调用方必须用 JS_UNDEFINED 表示缺参，不能再用裸 0：
    // 裸 0 同时也是合法的数值 +0，Symbol(0).description 必须为 "0"。
    generateSymbolNew() {
        const vm = this.vm;

        vm.label("_symbol_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_symbol_new_no_desc");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr"); // 可调用用户 toString/valueOf，并传播异常
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_symbol_new_alloc");

        vm.label("_symbol_new_no_desc");
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
        vm.andImm(VReg.V1, VReg.V1, 0xff); // type 低字节(高字节可含标志位)
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jne("_is_symbol_no");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 0);
        vm.label("_is_symbol_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // _symbol_this_value(this) -> 裸 Symbol。原始值或 Object(sym) 包装
    // (0x7FFD + __symbol_value) 皆可;否则 TypeError。
    generateSymbolThisValue() {
        const vm = this.vm;
        vm.label("_symbol_this_value");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_stv_ok");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_stv_err");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__symbol_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_stv_err");
        vm.label("_stv_ok");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_stv_err");
        vm.lea(VReg.A0, vm.asm.addString("Symbol.prototype called on incompatible receiver"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // _symbol_to_string(sym) -> boxed 堆字符串 "Symbol(desc)"
    // （String(sym)/_valueToStr 分派用；标准要求 String(sym) 合法而拼接
    //  TypeError——本实现拼接也得到该串，记偏差）
    generateSymbolToString() {
        const vm = this.vm;

        vm.label("_symbol_to_string");
        vm.prologue(0, [VReg.S0]);
        vm.call("_symbol_this_value");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.A0, "_str_symbol_open"); // "Symbol("
        vm.load(VReg.A1, VReg.S0, 8); // desc 裸指针; 0 = no description
        // _strconcat/_emitArgStrInline treats 0 as number 0 → "0"
        // (Symbol() was "Symbol(0)" vs spec "Symbol()").
        vm.cmpImm(VReg.A1, 0);
        vm.jne("_sts_have_desc");
        vm.lea(VReg.A1, vm.asm.addString(""));
        vm.label("_sts_have_desc");
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
        vm.call("_valueToStr"); // ToString(key)，含用户代码与异常传播
        vm.mov(VReg.S0, VReg.RET); // 保存规范化后的 boxed string
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
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
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_symbol_keyfor_typeerr");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.S0, VReg.V1); // 裸符号本就高16=0
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

        vm.label("_symbol_keyfor_typeerr");
        vm.lea(VReg.A0, vm.asm.addString("Symbol.keyFor requires a symbol"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
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

    // _symbol_valueOf(this) -> raw symbol pointer
    // Returns the [[SymbolData]] internal slot value.
    // Throws TypeError if this is not a Symbol or Symbol wrapper.
    generateSymbolValueOf() {
        const vm = this.vm;
        vm.label("_symbol_valueOf");
        vm.jmp("_symbol_this_value");
    }

    // _symbol_description(this) -> boxed description string or undefined
    generateSymbolDescription() {
        const vm = this.vm;
        vm.label("_symbol_description");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.call("_symbol_this_value");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.S0, VReg.S0, 8); // desc ptr at sym+8

        // Emit description string or undefined
        vm.label("_sdesc_emit");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_sdesc_undef");
        // Box the description string pointer
        vm.mov(VReg.RET, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        vm.label("_sdesc_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _ensure_symbol_proto -> boxed Symbol.prototype (same _nsobj_symbol_proto).
    // Minimal object if ctor not yet materialized; emitSymbolCtorObject reuses
    // the slot so wrapper.__proto__ === Symbol.prototype after value read.
    generateEnsureSymbolProto() {
        const vm = this.vm;
        vm.label("_ensure_symbol_proto");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_nsobj_symbol_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_esyp_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.lea(VReg.V1, "_nsobj_symbol_proto");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.mov(VReg.V0, VReg.RET);
        vm.label("_esyp_have");
        vm.mov(VReg.RET, VReg.V0);
        vm.epilogue([VReg.S0], 0);
    }

    // _symbol_wrap(A0=primitive Symbol) -> boxed Symbol wrapper (0x7FFD).
    // OrdinaryToObject: [[SymbolData]] via __symbol_value; __proto__ = Symbol.prototype.
    // Mirrors _number_new (define own data while proto is Object.prototype, then attach).
    generateSymbolWrap() {
        const vm = this.vm;
        vm.label("_symbol_wrap");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0); // primitive Symbol
        vm.call("_object_new");
        vm.mov(VReg.S0, VReg.RET);
        vm.store(VReg.SP, 0, VReg.S0);
        vm.call("_ensure_symbol_proto");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__symbol_value"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_define");
        vm.load(VReg.S0, VReg.SP, 0);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_js_unbox");
        vm.store(VReg.S0, 16, VReg.RET);
        vm.mov(VReg.RET, VReg.S0);
        vm.call("_box_obj_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }
}

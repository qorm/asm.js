// asm.js runtime - Number wrapper object support
// new Number(x) creates a 0x7FFD-tagged wrapper with __number_value property,
// matching the Boolean wrapper pattern.

import { VReg } from "../../../vm/registers.js";

export class NumberWrapperGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generateDataSlots() {
        const asm = this.vm.asm;
        asm.addDataLabel("_nsobj_number");
        asm.addDataQword(0);
        asm.addDataLabel("_nsobj_number_proto");
        asm.addDataQword(0);
    }

    generate() {
        this.generateDataSlots();
        this.generateNumberNew();
    }

    // _number_new(A0 = rawVal) -> boxed Number wrapper object (0x7FFD)
    // rawVal: any JS value. Calls _builtin_number for ToNumber coercion,
    // creates wrapper, sets __number_value, returns 0x7FFD-tagged wrapper.
    // Compiler must emitNumberCtorObject BEFORE this call so the proto
    // slot is the real Number.prototype (methods/constructor), not the
    // minimal _ensure_number_proto object. __proto__ is set here.
    generateNumberNew() {
        const vm = this.vm;
        vm.label("_number_new");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        // Step 1: convert to number via _builtin_number (ToNumber semantics)
        vm.call("_builtin_number"); // RET = float64 bits
        vm.mov(VReg.S1, VReg.RET);  // S1 = number value (IEEE 754 bits)

        // Step 2: create wrapper object
        vm.call("_object_new");     // RET = raw obj ptr
        vm.mov(VReg.S0, VReg.RET);  // S0 = raw obj ptr
        vm.store(VReg.SP, 0, VReg.S0); // survive _object_define S0 clobber

        // Step 3: Number.prototype from _ensure (RET = boxed proto on both
        // fill and already-filled paths). Do NOT lea V3 + mask: x64 V3≡R8
        // reload after ensure stored 0 → getPrototypeOf(new Number)===null
        // (4-405 / 4-581). _js_unbox keeps RET live via A0.
        vm.call("_ensure_number_proto");
        vm.mov(VReg.S2, VReg.RET); // boxed/raw Number.prototype from ensure
        // Define own [[NumberData]] WHILE proto is still Object.prototype.
        // _object_set after Number.prototype is attached walks inherited
        // __number_value=+0 (_object_get returns 0) and zeros __proto__.
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_define");
        vm.load(VReg.S0, VReg.SP, 0); // wrapper (define may clobber S0)
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_js_unbox");
        vm.store(VReg.S0, 16, VReg.RET);

        // _box_obj_r boxes RET, not A0. On arm64 A0≡RET so mov A0,S0
        // happened to work; on x64 A0=RDI / RET=RAX, leftover RET is the
        // just-unboxed proto → new Number(0) === Number.prototype.
        vm.mov(VReg.RET, VReg.S0);
        vm.call("_box_obj_r");

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }
}

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
    // Proto is set to 0 initially; compiler will overwrite after
    // emitNumberProtoObject materializes the real prototype.
    generateNumberNew() {
        const vm = this.vm;
        vm.label("_number_new");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        // Step 1: convert to number via _builtin_number (ToNumber semantics)
        // A0 = raw value (could be string, bool, etc.)
        vm.call("_builtin_number"); // RET = float64 bits
        vm.mov(VReg.S1, VReg.RET);  // S1 = number value (IEEE 754 bits)

        // Step 2: create wrapper object
        vm.call("_object_new");     // RET = raw obj ptr
        vm.mov(VReg.S0, VReg.RET);  // S0 = raw obj ptr

        // Step 3: set proto from global slot (always present from emitNumberCtorObject)
        vm.lea(VReg.V3, "_nsobj_number_proto");
        vm.load(VReg.V3, VReg.V3, 0); // V3 = boxed proto (0 if not yet materialized)
        // Unbox proto: __proto__ slot stores raw pointer, not boxed value
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V3, VReg.V3, VReg.V1);
        vm.store(VReg.S0, 16, VReg.V3); // obj.__proto__ = raw prototype pointer

        // Step 4: store __number_value property
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2); // A1 = boxed string "__number_value"
        vm.mov(VReg.A2, VReg.S1);         // A2 = number value (IEEE 754 bits)
        vm.call("_object_set");

        // Step 5: box and return 0x7FFD-tagged wrapper
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_box_obj_r"); // RET = 0x7FFD-tagged wrapper

        vm.epilogue([VReg.S0, VReg.S1], 0);
    }
}

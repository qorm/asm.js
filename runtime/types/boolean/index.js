// asm.js runtime - Boolean type
// Boolean prototype methods: toString, valueOf

import { VReg } from "../../../vm/registers.js";

export class BooleanGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateBooleanNew();
        this.generateBooleanToString();
        this.generateBooleanValueOf();
    }

    // _boolean_new(rawVal) -> boxed Boolean wrapper object (0x7FFD)
    // rawVal: any JS value. Calls _to_boolean, creates wrapper, sets __boolean_value.
    generateBooleanNew() {
        const vm = this.vm;
        vm.label("_boolean_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        // Step 1: convert to boolean
        // A0 = raw value
        vm.call("_to_boolean"); // RET = 0 (falsy) or non-zero (truthy)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_bnew_false_val");
        vm.movImm64(VReg.S0, 0x7FF9000000000001n); // S0 = true
        vm.jmp("_bnew_have_val");
        vm.label("_bnew_false_val");
        vm.movImm64(VReg.S0, 0x7FF9000000000002n); // S0 = false
        vm.label("_bnew_have_val");

        // Step 2: create wrapper object
        vm.call("_object_new"); // RET = raw obj ptr
        vm.mov(VReg.S1, VReg.RET); // S1 = raw obj ptr

        // Step 3: set proto from global slot (read-only, slot filled by emitBooleanCtorObject)
        vm.lea(VReg.V0, "_nsobj_boolean_proto");
        vm.load(VReg.V0, VReg.V0, 0); // V0 = boxed proto (may be 0)
        vm.store(VReg.S1, 16, VReg.V0); // obj.__proto__ = proto (0 ok)

        // Step 4: store __boolean_value
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V2);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");

        // Step 5: box and return
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_box_obj_r"); // RET = 0x7FFD-tagged wrapper

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _boolean_toString(this) -> "true" or "false" (boxed string 0x7FFC)
    generateBooleanToString() {
        const vm = this.vm;
        vm.label("_boolean_toString");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        // Brand check: this must be 0x7FFD-tagged (object wrapper)
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_bts_obj");
        // Also accept 0x7FF9 (primitive boolean) for Boolean.prototype.toString.call(true)
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_bts_bool");
        // TypeError
        vm.lea(VReg.A0, vm.asm.addString("Boolean.prototype.toString called on incompatible receiver"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        // Object wrapper: extract __boolean_value
        vm.label("_bts_obj");
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get"); // RET = boolean value (0x7FF9)
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_bts_print");

        // Primitive boolean: use as-is
        vm.label("_bts_bool");
        vm.mov(VReg.S0, VReg.A0);

        // Check boolean value
        vm.label("_bts_print");
        vm.movImm64(VReg.V1, 0x7FF9000000000002n); // false
        vm.cmp(VReg.S0, VReg.V1);
        vm.jeq("_bts_false");
        vm.lea(VReg.RET, vm.asm.addString("true"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.jmp("_bts_end");

        vm.label("_bts_false");
        vm.lea(VReg.RET, vm.asm.addString("false"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);

        vm.label("_bts_end");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _boolean_valueOf(this) -> boolean primitive (0x7FF9)
    generateBooleanValueOf() {
        const vm = this.vm;
        vm.label("_boolean_valueOf");
        vm.prologue(0, [VReg.S0]);

        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_bvo_obj");
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_bvo_bool");
        vm.lea(VReg.A0, vm.asm.addString("Boolean.prototype.valueOf called on incompatible receiver"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        vm.label("_bvo_obj");
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get"); // RET = boolean value
        vm.jmp("_bvo_end");

        vm.label("_bvo_bool");
        vm.mov(VReg.RET, VReg.A0);

        vm.label("_bvo_end");
        vm.epilogue([VReg.S0], 0);
    }
}

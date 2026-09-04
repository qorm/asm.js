#!/usr/bin/env node
// Contract-level tests for the staged virtual-register manager.
// These tests do not assemble machine code; they prove the allocator's safety
// invariants before it is enabled in the self-hosted emitter.

import assert from "node:assert/strict";
import {
    VirtualRegisterManager,
    auditRecordedRegisters,
    getRegisterAliases,
    getRegisterContract,
} from "../vm/virtual-registers.js";
import { VReg } from "../vm/registers.js";

function testContracts() {
    assert.deepEqual(getRegisterAliases("x64", VReg.V0), ["V0", "RET", "LR"]);
    assert.deepEqual(getRegisterAliases("x64", VReg.V1), ["V1", "A3"]);
    assert.deepEqual(getRegisterAliases("arm64", VReg.V0), ["V0"]);
    assert.deepEqual(getRegisterAliases("arm64", VReg.RET), ["A0", "RET"]);
    assert.deepEqual(getRegisterAliases("wasm32", VReg.A0), ["A0", "RET"]);
    const x64 = getRegisterContract("x64");
    assert.equal(x64.map[VReg.S0], 3);
    assert.equal(x64.map[VReg.S5], null, "x64 S5 is a stack home, not a GPR");
    assert.equal(x64.stackSlots[VReg.S5], -8);
    assert.ok(x64.calleeSaved.includes(VReg.S4));
    const wasm = getRegisterContract("wasm32");
    assert.equal(wasm.map[VReg.A0], 1);
    assert.equal(wasm.map[VReg.V0], 7);
    assert.equal(wasm.map[VReg.FP], 21);
}

function testCallSafeAllocation() {
    const m = new VirtualRegisterManager("x64");
    const t0 = m.newTemp(-56);
    const t1 = m.newTemp(-64);
    const result = m.allocate([
        { defs: [t0], uses: [VReg.A0] },
        { op: 8, call: true, uses: [VReg.A0] },
        { defs: [VReg.RET], uses: [t0] },
        { defs: [t1], uses: [VReg.RET] },
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.assignments[t0], "live temp gets a physical color");
    assert.ok(result.assignments[t0].startsWith("S"), "cross-call temp uses callee-saved register");
    assert.equal(result.spills[t0], undefined);
    assert.equal(m.verify(result).ok, true);
    assert.ok(result.requiredCalleeSaved.includes(result.assignments[t0]));
}

function testOverlapAndSpill() {
    const m = new VirtualRegisterManager("arm64");
    const ts = [];
    for (let i = 0; i < 8; i++) ts.push(m.newTemp(-56 - i * 8));
    const inst = [];
    // Eight simultaneously live values exceed the six S-register colors.
    for (let i = 0; i < ts.length; i++) inst.push({ defs: [ts[i]], uses: [] });
    for (let i = 0; i < ts.length; i++) inst.push({ uses: [ts[i]] });
    const result = m.allocate(inst);
    assert.equal(result.ok, true);
    assert.ok(Object.keys(result.spills).length >= 2);
    for (const name in result.spills) assert.equal(typeof result.spills[name], "number");
    assert.equal(m.verify(result).ok, true);
}

function testControlFlowConservativeWidening() {
    const m = new VirtualRegisterManager("arm64");
    const t0 = m.newTemp(-56);
    const t1 = m.newTemp(-64);
    const result = m.allocate([
        { defs: [t0] },
        { op: "label", operands: ["loop"] },
        { uses: [t0] },
        { defs: [t1] },
        { uses: [t1] },
        { op: "jmp", operands: ["loop"] },
    ]);
    assert.equal(result.intervals[0].first, 0);
    assert.equal(result.intervals[0].last, 5);
    assert.equal(result.intervals[1].first, 0);
    assert.equal(result.intervals[1].last, 5);
    assert.notEqual(result.assignments[t0], result.assignments[t1]);

    const recorded = m.allocateRecorded({
        cnt: 6,
        ops: [3, 10, 3, 3, 3, 12],
        a: [t0, "loop", t0, t1, t1, "loop"],
        b: [0, 0, 0, 0, 0, 0],
        c: [0, 0, 0, 0, 0, 0],
        tempHomes: { T0: -56, T1: -64 },
    });
    const rt0 = recorded.intervals.find((it) => it.name === t0);
    const rt1 = recorded.intervals.find((it) => it.name === t1);
    assert.equal(rt0.first, 0);
    assert.equal(rt0.last, 5);
    assert.equal(rt1.first, 0);
    assert.equal(rt1.last, 5);
}

function testOpcodeStringParity() {
    // Every conditional branch spelling from vm/instructions.js must trigger
    // the conservative CFG widening used when no explicit CFG is available.
    const branchOps = [
        "jeq", "jne", "jlt", "jle", "jgt", "jge", "jb", "jbe", "ja", "jae",
        "jflt", "jfle", "jfgt", "jfge", "jnan",
    ];
    for (const op of branchOps) {
        const m = new VirtualRegisterManager("arm64");
        const left = m.newTemp(-56);
        const right = m.newTemp(-64);
        const out = m.allocate([
            { defs: [left] },
            { uses: [left] },
            { op: op, operands: ["L"] },
            { defs: [right] },
            { uses: [right] },
        ]);
        const li = out.intervals.find((it) => it.name === left);
        const ri = out.intervals.find((it) => it.name === right);
        assert.equal(li.first, 0, op + " widens first interval");
        assert.equal(li.last, 4, op + " widens first interval");
        assert.equal(ri.first, 0, op + " widens second interval");
        assert.equal(ri.last, 4, op + " widens second interval");
        assert.notEqual(out.assignments[left], out.assignments[right], op + " keeps live colors distinct");
    }

    // CALL_INDIRECT is a call-clobber point, but not a branch.  It must not
    // force unrelated, non-overlapping values to stay live for the whole
    // function.
    const m = new VirtualRegisterManager("x64");
    const first = m.newTemp(-56);
    const second = m.newTemp(-64);
    const out = m.allocate([
        { defs: [first] },
        { uses: [first] },
        { op: "call_indirect" },
        { defs: [second] },
        { uses: [second] },
    ]);
    const fi = out.intervals.find((it) => it.name === first);
    const si = out.intervals.find((it) => it.name === second);
    assert.equal(fi.first, 0);
    assert.equal(fi.last, 1);
    assert.equal(si.first, 3);
    assert.equal(si.last, 4);
    assert.equal(out.assignments[first], out.assignments[second]);

    const numeric = new VirtualRegisterManager("x64");
    const nfirst = numeric.newTemp(-56);
    const nsecond = numeric.newTemp(-64);
    const numericOut = numeric.allocate([
        { defs: [nfirst] },
        { uses: [nfirst] },
        { op: 52 }, // RC_CALLINDIRECT: call, but not a CFG edge
        { defs: [nsecond] },
        { uses: [nsecond] },
    ]);
    assert.equal(numericOut.intervals.find((it) => it.name === nfirst).last, 1);
    assert.equal(numericOut.intervals.find((it) => it.name === nsecond).first, 3);
}

function testRecordedAdapter() {
    const t = "T0";
    const record = {
        cnt: 3,
        ops: [3, 8, 3],
        a: [t, "_helper", VReg.RET],
        b: [VReg.A0, 0, t],
        c: [0, 0, 0],
        tempHomes: { T0: -56 },
    };
    const out = auditRecordedRegisters("x64", record);
    assert.equal(out.verification.ok, true);
    assert.equal(out.allocation.intervals[0].home, -56);
    assert.ok(out.allocation.assignments.T0);
}

function testOptionalLivenessAudit() {
    const clobber = auditRecordedRegisters("x64", {
        cnt: 3,
        ops: [3, 8, 11], // mov A0, ...; call; cmp A0, ...
        a: [VReg.A0, "_helper", VReg.A0],
        b: [0, 0, VReg.V1],
        c: [0, 0, 0],
    });
    assert.equal(clobber.liveness.ok, false);
    assert.ok(clobber.liveness.errors.some((e) => e.kind === "call-clobber"));
    assert.equal(clobber.verification.ok, false);

    const scratchReuse = auditRecordedRegisters("x64", {
        cnt: 3,
        ops: [3, 8, 3], // the post-call MOV redefines A0; no value crosses
        a: [VReg.A0, "_helper", VReg.A0],
        b: [VReg.V1, 0, VReg.V2],
        c: [0, 0, 0],
    });
    assert.equal(scratchReuse.liveness.ok, true);

    const labels = auditRecordedRegisters("arm64", {
        cnt: 2,
        ops: [10, 6], // label loop; jeq missing
        a: ["loop", "missing"],
        b: [0, 0],
        c: [0, 0],
    });
    assert.equal(labels.liveness.ok, false);
    assert.ok(labels.liveness.errors.some((e) => e.kind === "label"));
    assert.equal(labels.liveness.mode, "skipped-control-flow");
}

function testUnknownArchitectureFallback() {
    assert.throws(() => new VirtualRegisterManager("not-a-real-arch"), /Unknown register architecture/);
    assert.throws(() => getRegisterContract(null), /Unknown register architecture/);
    assert.deepEqual(getRegisterAliases("x64", "NOPE"), []);
}

function testAllocatorBoundaries() {
    const m = new VirtualRegisterManager("x64");
    for (const bad of [NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => m.allocateRecorded({ cnt: bad, ops: [] }), /safe integer/);
    }
    assert.throws(() => m.allocateRecorded({ cnt: 1, ops: [] }), /shorter/);
    assert.throws(() => m.allocateRecorded({ cnt: 1, a: ["T0"] }), /ops must be an array/);
    assert.throws(() => m.allocate("not-an-array"), /instructions must be an array/);

    // A malformed descriptor must not poison the manager for the next function.
    const bad = m.allocate([null]);
    assert.equal(bad.ok, false);
    const t = m.newTemp(-56);
    const good = m.allocate([{ defs: [t] }]);
    assert.equal(good.ok, true);

    const cyc = [];
    cyc.push(cyc);
    const cycleResult = m.allocate([{ operands: cyc }]);
    assert.equal(cycleResult.ok, true);
}

function testSpillAndAliasBoundaries() {
    const m = new VirtualRegisterManager("x64");
    const ts = [];
    for (let i = 0; i < 6; i++) ts.push(m.newTemp(-56 - i * 8));
    const out = m.allocate(ts.map((t) => ({ defs: [t] })).concat(ts.map((t) => ({ uses: [t] }))));
    assert.ok(Object.keys(out.spills).length >= 1);
    assert.equal(out.ok, true);
    assert.equal(out.emittable, false, "spill lowering is still required");

    const invalidHome = {
        arch: "x64",
        instructionCount: 2,
        intervals: [{ name: "T0", first: 0, last: 1 }],
        assignments: {},
        spills: { T0: -8 },
        fixedPhysical: {},
        callPositions: [],
    };
    assert.equal(m.verify(invalidHome).ok, false);
    const conflict = { ...invalidHome, spills: { T0: -56 }, assignments: { T0: "S0" } };
    const conflictReport = m.verify(conflict);
    assert.equal(conflictReport.ok, false);
    assert.ok(conflictReport.errors.some((e) => /both register and spill/.test(e)));
    const badIntervalHome = {
        arch: "x64", instructionCount: 1,
        intervals: [{ name: "T0", first: 0, last: 0, home: -8 }],
        assignments: { T0: "S0" }, spills: {}, fixedPhysical: {}, callPositions: [],
    };
    assert.ok(m.verify(badIntervalHome).errors.some((e) => /invalid interval home/.test(e)));
    const extra = { ...invalidHome, spills: { T0: -56, T9: -64 } };
    assert.ok(m.verify(extra).errors.some((e) => /spill has no interval/.test(e)));

    const callFree = new VirtualRegisterManager("x64");
    const ct = callFree.newTemp(-56);
    const colored = callFree.allocate([{ defs: [ct] }, { uses: [ct] }], { allowCallerSaved: true });
    assert.equal(colored.ok, true);
    assert.ok(colored.assignments[ct], "caller-saved pool is available when requested");
}

function testStrictVerificationInput() {
    const m = new VirtualRegisterManager("arm64");
    assert.equal(m.verify({}).ok, false);
    assert.equal(m.verify({ arch: "arm64", intervals: null, assignments: {}, spills: {}, fixedPhysical: {}, callPositions: [] }).ok, false);
    assert.equal(m.verify({
        arch: "arm64", instructionCount: 1,
        intervals: [null, { name: "T0", first: 0, last: 0 }],
        assignments: {}, spills: {}, fixedPhysical: {}, callPositions: [],
    }).ok, false);
    const badFixed = m.allocate([{ fixed: ["V99"] }]);
    assert.equal(badFixed.ok, false);
    const badCall = {
        arch: "arm64", instructionCount: 1,
        intervals: [], assignments: {}, spills: {}, fixedPhysical: {}, callPositions: [NaN],
    };
    assert.equal(m.verify(badCall).ok, false);
    const op = m.allocate([{ op: "br_if", uses: ["T0"] }]);
    assert.equal(op.intervals[0].first, 0);
    assert.equal(op.intervals[0].last, 0);
}

function testVerificationBoundaries() {
    const producer = new VirtualRegisterManager("x64");
    const t0 = producer.newTemp(-56);
    const allocation = producer.allocate([
        { defs: [t0] },
        { op: 8, call: true },
        { uses: [t0] },
    ]);
    // Verification must use the allocation's call positions, not mutable state
    // from whichever manager happens to inspect it later.
    const inspector = new VirtualRegisterManager("x64");
    assert.equal(inspector.verify(allocation).ok, true);

    const bad = {
        intervals: [{ name: "T0", first: 0, last: 2 }],
        assignments: { T0: 0 },
        spills: {},
        callPositions: [1],
        fixedPhysical: {},
    };
    const report = inspector.verify(bad);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => /unknown register/.test(e)));
}

function testVerificationMetadataAndCopies() {
    const m = new VirtualRegisterManager("x64");
    const badCount = m.verify({
        arch: "x64", instructionCount: 3,
        intervals: [{ name: "T0", first: 0, last: 2, count: 0 }],
        assignments: { T0: "S0" }, spills: {}, fixedPhysical: {}, callPositions: [],
    });
    assert.ok(badCount.errors.some((e) => /invalid interval count/.test(e)));

    const badSpillCrossing = m.verify({
        arch: "x64", instructionCount: 3,
        intervals: [{ name: "T0", first: 0, last: 2, count: 1, crossesCall: false }],
        assignments: {}, spills: { T0: -56 }, fixedPhysical: {}, callPositions: [1],
    });
    assert.ok(badSpillCrossing.errors.some((e) => /does not claim a recorded call crossing/.test(e)));

    const badSpillType = m.verify({
        arch: "x64", instructionCount: 1,
        intervals: [{ name: "T0", first: 0, last: 0, crossesCall: "yes" }],
        assignments: {}, spills: { T0: -56 }, fixedPhysical: {}, callPositions: [],
    });
    assert.ok(badSpillType.errors.some((e) => /non-boolean crossesCall/.test(e)));

    // A valid non-overlapping reuse of one spill home is allowed; an inclusive
    // endpoint collision is not.
    const reusable = {
        arch: "x64", instructionCount: 5,
        intervals: [
            { name: "T0", first: 0, last: 1, home: -56 },
            { name: "T1", first: 2, last: 4, home: -56 },
        ],
        assignments: {}, spills: { T0: -56, T1: -56 }, fixedPhysical: {}, callPositions: [],
    };
    assert.equal(m.verify(reusable).ok, true);
    const overlap = {
        ...reusable,
        intervals: [
            { name: "T0", first: 0, last: 4, home: -56 },
            { name: "T1", first: 2, last: 3, home: -56 },
        ],
    };
    assert.equal(m.verify(overlap).ok, false);
    assert.ok(m.verify(overlap).errors.some((e) => /spill overlap/.test(e)));

    const allocated = m.allocate([{ defs: [m.newTemp(-56)] }]);
    const internalFirst = m._intervalList[0].first;
    allocated.intervals[0].first = 12345;
    assert.equal(m._intervalList[0].first, internalFirst, "allocation intervals are detached copies");
}

function testRecordedHomesDoNotLeak() {
    const m = new VirtualRegisterManager("arm64");
    const first = auditRecordedRegisters("arm64", {
        cnt: 1, ops: [3], a: ["T0"], b: [0], c: [0], tempHomes: { T0: -56 },
    });
    assert.equal(first.allocation.intervals[0].home, -56);
    const second = m.allocateRecorded({
        cnt: 7,
        ops: [3, 3, 3, 3, 3, 3, 3],
        a: ["T0", "T1", "T2", "T3", "T4", "T5", "T6"],
        b: [0, 0, 0, 0, 0, 0, 0],
        c: [0, 0, 0, 0, 0, 0, 0],
        tempHomes: { T0: -72 },
    });
    const t1 = second.intervals.find((it) => it.name === "T1");
    assert.equal(t1.home, undefined);
    const third = m.allocateRecorded({
        cnt: 1, ops: [3], a: ["T0"], b: [0], c: [0], tempHomes: { T0: -80 },
    });
    assert.equal(third.intervals[0].home, -80);
}

testContracts();
testCallSafeAllocation();
testOverlapAndSpill();
testControlFlowConservativeWidening();
testOpcodeStringParity();
testRecordedAdapter();
testOptionalLivenessAudit();
testUnknownArchitectureFallback();
testAllocatorBoundaries();
testSpillAndAliasBoundaries();
testStrictVerificationInput();
testVerificationBoundaries();
testVerificationMetadataAndCopies();
testRecordedHomesDoNotLeak();
console.log("vm_virtual_registers: ok");

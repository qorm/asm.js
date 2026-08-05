// Object.prototype.toString on non-property heap objects: TypedArray /
// ArrayBuffer / DataView / Generator / Promise / BigInt / Symbol.
// These route through the [Symbol.toStringTag] probe (_object_get), which walks
// internal slots as if they were property counts. On native the garbage walk is
// absorbed by pointer guards but SEGFAULTS; on wasm the stricter linear-memory
// bounds either mislabel them [object Object] or OOB-trap (DataView, BigInt).
// The wasi backend short-circuits by type byte before the probe.
//
// BigInt is a bare heap pointer whose *value* sits at [ptr+0] and whose type
// byte is at [ptr-16]; a naive [ptr+0] type-byte check would mislabel e.g. 66n
// (low byte 0x42) as Int32Array, so BigInt/Symbol are ruled out first via the
// canonical _is_bigint/_is_symbol helpers. native runs compile-only because it
// crashes here; wasm behaviour is asserted via expectWasm.
const t = Object.prototype.toString;
console.log(t.call(new Int8Array(1)));
console.log(t.call(new Uint8Array(1)));
console.log(t.call(new Uint8ClampedArray(1)));
console.log(t.call(new Int16Array(1)));
console.log(t.call(new Uint16Array(1)));
console.log(t.call(new Int32Array(1)));
console.log(t.call(new Uint32Array(1)));
console.log(t.call(new Float32Array(1)));
console.log(t.call(new Float64Array(1)));
console.log(t.call(new ArrayBuffer(8)));
console.log(t.call(new DataView(new ArrayBuffer(8))));
console.log(t.call(Promise.resolve(1)));
console.log(t.call(10n));
console.log(t.call(66n));  // low byte 0x42 collides with Int32Array type byte
console.log(t.call(97n));  // low byte 0x61 collides with Float64Array type byte
console.log(t.call(Symbol("s")));

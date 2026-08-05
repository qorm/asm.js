// TypedArray -> string coercion: String(ta), ""+ta, template, ta.toString()
// all produce the comma-joined element list (matches node), not garbage float.
var a = new Uint8Array([1, 2, 3]);
console.log(String(a));
console.log("" + a);
console.log(`${a}`);
console.log(a.toString());
var f = new Float64Array([1.5, 2.5]);
console.log(String(f));
console.log(f.toString());
var e = new Int32Array([]);
console.log("[" + String(e) + "]");

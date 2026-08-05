var a = new Uint8Array([1,2,3,4,5]); a.copyWithin(0,3); console.log(a.join(","));       // 4,5,3,4,5
var b = new Uint8Array([1,2,3,4,5]); b.copyWithin(1,3); console.log(b.join(","));       // 1,4,5,4,5
var c = new Int32Array([1,2,3,4,5]); c.copyWithin(0,3,4); console.log(c.join(","));     // 4,2,3,4,5
var d = new Uint8Array([1,2,3,4,5]); d.copyWithin(3,0); console.log(d.join(","));       // 1,2,3,1,2
var e = new Float64Array([1.5,2.5,3.5]); e.copyWithin(1,0); console.log(e.join(","));   // 1.5,1.5,2.5
var f = new Uint8Array([1,2,3,4,5]); f.copyWithin(-2,-3,-1); console.log(f.join(","));  // 1,2,3,3,4

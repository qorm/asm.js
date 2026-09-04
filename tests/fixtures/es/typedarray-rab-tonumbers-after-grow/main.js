var rab = new ArrayBuffer(4, { maxByteLength: 8 });
var ta = new Uint8Array(rab, 0);
rab.resize(0);
rab.resize(6);
ta[0] = 9;
var n = [];
for (var i = 0; i < ta.length; i++) n.push(ta[i]);
console.log(ta.length);
console.log(n.join(","));

var k = 12345678;
var o = {};
o[k] = 1;
if (o[k] !== 1) throw new Error("get");
if (o["12345678"] !== 1) throw new Error("str");
var C = class {
  get [k]() { return 2; }
  set [k](v) { this._v = v; }
};
var c = new C();
if (c[k] !== 2) throw new Error("acc get");
c[k] = 3;
if (c._v !== 3) throw new Error("acc set");
console.log("ok");

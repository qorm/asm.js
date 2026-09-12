var o = {};
o[Symbol.isConcatSpreadable] = true;
var r = [].concat(o);
print(String(r.length));
var poisoned = {};
poisoned[Symbol.isConcatSpreadable] = true;
Object.defineProperty(poisoned, "length", {
  get: function () { throw new Error("length"); }
});
var threw = 0;
try { [].concat(poisoned); } catch (e) { threw = 1; }
print(String(threw));

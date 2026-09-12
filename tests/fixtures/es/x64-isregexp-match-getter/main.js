function threw(fn) {
  try { fn(); print("no"); } catch (e) { print("threw"); }
}
var obj = {};
Object.defineProperty(obj, Symbol.match, {
  get: function () { throw new Error("g"); }
});
threw(function () { "".endsWith(obj); });
var re = /./;
Object.defineProperty(re, Symbol.match, {
  get: function () { throw new Error("g"); }
});
threw(function () { "".endsWith(re); });

"use strict";
try {
  "".includes(/./);
  print("includes-no-throw");
} catch (e) {
  print("includes=" + e.name);
}
var splitter = {};
splitter[Symbol.split] = function () { return ["via-split"]; };
var bad = {};
bad.toString = function () { throw new Error("receiver.toString"); };
try {
  print("split=" + String.prototype.split.call(bad, splitter)[0]);
} catch (e) {
  print("split-threw=" + e.name);
}
print("raw=" + String.raw({ raw: ["a", "b"] }, "X"));
var obj = { toString: function () { throw new Error("TOSTR"); } };
try {
  String.raw({ raw: ["a", "b", "c"] }, "", obj);
  print("raw-sub-no-throw");
} catch (e) {
  print("raw-sub=" + e.message);
}

"use strict";
function run() {
  var a = [10, 20, 30];
  print(a[1]);
  print(a[1 + 1]);
  var o = { k: 7 };
  print(o["k"]);
  var m = new Map();
  m.set("a", 1);
  print(m.size);
  print(Object.prototype.hasOwnProperty.call(o, "k"));
  print(o.hasOwnProperty("k"));
  print(parseInt("10", 16));
  print(String.fromCharCode(65, 66));
  print(Object.assign({ x: 1 }, { y: 2 }).y);
  print(Object.hasOwn(o, "k"));
  print(Number.isNaN(NaN));
}
run();

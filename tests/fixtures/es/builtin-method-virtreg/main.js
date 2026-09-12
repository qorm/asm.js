"use strict";
function run() {
  print("ab".charAt(1));
  print("a".concat("b", "c"));
  print("hello".slice(1, 4));

  var a = [1, 2];
  print(a.push(3, 4));
  print(a.join(","));
  print(a.at(1));
  print(a.indexOf(3));
  print(a.includes(4));
  print(a.lastIndexOf(2));

  var b = [0];
  print(b.push(1, 2, 3, 4, 5));
  print(b.join(","));

  var o = { arr: [0] };
  print(o.arr.push(1, 2, 3, 4, 5));
  print(o.arr.join(","));

  var t = new Uint8Array([5, 6, 7, 6]);
  print(t.join("-"));
  print(t.indexOf(6));
  print(t.includes(7));
  print(t.toString());
  print(t.at(2));
  print(t.lastIndexOf(6));
  print(t.reduce(function (s, x) { return s + x; }, 0));
  print(t.find(function (x) { return x === 7; }));
  print(t.find(function (x) { return x === this.v; }, { v: 6 }));
  t.fill(9, 1, 3);
  print(t[0] + "," + t[1] + "," + t[2] + "," + t[3]);
}
run();

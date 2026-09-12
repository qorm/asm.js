"use strict";
function run() {
  var m = new Map();
  m.set("a", 1);
  print(m.get("a"));
  print(m.has("a"));
  print(m.size);
  print(m.getOrInsert("b", 2));
  print(m.get("b"));
  var mout = [];
  m.forEach(function (v, k) { mout.push(k + ":" + v); });
  print(mout.join(","));

  var s = new Set();
  s.add(1);
  s.add(2);
  print(s.has(1));
  print(s.size);
  var u = s.union(new Set([2, 3]));
  print(u.has(3));
  print(u.size);
  var acc = 0;
  s.forEach(function (v) { acc += v; });
  print(acc);

  var d = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
  print(d.getUTCFullYear());
  print(d.getUTCMonth());
  print(d.getUTCDate());
  d.setUTCFullYear(2021);
  print(d.getUTCFullYear());
  print(d.setTime(0));

  print(Math.max(1, 3, 2));
  print(Math.min(1, 3, 2));
  print(Math.pow(2, 3));
  print(Math.atan2(0, 1));
  print(Math.imul(2, 4));
}
run();

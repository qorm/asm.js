"use strict";
function run() {
  function make() {
    return {
      join: function () { return "U"; },
      push: function (x) { return "P" + x; },
      m: function (a) { return this.n + a; }
    };
  }
  var o = make();
  print(o.join());
  print(o.push(3));
  o.n = 10;
  print(o.m(2));
  print(o["pop"] ? "no" : "ok");

  var a = [1, 2];
  print(a.push(3));
  print(a.join("-"));

  var m = new Map();
  m.set("k", 9);
  print(m.get("k"));
}
run();

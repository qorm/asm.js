"use strict";
function run() {
  try {
    throw 41;
  } catch (e) {
    print((function () { return e; })() + 1);
  }

  function make() {
    var n = 10;
    return function () { return n; };
  }
  print(make()());

  var fns = [];
  for (const x of [1, 2, 3]) {
    fns.push(function () { return x; });
  }
  print(fns[0]() + fns[1]() + fns[2]());

  var fors = [];
  for (let i = 0; i < 2; i = i + 1) {
    fors.push(function () { return i; });
  }
  print(fors[0]());
  print(fors[1]());

  class A {
    m() { return 7; }
  }
  class B extends A {
    m() { return super.m() + 1; }
  }
  print(new B().m());

  var k = "z";
  class C {
    [k]() { return 9; }
  }
  print(new C().z());

  function* g() {
    yield 3;
    yield 4;
  }
  var it = g();
  print(it.next().value);
  print(it.next().value);

  const ge = function* ng(a = 2) { yield a + 1; };
  print(ge().next().value);

  function* dg([x] = [7]) { yield x; }
  print(dg().next().value);
}
run();

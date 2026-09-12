"use strict";
var N = 2000;
function f(n) {
  if (n === 0) return 1;
  return f(n - 1);
}
if (f(N) !== 1) throw new Error("decl");
var fe = function g(n) {
  if (n === 0) return 2;
  return g(n - 1);
};
if (fe(N) !== 2) throw new Error("fe");
var o = {
  m: function (n) {
    if (n === 0) return 3;
    return this.m(n - 1);
  }
};
if (o.m(N) !== 3) throw new Error("method");
function h(n) {
  if (n === 0) return 4;
  try {
    throw 0;
  } catch (e) {
    return h(n - 1);
  }
}
if (h(N) !== 4) throw new Error("catch");
function c(n) {
  if (n === 0) return 5;
  return n ? c(n - 1) : 0;
}
if (c(N) !== 5) throw new Error("cond");
function a(n) {
  if (n === 0) return 6;
  return true && a(n - 1);
}
if (a(N) !== 6) throw new Error("and");
function nt(n) {
  if (n === 0) return 1;
  return nt(n - 1) + 0;
}
if (nt(40) !== 1) throw new Error("nontail");
console.log("ok");


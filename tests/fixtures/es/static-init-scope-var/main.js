var test262 = "outer scope";
var probe1, probe2;
class C {
  static {
    var test262 = "first block";
    probe1 = test262;
  }
  static {
    var test262 = "second block";
    probe2 = test262;
  }
}
if (test262 !== "outer scope") throw new Error("outer");
if (probe1 !== "first block") throw new Error("probe1");
if (probe2 !== "second block") throw new Error("probe2");
var probe;
class D {
  static {
    var test262 = "inner unused";
  }
  static {
    probe = test262;
  }
}
if (test262 !== "outer scope") throw new Error("close outer");
if (probe !== "outer scope") throw new Error("close probe");
console.log("ok");

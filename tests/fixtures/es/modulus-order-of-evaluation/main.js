function MyError() {}
var trace = "";
try {
  (function() { trace += "1"; throw new MyError(); })() %
    (function() { trace += "2"; throw new Error("no"); })();
} catch (e) { console.log(e.constructor.name); }
console.log(trace);
trace = "";
try {
  (function() {
    trace += "1";
    return { valueOf: function() { trace += "3"; throw new Error("no"); } };
  })() % (function() { trace += "2"; throw new MyError(); })();
} catch (e) { console.log(e.constructor.name); }
console.log(trace);

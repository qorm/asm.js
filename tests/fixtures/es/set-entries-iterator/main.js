var s = new Set([1, 2]);
var it = s.entries();
console.log(typeof it.next);
var n = it.next();
console.log(n.value[0] + ":" + n.value[1]);
var xs = [];
for (var x of [0, 1, 2].keys()) xs.push(x);
console.log(xs.join(","));
var ys = [];
for (var y of s.entries()) ys.push(y[0] + ":" + y[1]);
console.log(ys.join(","));
var zs = [];
var iterable = {};
iterable[Symbol.iterator] = function() {
  var j = 0;
  return {
    next: function() {
      j = j + 2;
      return { value: j, done: j === 8 };
    }
  };
};
for (var z of iterable) zs.push(z);
console.log(zs.join(","));
console.log(String(eval("var a; 1; for (a of [0]) { break; }")));
console.log(eval("var b; 2; for (b of [0]) { 3; break; }"));
console.log(String(eval("var a; 4; outer: do { for (a of [0]) { continue outer; } } while (false)")));
console.log(eval("var b; 5; outer: do { for (b of [0]) { 6; continue outer; } } while (false)"));

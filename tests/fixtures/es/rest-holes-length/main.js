function af(...a) { return a.length; }
if (af(1, undefined, 2) !== 3) throw new Error("direct");
if (af.call(null, 1, undefined, 2) !== 3) throw new Error("call");
if (af.apply(null, [1, , 2]) !== 3) throw new Error("apply");
if (af.apply(null, []) !== 0) throw new Error("empty");
if (af(1) !== 1) throw new Error("one");
function bf(x, ...a) {
  if (x !== 1) throw new Error("x");
  return a.length;
}
if (bf(1, undefined, 2) !== 2) throw new Error("bf");
console.log("ok");

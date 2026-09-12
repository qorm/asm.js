var count = 0;
var iterable = {};
iterable[Symbol.iterator] = function () {
  return {
    next: function () { return { value: [], done: false }; },
    return: function () { count += 1; }
  };
};
WeakMap.prototype.set = function () { throw new Error("setfail"); };
var threw = false;
try { new WeakMap(iterable); } catch (e) { threw = e.message === "setfail"; }
if (!threw) throw new Error("no throw");
if (count !== 1) throw new Error("close=" + count);
console.log("ok");

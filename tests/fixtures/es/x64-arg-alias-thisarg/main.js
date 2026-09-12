"use strict";
var ta = new Float64Array(1);
var got;
ta.find(function() { got = this; });
console.log(got === undefined);
try {
  new Float64Array(0).reduce(function() {});
  console.log("no-throw");
} catch (e) {
  console.log("threw");
}
var s1 = new Set([1, 2]);
var s2 = [1];
s2.size = 3;
s2.has = function() { return true; };
s2.keys = function() { throw "keys"; };
console.log(s1.isSupersetOf(s2));

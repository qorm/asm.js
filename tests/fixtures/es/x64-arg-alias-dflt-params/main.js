"use strict";
function f(aFalse, aString, aNaN, a0, aNull, aObj) {
  print(String(a0));
  print(String(aFalse));
  print(String(aString.length));
}
f(false, "x", 1, 0, null, {});
var rest;
({...rest} = "ab");
print(rest["0"]);
print(rest["1"]);
var ta = new Float64Array([40, 41, 42, 43]);
var sl = ta.slice(0);
print(String(sl[0]));
print(String(sl[1]));

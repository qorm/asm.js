"use strict";
function num() {
  var s = 0;
  s = s + 1.5;
  s = s * 2;
  s = s / 3;
  s = -s;
  return s;
}
print(num());

function accum() {
  var s = 0;
  for (var i = 0; i < 7; i++) s = s + i % 3;
  return s;
}
print(accum());

function objSub() {
  var s = 0;
  s = { valueOf: function () { return 10; } };
  return s - 1;
}
print(objSub());

function postInc() {
  var s = 1.5;
  s++;
  return s;
}
print(postInc());

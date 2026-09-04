var n = "outside";
var probeBefore = function() { return n; };
var probeInside;
var func = function n() {
  let n = "inside";
  probeInside = function() { return n; };
};
func();
console.log(probeBefore());
console.log(probeInside());

console.log("abc".toUpperCase.call("xyz"));
console.log("  hi  ".trim.call("  hi  "));
var a = [1];
[].push.apply(a, [4]);
console.log(a.join(","));

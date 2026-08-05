var a = [1, 2];
var f = a.push;
f.call(a, 9);
console.log(a.join(","));
var g = "".toUpperCase;
console.log(g.call("abc"));
var p = [].pop;
console.log(p.call([7, 8, 9]));

var toString = Object.prototype.toString;
var p = new Promise(function () {});
console.log(toString.call(p));
delete Promise.prototype[Symbol.toStringTag];
console.log(toString.call(p));
console.log(Promise.prototype[Symbol.toStringTag]);

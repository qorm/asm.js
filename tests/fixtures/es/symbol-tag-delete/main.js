var toString = Object.prototype.toString;
var set = new Set();
delete Set.prototype[Symbol.toStringTag];
print(toString.call(set));

// T2a 边界:替换已有方法值(更新键,键集不变)→ 调用见新值
class P { m() { return 1; } }
const o = new P();
console.log(o.m());
P.prototype.m = function () { return 2; };
console.log(o.m());
const o2 = new P();
console.log(o2.m());

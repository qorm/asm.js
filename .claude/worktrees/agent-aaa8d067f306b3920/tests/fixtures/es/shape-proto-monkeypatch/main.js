// T2a 反例安全:猴子补丁加键 → 形状失效退化,新旧方法都正确
class P { old() { return "old"; } }
const o = new P();
console.log(o.old());
P.prototype.added = function () { return "added"; };
console.log(o.added(), o.old());
P.prototype.another = function () { return 42; };
console.log(o.another());

// T2a 边界:defineProperty。注:Object.defineProperty 对**已有数据键**的 {value}
// 重定义不生效是既有引擎 bug(改前产物同样错,属 plan.md S2 编译器债务),本 fixture
// 仅覆盖可用的:新键定义(加键 → 形状失效退化)与 accessor 重定义(getter 生效)。
class P { m() { return 1; } n() { return "n"; } }
const o = new P();
console.log(o.m(), o.n());
Object.defineProperty(P.prototype, "extra", { value: function () { return "x"; } });
console.log(o.extra());
Object.defineProperty(P.prototype, "n", { get: function () { return "got"; } });
console.log(o.n);

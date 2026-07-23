// T2a 反例资格:计算键方法 → 不赋形(退化 v1),功能不变
const key = "dyn";
class P {
    [key]() { return "computed"; }
    normal() { return "normal"; }
}
const o = new P();
console.log(o.dyn(), o.normal());

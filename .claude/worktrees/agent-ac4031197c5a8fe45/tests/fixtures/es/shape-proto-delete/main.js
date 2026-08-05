// T2a 反例安全:删方法 → 形状失效,读取语义正确(undefined)
class P { keep() { return "k"; } drop() { return "d"; } }
const o = new P();
console.log(o.keep(), o.drop());
delete P.prototype.drop;
console.log(o.keep(), o.drop);

// T2a 正向:类方法读/调用 + prototype.constructor
class P {
    m1() { return 1; }
    m2() { return 2; }
}
const o = new P();
console.log(o.m1(), o.m2());
console.log(typeof P.prototype.m1);
console.log(o.constructor === P);
console.log(P.prototype.hasOwnProperty("m2"));

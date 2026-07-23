// T2a 正向:三层继承链方法解析 + 覆写(深链委托路径不回归)
class A { who() { return "A"; } shared() { return "a-shared"; } }
class B extends A { who() { return "B"; } bOnly() { return "b"; } }
class C extends B { cOnly() { return "c"; } }
const c = new C();
console.log(c.who(), c.shared(), c.bOnly(), c.cOnly());
const b = new B();
console.log(b.who(), b.shared(), b.bOnly());
console.log(c instanceof B, c instanceof A);

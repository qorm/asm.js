// Object-literal shorthand methods created inside a function must use DYNAMIC this
// (the receiver), not capture the enclosing scope's this like an arrow.
function make(v) { return { i: v, read() { return this.i; }, add(n) { return this.i + n; } }; }
var a = make(1);
var b = make(2);
console.log(a.read(), b.read(), a.read());
console.log(make(9).read());
console.log(b.add(100));
// arrow inside a method STILL captures lexical this (unchanged)
class C { constructor() { this.x = 5; } getFn() { return () => this.x; } }
console.log(new C().getFn()());
// nested factory
var factory = { build(v) { return { v: v, get() { return this.v; } }; } };
console.log(factory.build(77).get());

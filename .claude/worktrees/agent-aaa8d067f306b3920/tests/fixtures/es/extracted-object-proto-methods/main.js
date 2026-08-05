// Object.prototype.<m> extracted as a VALUE yields a receiver-unbound callable
// (Stage-A builtin method-ref closure): t.call(x) dispatches with x as receiver.
const t = Object.prototype.toString;
console.log(t.call([]) + " " + t.call({}) + " " + t.call("s") + " " + t.call(5)); // brands

const h = Object.prototype.hasOwnProperty;
console.log("hop " + h.call({ k: 1 }, "k") + " " + h.call({}, "k")); // true false

const v = Object.prototype.valueOf;
const o = { a: 1 };
console.log("valueOf " + (v.call(o) === o)); // true

const pe = Object.prototype.propertyIsEnumerable;
console.log("pie " + pe.call({ k: 1 }, "k") + " " + pe.call({}, "k")); // true false

const ip = Object.prototype.isPrototypeOf;
const base = {};
const child = Object.create(base);
console.log("ipo " + ip.call(base, child) + " " + ip.call(child, base)); // true false
// direct form was SIGSEGV on arm64 (bare and with no-op mask load) -- fixed
console.log("ipo-direct " + base.isPrototypeOf(child)); // true
class A { } class B extends A { }
const b = new B();
console.log("ipo-class " + A.prototype.isPrototypeOf(b)); // true

// typeof + apply + passing as value
console.log("typeof " + typeof t); // function
console.log("apply " + t.apply([])); // [object Array]
function inv(f, x) { return f.call(x); }
console.log("cb " + inv(t, [])); // [object Array]

// direct forms unaffected
console.log("direct " + Object.prototype.toString.call([]) + " " + Object.prototype.hasOwnProperty.call({ a: 1 }, "a"));
// the classic
function args3() { return [].slice.call(arguments); }
console.log("slice " + JSON.stringify(args3(1, 2, 3)));

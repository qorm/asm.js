class D { constructor(a, b) { this.a = a; this.b = b; } }
const d = Reflect.construct(D, [5, 9]);
console.log(d.a, d.b, d instanceof D);
const desc = Reflect.getOwnPropertyDescriptor({ k: 42 }, "k");
console.log(desc.value, desc.enumerable, desc.writable);
const missing = Reflect.getOwnPropertyDescriptor({}, "nope");
console.log(missing === undefined);
console.log(Reflect.apply(Math.max, null, [1, 5, 3]));
console.log(JSON.stringify(Reflect.ownKeys({ a: 1, b: 2 })));

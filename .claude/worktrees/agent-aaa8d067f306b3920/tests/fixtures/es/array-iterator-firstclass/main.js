// First-class array iterators: values()/keys()/entries()/[Symbol.iterator]()
// return a real iterator object with a stateful next() (not just a plain array).
const a = [10, 20, 30];
const v = a.values();
console.log(typeof v, typeof v.next);
console.log(JSON.stringify(v.next()));
console.log(JSON.stringify(v.next()));
console.log(JSON.stringify(v.next()));
console.log(JSON.stringify(v.next())); // exhausted
// keys
const k = a.keys();
console.log(JSON.stringify(k.next()), JSON.stringify(k.next()));
// entries
console.log(JSON.stringify(a.entries().next().value));
// Symbol.iterator
const it = a[Symbol.iterator]();
console.log(JSON.stringify(it.next()));
// still spreadable / for-of-able / Array.from-able
console.log([...a.values()].join(","));
console.log([...a.keys()].join(","));
console.log(JSON.stringify([...a.entries()]));
let s = 0; for (const x of a.values()) s += x; console.log(s);
console.log(Array.from(a.keys()).join(","));
let t = 0; for (const y of a[Symbol.iterator]()) t += y; console.log(t);

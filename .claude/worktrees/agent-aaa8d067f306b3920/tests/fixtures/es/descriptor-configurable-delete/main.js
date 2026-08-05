// configurable:false blocks delete (returns false, property stays); frozen/sealed
// objects reject delete; Reflect.preventExtensions / Reflect.isExtensible.
var o = {};
Object.defineProperty(o, "x", { value: 1, configurable: false });
console.log(delete o.x, o.x, "x" in o);              // false 1 true
Object.defineProperty(o, "y", { value: 2, configurable: true });
console.log(delete o.y, "y" in o);                    // true false
// frozen / sealed reject delete
var fr = Object.freeze({ a: 1 });
console.log(delete fr.a, fr.a);                        // false 1
var se = Object.seal({ b: 2 });
console.log(delete se.b, se.b);                        // false 2
// preventExtensions still allows delete of existing props
var pe = { c: 3 };
Object.preventExtensions(pe);
console.log(delete pe.c, "c" in pe);                  // true false
// plain object delete unaffected
var p = { m: 1, n: 2 };
console.log(delete p.m, Object.keys(p).join(","));    // true n
console.log(delete p.zzz);                            // true (absent)
// Reflect.preventExtensions returns true and prevents extension
var r = {};
console.log(Reflect.preventExtensions(r), Reflect.isExtensible(r)); // true false
var r2 = {};
console.log(Reflect.isExtensible(r2));                // true

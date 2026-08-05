// class-body [Symbol.iterator] / [Symbol.asyncIterator] methods are found by
// for-of / spread / for-await (stored under the same string key object literals use).
class R {
  [Symbol.iterator]() {
    let i = 0;
    return { next() { return i < 3 ? { value: i++, done: false } : { value: undefined, done: true }; } };
  }
}
for (const x of new R()) console.log("of", x);
console.log("spread", [...new R()].join(","));
console.log("hasit", typeof (new R())[Symbol.iterator]);

class A {
  [Symbol.asyncIterator]() {
    let i = 10;
    return { next() { return Promise.resolve(i < 13 ? { value: i++, done: false } : { value: undefined, done: true }); } };
  }
}
async function main() {
  for await (const x of new A()) console.log("await", x);
}
main();

// hasInstance still routes via symbol key (unchanged)
class C { static [Symbol.hasInstance](x) { return x === 42; } }
console.log("inst", 42 instanceof C, 7 instanceof C);

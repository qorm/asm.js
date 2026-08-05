async function main() {
  // hand-rolled async iterable (coordinator's pattern): this.i inside next()
  const obj = {
    [Symbol.asyncIterator]() {
      return { i: 0, next() { return Promise.resolve(this.i < 3 ? { value: this.i++, done: false } : { done: true }); } };
    }
  };
  for await (const x of obj) console.log("async", x);
  // closure-based async iterable
  const gen = { [Symbol.asyncIterator]() { let n = 0; return { next() { return Promise.resolve(n < 3 ? { value: n++ * 10, done: false } : { done: true }); } }; } };
  for await (const y of gen) console.log("gen", y);
  // Phase-1 fallback preserved: no Symbol.asyncIterator -> sync iterable + await element
  for await (const z of [Promise.resolve(100), 200]) console.log("p1", z);
  // break + destructure over an async iterable
  const pairs = { [Symbol.asyncIterator]() { let k = 0; const data = [[1, "a"], [2, "b"], [3, "c"]]; return { next() { return Promise.resolve(k < data.length ? { value: data[k++], done: false } : { done: true }); } }; } };
  for await (const [n, s] of pairs) { if (n === 3) break; console.log("pair", n, s); }
}
main();

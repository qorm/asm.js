async function main() {
  // promise array: each element awaited
  for await (const x of [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]) {
    console.log(x);
  }
  // sync iterable of plain values
  for await (const y of [10, 20, 30]) { console.log(y); }
  // break / continue
  let sum = 0;
  for await (const n of [1, 2, 3, 4, 5]) {
    if (n === 2) continue;
    if (n === 4) break;
    sum += n;
  }
  console.log("sum", sum);
  // destructure awaited value
  for await (const [k, v] of [Promise.resolve([1, "a"]), Promise.resolve([2, "b"])]) {
    console.log(k, v);
  }
  // Set (sync iterable) + mixed promise/non-promise
  for await (const s of new Set([7, 8])) { console.log("set", s); }
  const out = [];
  for await (const m of [Promise.resolve(100), 200, Promise.resolve(300)]) { out.push(m); }
  console.log(out.join(","));
  // rejection propagates to catch
  try {
    for await (const r of [Promise.resolve(1), Promise.reject("boom")]) { console.log("got", r); }
  } catch (e) { console.log("caught", e); }
}
main();

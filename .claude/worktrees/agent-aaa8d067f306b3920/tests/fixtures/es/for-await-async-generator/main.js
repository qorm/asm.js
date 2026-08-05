// for await over an async generator that AWAITS internally, + a manual next-chain.
function p(v) { return Promise.resolve(v); }

async function* g() {
  yield 1;
  const x = await p(10);   // internal await between yields
  yield x + 1;             // 11
  await p(0);
  yield 3;
}

(async () => {
  let sum = 0;
  for await (const v of g()) sum += v;   // drive via for-await; must drain internal awaits
  console.log("forawait sum " + sum);    // 15

  // manual next-chain over a fresh async-gen with internal await
  const it = g();
  const r1 = await it.next(); console.log("m " + r1.value + " " + r1.done);  // 1 false
  const r2 = await it.next(); console.log("m " + r2.value + " " + r2.done);  // 11 false
  const r3 = await it.next(); console.log("m " + r3.value + " " + r3.done);  // 3 false
  const r4 = await it.next(); console.log("m " + r4.value + " " + r4.done);  // undefined true
})();

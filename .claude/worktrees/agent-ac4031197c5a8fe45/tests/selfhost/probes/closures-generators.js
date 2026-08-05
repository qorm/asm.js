function counter() { let n = 0; return () => ++n; }
const c = counter();
function* fib() { let a = 0, b = 1; while (true) { yield a; const t = a + b; a = b; b = t; } }
const g = fib(); const out = [];
for (let i = 0; i < 8; i++) out.push(g.next().value);
const adders = [1, 2, 3].map(i => x => x + i);
const ok = c() === 1 && c() === 2 && out.join(",") === "0,1,1,2,3,5,8,13" &&
    adders[0](10) === 11 && adders[2](10) === 13 &&
    [...(function* () { yield* [1, 2]; yield* [3, 4]; })()].join(",") === "1,2,3,4";
console.log(ok ? "closures-gen-ok" : "closures-gen-FAIL");

// Generational write-barrier regression: unshift/splice/fill store young objects
// into arrays that may be old-generation. Allocate garbage between store and read
// so a GC runs in between; the stored objects must survive (barrier records the array).
function churn(n) { let a = []; for (let i = 0; i < n; i++) a.push({ v: i, s: "g" + i }); return a.length; }

let ua = [{ base: 1 }];
churn(40000);
ua.unshift({ marker: 111111, tag: "unshift-canary" });
churn(40000);
console.log(ua[0].marker, ua[0].tag, ua.length);

let sa = [{ base: 2 }, { base: 3 }];
churn(40000);
sa.splice(1, 0, { marker: 222222, tag: "splice-canary" });
churn(40000);
console.log(sa[1].marker, sa[1].tag, sa.length);

let fa = [0, 0, 0];
churn(40000);
fa.fill({ marker: 333333, tag: "fill-canary" });
churn(40000);
console.log(fa[0].marker, fa[2].tag, fa.length);

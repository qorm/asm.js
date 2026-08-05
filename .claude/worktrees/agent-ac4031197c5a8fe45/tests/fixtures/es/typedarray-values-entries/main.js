const ta = new Int32Array([10, 20, 30]);
console.log([...ta.values()].join(","));
console.log(JSON.stringify([...ta.entries()]));
console.log([...ta.keys()].join(","));
let s = 0; for (const v of ta.values()) s += v; console.log(s);
// unknown-static (captured in a closure)
console.log((() => [...ta.values()].join(","))());
console.log((() => JSON.stringify([...ta.entries()]))());
const u = new Uint8Array([1, 2, 3]);
console.log([...u.values()].join(","), JSON.stringify([...u.entries()]));

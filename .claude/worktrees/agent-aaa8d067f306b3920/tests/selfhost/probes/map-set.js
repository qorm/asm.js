const m = new Map([["a", 1], ["b", 2]]); m.set("c", 3);
const s = new Set([1, 2, 2, 3]);
const m2 = new Map(); m2.set(NaN, "nan");
const entries = [...m.entries()].map(e => e.join("=")).join(",");
const ok = m.size === 3 && m.get("b") === 2 && s.size === 3 && [...s].join(",") === "1,2,3" &&
    m2.get(NaN) === "nan" && entries === "a=1,b=2,c=3";
console.log(ok ? "map-set-ok" : "map-set-FAIL");

function sum(...a) { return a.reduce((s, x) => s + x, 0); }
const arr = [1, 2, 3];
function F(...args) { this.n = args.length; }
const a1 = [3]; a1.unshift(...[1, 2]);
const ok = sum(...arr) === 6 && sum(0, ...arr, 4) === 10 && Math.max(...arr) === 3 &&
    [...arr, 4, ...[5, 6]].join(",") === "1,2,3,4,5,6" &&
    [].concat(...[[1], [2], [3]]).join(",") === "1,2,3" &&
    new F(...arr).n === 3 && a1.join(",") === "1,2,3";
console.log(ok ? "spread-forms-ok" : "spread-forms-FAIL");

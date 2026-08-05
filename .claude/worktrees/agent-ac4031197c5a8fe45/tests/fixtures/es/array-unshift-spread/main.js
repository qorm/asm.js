const a = [3]; console.log(a.unshift(...[1, 2]), a.join(","));
const b = [9]; console.log(b.unshift(...[]), b.join(","));
const c = [5]; c.unshift(0, ...[1, 2], 3); console.log(c.join(","));
const d = [3, 4]; const ref = d; d.unshift(...[1, 2]); console.log(ref.join(","));
const e = []; e.unshift(...["x", "y", "z"]); console.log(e.join("-"));

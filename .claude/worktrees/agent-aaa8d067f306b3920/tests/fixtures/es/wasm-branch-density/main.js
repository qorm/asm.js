// Stresses conditional-branch emission (jlt/jle/jgt/jge/jeq/jne, float compares,
// jnan, labeled break/continue). On wasm32 these lower to `set pc; <cmp>; br_if`
// (no if/end wrapper) — this fixture guards that path against regression.
function classify(n) {
    if (n < 0) return "neg";
    if (n === 0) return "zero";
    if (n <= 10) return "small";
    if (n < 100) return "mid";
    return "big";
}
let out = [];
for (let i = -2; i <= 3; i++) out.push(classify(i * i * 40));
console.log(out.join(","));

// float comparisons + NaN branch
function fcheck(x) {
    if (x !== x) return "nan";
    if (x < 0.5) return "lo";
    if (x >= 2.5) return "hi";
    return "mid";
}
console.log(fcheck(0.1), fcheck(1.0), fcheck(3.14), fcheck(0 / 0));

// labeled loop: break/continue crossing nested loops
let acc = [];
outer: for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
        if (j === 2) continue outer;
        if (i === 3) break outer;
        acc.push(i * 10 + j);
    }
}
console.log(acc.join(","));

// tight numeric loop with mixed signed compares
let s = 0;
for (let i = 0; i < 200; i++) {
    if (i % 7 === 0) s += i;
    else if (i > 150) s -= 1;
    else if (i % 2 === 0) s += 2;
}
console.log(s);

// while + float accumulation until threshold
let x = 100.0, steps = 0;
while (x > 1.0) { x = x / 1.7; steps++; }
console.log(steps, x < 1.0);

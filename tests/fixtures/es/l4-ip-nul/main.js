// L4 positive: in-place append is NUL-transparent (length-based copy, not strlen).
// NUL enters via String.fromCharCode(0); template suffix keeps the gated IP path,
// so both suffix and (from round 2) the old string carry embedded NUL.
// (Source \0 escapes avoided: lexer drops them — frozen debt, plan.md S5.)
let z = String.fromCharCode(0);
let s = "a";
for (let i = 0; i < 4; i++) s = s + `${z}b`;   // IP append, NUL in suffix and old string
console.log(s.length, s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(8));
let t = "q";
for (let i = 0; i < 3; i++) t = t + z;          // NUL suffix via variable (runtime path)
console.log(t.length, t.charCodeAt(1));

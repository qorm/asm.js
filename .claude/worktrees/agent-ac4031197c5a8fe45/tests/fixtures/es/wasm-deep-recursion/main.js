// Deep recursion regression: pre-M4 the wasm shadow stack was only ~4MB
// (top 0x400000), overflowing near ~600 frames while native handled ~1200.
// Enlarging the shadow stack to [ARGV_BASE, DATA_BASE) ≈ 16MB lets wasm match
// native. Depth 800 sits inside both targets' limits.
function sumTo(n, acc) { if (n === 0) return acc; return sumTo(n - 1, acc + n); }
console.log(sumTo(800, 0));
function depth(n) { if (n === 0) return 0; const local = n * 2; return depth(n - 1) + (local - local); }
console.log(depth(800));

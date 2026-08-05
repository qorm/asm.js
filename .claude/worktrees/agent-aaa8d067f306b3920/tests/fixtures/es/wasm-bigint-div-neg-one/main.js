// Regression: wasm i64.div_s(x, -1) previously routed straight to div_s, which
// traps on INT64_MIN/-1 ("divide result unrepresentable"). arm64 sdiv wraps
// (x / -1 == -x for all x). The wasm backend now special-cases divisor -1 as
// 0 - x. These clean values exercise that branch.
console.log(10n / -1n);
console.log(-10n / -1n);
console.log(0n / -1n);
console.log(9223372036854775807n / -1n);
console.log(-9223372036854775807n / -1n);
console.log(42n / -1n, 1000000n / -1n);

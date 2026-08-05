// Exercises code-address (a64) constants: function pointers stored in closures,
// higher-order dispatch through function values, deep recursion (call return
// addresses), and indirect method calls. On wasm32 these lower to i64.const of
// CODE_BASE+labelIdx (lea) and return-address constants, now emitted as 5-byte
// sleb (all wasm32 addresses < 2^32 fit). Guards that narrowing. native==wasm.

// function values passed around and stored -> lea of code addresses
function add(a, b) { return a + b; }
function mul(a, b) { return a * b; }
function sub(a, b) { return a - b; }
const ops = { "+": add, "*": mul, "-": sub };
function apply(name, a, b) { return ops[name](a, b); }
console.log("ops", apply("+", 3, 4), apply("*", 3, 4), apply("-", 10, 4));

// higher-order: map/filter/reduce with function-value callbacks
const nums = [1, 2, 3, 4, 5, 6, 7, 8];
const doubled = nums.map(function (x) { return x * 2; });
const evens = nums.filter(function (x) { return x % 2 === 0; });
const total = nums.reduce(function (a, x) { return a + x; }, 0);
console.log("hof", doubled.join(","), evens.join(","), total);

// closures capturing and returning function pointers
function counter(start) {
    let n = start;
    return { inc: function () { return ++n; }, get: function () { return n; } };
}
const c = counter(10);
c.inc(); c.inc(); c.inc();
console.log("closure", c.get());

// deep recursion -> many call/return address constants
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
function sum(n) { return n === 0 ? 0 : n + sum(n - 1); }
console.log("recur", fib(20), sum(500));

// mutual recursion + indirect dispatch table
function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
function isOdd(n) { return n === 0 ? false : isEven(n - 1); }
console.log("parity", isEven(100), isOdd(100));

// array of function pointers dispatched in a loop
const table = [add, mul, sub, add, mul];
let acc = 0;
for (let i = 0; i < table.length; i++) acc += table[i](i + 1, 2);
console.log("table", acc);

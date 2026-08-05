// [dialect] uncaught exception in a spawned coroutine = panic: print + exit 1 (Go spirit).
function boom() { throw new Error("die"); }
js boom();
console.log("main-ran");

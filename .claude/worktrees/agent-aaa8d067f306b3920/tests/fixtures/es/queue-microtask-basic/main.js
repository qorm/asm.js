console.log("sync");
queueMicrotask(() => {
    console.log("micro");
});
console.log("after");

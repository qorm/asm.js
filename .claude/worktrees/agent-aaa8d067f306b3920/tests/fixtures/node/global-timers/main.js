const cancelled = setTimeout(() => console.log("cancelled"), 0);
clearTimeout(cancelled);
setTimeout(() => console.log("timeout fired"), 100);
queueMicrotask(() => console.log("microtask fired"));
console.log("sync done");

import timers from "node:timers";

console.log("sync");

queueMicrotask(() => {
    console.log("micro");
});

timers.setImmediate(() => {
    console.log("immediate");
});

timers.setTimeout(() => {
    console.log("timeout");
}, 0);

console.log("after");

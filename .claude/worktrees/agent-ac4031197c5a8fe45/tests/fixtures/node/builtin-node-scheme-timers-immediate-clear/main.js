import timers from "node:timers";

console.log("sync");
const handle = timers.setImmediate(() => {
    console.log("immediate");
});
timers.clearImmediate(handle);
timers.setImmediate(() => {
    console.log("after");
});

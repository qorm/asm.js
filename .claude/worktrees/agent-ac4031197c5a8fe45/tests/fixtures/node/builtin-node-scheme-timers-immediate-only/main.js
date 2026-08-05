import timers from "node:timers";

console.log("sync");

timers.setImmediate(() => {
    console.log("immediate");
});

import timers from "node:timers";

console.log("sync");

const timeout = timers.setTimeout(() => {
    console.log("timeout");
}, 0);

timers.clearTimeout(timeout);

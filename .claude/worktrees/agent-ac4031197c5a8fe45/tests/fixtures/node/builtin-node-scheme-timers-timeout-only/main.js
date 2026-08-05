import timers from "node:timers";

console.log("sync");

timers.setTimeout(() => {
    console.log("timeout");
}, 0);

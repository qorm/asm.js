import timers from "node:timers";

console.log("sync");
const handle = timers.setTimeout(() => {}, 0);
console.log(typeof handle);

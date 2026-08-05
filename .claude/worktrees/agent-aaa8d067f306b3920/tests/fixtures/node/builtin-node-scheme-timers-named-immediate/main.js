import { setImmediate } from "node:timers";

console.log("sync");

setImmediate(() => {
    console.log("immediate");
});

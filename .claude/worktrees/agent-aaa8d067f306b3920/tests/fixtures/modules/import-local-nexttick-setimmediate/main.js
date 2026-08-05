import { setImmediate } from "./timers.js";

console.log("sync");

setImmediate(() => {
    console.log("immediate");
});

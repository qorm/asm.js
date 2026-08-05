import { setTimeout } from "./timers.js";

console.log("sync");

setTimeout(() => {
    console.log("timeout");
}, 0);

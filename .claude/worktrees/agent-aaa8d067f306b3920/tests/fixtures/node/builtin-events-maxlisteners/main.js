import { EventEmitter } from "node:events";
console.log(EventEmitter.defaultMaxListeners);
const e = new EventEmitter();
console.log(e.getMaxListeners());
const log = [];
e.prependListener("x", () => log.push("pre"));
e.on("x", () => log.push("post"));
e.emit("x");
console.log(log.join(","));

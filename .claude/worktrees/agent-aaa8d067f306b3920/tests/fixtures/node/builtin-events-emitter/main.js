import { EventEmitter } from "node:events";

const e = new EventEmitter();
const log = [];
const fa = (a, b) => log.push("a:" + a + "," + b);
e.on("x", fa);
e.emit("x", 1, 2);
console.log(log.join("|"));
console.log(e.listenerCount("x"));
e.off("x", fa);
console.log(e.listenerCount("x"));
e.emit("x", 9, 9);
console.log(log.join("|"));
let n = 0;
e.once("y", () => { n++; });
e.emit("y");
e.emit("y");
console.log(n);
console.log(e.eventNames().length);

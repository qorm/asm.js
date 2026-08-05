import { EventEmitter, once, getEventListeners } from "node:events";

const e = new EventEmitter();

// prependOnceListener ordering + once removal
const order = [];
e.on("y", () => order.push("a"));
e.prependOnceListener("y", () => order.push("b"));
e.emit("y");
e.emit("y");
console.log(order.join(","));

// emit('error') with no listener throws
try {
  e.emit("error", new Error("boom"));
  console.log("no throw");
} catch (err) {
  console.log("threw " + err.message);
}

// removeListener matches the original listener through a once wrapper
const fn = () => console.log("should-not-fire");
e.once("z", fn);
e.removeListener("z", fn);
console.log("z count " + e.listenerCount("z"));

// standalone once() resolves synchronously with the emitted args array
const e2 = new EventEmitter();
const p = once(e2, "data");
e2.emit("data", 1, 2);
p.then((args) => console.log("once " + args[0] + "," + args[1]));

// getEventListeners
console.log("listeners " + getEventListeners(e, "y").length);

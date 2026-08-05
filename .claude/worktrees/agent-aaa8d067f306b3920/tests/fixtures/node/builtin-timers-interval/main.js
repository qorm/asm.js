import { setInterval, clearInterval, setImmediate } from "node:timers";

// setInterval that clears itself after 3 ticks (accumulates a result).
let n = 0;
const acc = [];
const id = setInterval(() => {
  n++;
  acc.push(n);
  if (n >= 3) {
    clearInterval(id);
    // setImmediate still runs after the interval is cleared.
    setImmediate(() => console.log("interval:" + acc.join(",") + " then:immediate"));
  }
}, 5);

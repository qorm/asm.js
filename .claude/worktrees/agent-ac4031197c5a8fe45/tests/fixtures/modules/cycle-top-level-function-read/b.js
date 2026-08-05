import { ping } from "./a.js";

export function pong() {
    return ping();
}

console.log(typeof ping);

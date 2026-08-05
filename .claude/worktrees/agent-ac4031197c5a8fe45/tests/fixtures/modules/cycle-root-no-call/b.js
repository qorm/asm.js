import { ping } from "./a.js";

export function pong() {
    return ping() + 1;
}

import { value as first } from "./counter.js";

console.log(first);
import("./counter.js").then(function(ns) {
    console.log(ns.value);
});

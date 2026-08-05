import payload, { answer, label } from "type-module-cjs-entry";
import * as ns from "type-module-cjs-entry";

console.log(payload.answer);
console.log(answer);
console.log(label);
console.log(ns.answer);
console.log(ns === payload);
console.log(ns.default === payload);

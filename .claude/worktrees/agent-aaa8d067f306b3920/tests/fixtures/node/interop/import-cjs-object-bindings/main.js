import payload, { answer, label } from "./dep.cjs";
import * as ns from "./dep.cjs";

print(payload.answer);
print(answer);
print(label);
print(ns.answer);
print(ns === payload);
print(ns.default === payload);

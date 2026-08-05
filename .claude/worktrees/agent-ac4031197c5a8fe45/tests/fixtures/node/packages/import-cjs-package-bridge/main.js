import pkg, { answer, label } from "interop-cjs-pkg";
import * as ns from "interop-cjs-pkg";

print(pkg.answer);
print(answer);
print(label);
print(ns.answer);
print(ns === pkg);
print(ns.default === pkg);

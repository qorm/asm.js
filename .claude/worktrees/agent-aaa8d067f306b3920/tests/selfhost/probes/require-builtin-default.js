// Self-host probe: require(builtin) must return the DEFAULT export (module.exports),
// not the "*" namespace. Regressed only in the self-compiled compiler (g1) when
// module paths resolved relatively and _requireExportKind's "/runtime/node/" prefix
// check missed them -> events/util came back as namespace objects -> new EE() crashed.
const EE = require("events");
const e = new EE();
let got = 0;
e.on("x", function (v) { got = v; });
e.emit("x", 42);
const util = require("util");
if (got === 42 && typeof util.format === "function") {
    console.log("require-default-ok");
} else {
    console.log("require-default-FAIL");
}

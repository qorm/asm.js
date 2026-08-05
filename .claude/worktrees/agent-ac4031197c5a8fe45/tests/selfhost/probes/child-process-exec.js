const { execSync } = require("child_process");
const out = execSync("echo probe", { encoding: "utf8" }).trim();
let threw = false, status = 0;
try { execSync("exit 4"); } catch (e) { threw = true; status = e.status; }
console.log((out === "probe" && threw && status === 4) ? "child-exec-ok" : "child-exec-FAIL");

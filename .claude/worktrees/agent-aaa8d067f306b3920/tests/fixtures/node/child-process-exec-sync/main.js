const { execSync, spawnSync } = require("child_process");
// stdout capture as string
console.log(JSON.stringify(execSync("echo hi", { encoding: "utf8" })));
// default returns a Buffer; .toString() decodes
console.log(execSync("printf 'a-b-c'").toString());
// non-zero exit throws with .status
try {
  execSync("exit 7");
  console.log("no throw");
} catch (e) {
  console.log("threw status " + e.status);
}
// spawnSync: args stay separate, status + stdout captured
const r = spawnSync("echo", ["one", "two"], { encoding: "utf8" });
console.log("spawn " + r.status + " " + JSON.stringify(r.stdout));

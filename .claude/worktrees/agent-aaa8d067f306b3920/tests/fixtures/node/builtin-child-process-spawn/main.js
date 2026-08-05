import { spawn, exec } from "node:child_process";

// spawn: collect stdout via 'data', report on 'exit' with exit code.
const child = spawn("echo", ["one", "two", "three"]);
let out = "";
child.stdout.on("data", (d) => { out += String(d); });
child.on("exit", (code) => {
  console.log("spawn:" + out.replace(/\n/g, "") + " code:" + code);

  // exec (sequenced after spawn finishes) with callback -> string stdout.
  exec("printf 'x-y-z'", (err, stdout, stderr) => {
    console.log("exec:" + String(stdout) + " err:" + (err ? "y" : "n"));

    // a failing command surfaces a non-null error in the callback.
    exec("exit 3", (e2) => {
      console.log("fail-err:" + (e2 ? "y" : "n"));
    });
  });
});

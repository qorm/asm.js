import fs from "node:fs/promises";
import syncFs from "node:fs";

const path = "/tmp/asmjs-builtin-node-scheme-fs-promises.txt";
const input = "fixture-ok";

async function main() {
  try {
    syncFs.unlinkSync(path);
  } catch {}

  const probeFd = syncFs.openSync(path, "w");
  if (probeFd < 0) {
    console.log("openSync");
    console.log(probeFd);
    console.log("existsSync");
    console.log(syncFs.existsSync(path));
    return;
  }

  syncFs.closeSync(probeFd);
  await fs.writeFile(path, input);
  const output = await fs.readFile(path, "utf8");

  console.log(typeof fs.writeFile);
  console.log(typeof fs.readFile);
  if (output === input) {
    console.log("fixture-ok");
  }

  try {
    syncFs.unlinkSync(path);
  } catch {}
}

main();

import { setTimeout as delay, setImmediate as immediate } from "node:timers/promises";

async function main() {
  console.log("start");
  const v = await delay(0, "delayed");
  console.log(v);
  const w = await immediate("immediate");
  console.log(w);
  console.log("end");
}
main();

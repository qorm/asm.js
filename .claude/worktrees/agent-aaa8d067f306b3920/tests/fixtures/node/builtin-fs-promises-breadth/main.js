import fsp from "node:fs/promises";

async function main() {
  const dir = "/tmp/asmjs_fx_fsp_breadth";
  try { await fsp.unlink(dir + "/a.txt"); } catch {}
  try { await fsp.rmdir(dir); } catch {}

  await fsp.mkdir(dir);
  await fsp.writeFile(dir + "/a.txt", "promise data");
  const content = await fsp.readFile(dir + "/a.txt", "utf8");
  console.log(content);
  console.log(content === "promise data");
  await fsp.unlink(dir + "/a.txt");
  await fsp.rmdir(dir);
  console.log("ok");
}
main();

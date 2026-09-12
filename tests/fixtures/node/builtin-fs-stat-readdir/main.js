import { readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";

const dir = "/tmp/asmjs_fx_stat_readdir_" + process.pid;
try { unlinkSync(dir + "/a.txt"); } catch (_e) {}
try { rmdirSync(dir); } catch (_e) {}
mkdirSync(dir);
writeFileSync(dir + "/a.txt", "hi");
const names = readdirSync(dir);
console.log(names.indexOf("a.txt") >= 0);
const st = statSync(dir + "/a.txt");
console.log(st.isFile());
console.log(st.isDirectory());
const dst = statSync(dir);
console.log(dst.isDirectory());
unlinkSync(dir + "/a.txt");
rmdirSync(dir);
console.log("ok");

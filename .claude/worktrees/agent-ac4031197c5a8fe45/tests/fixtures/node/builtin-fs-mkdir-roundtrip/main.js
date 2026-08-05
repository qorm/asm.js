import fs from "node:fs";

const dir = "/tmp/asmjs_fx_mkdir_rt";
const file = dir + "/data.txt";

try { fs.unlinkSync(file); } catch {}
try { fs.rmdirSync(dir); } catch {}

console.log(fs.existsSync("/tmp/asmjs_fx_definitely_absent_zzz"));
fs.mkdirSync(dir);
console.log(fs.existsSync(dir));
fs.writeFileSync(file, "hello fs");
console.log(fs.existsSync(file));
console.log(fs.readFileSync(file, "utf8"));
fs.mkdirSync(dir + "/sub/deep", { recursive: true });
console.log(fs.existsSync(dir + "/sub/deep"));
fs.unlinkSync(file);
console.log(fs.existsSync(file));
fs.rmdirSync(dir + "/sub/deep");
fs.rmdirSync(dir + "/sub");
fs.rmdirSync(dir);
console.log(fs.existsSync(dir));

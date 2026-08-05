import os from "node:os";
const ui = os.userInfo();
console.log(typeof ui.username, typeof ui.uid, typeof ui.homedir);
const ni = os.networkInterfaces();
console.log(typeof ni, Array.isArray(ni.lo0), ni.lo0[0].address);
console.log(os.endianness());
console.log(typeof os.machine(), typeof os.version());
console.log(os.availableParallelism() >= 1);

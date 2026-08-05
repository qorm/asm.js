import process from "node:process";

console.log(typeof process);
console.log(typeof process.nextTick);

let seen = 0;
process.nextTick(() => {
    seen = 1;
    console.log("tick", seen);
});

console.log("sync", seen);

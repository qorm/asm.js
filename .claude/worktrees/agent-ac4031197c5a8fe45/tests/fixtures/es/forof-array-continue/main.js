const arr = [1, 2, 3, 4];
let sum = 0;
for (const v of arr) {
    if (v & 1) {
        continue;
    }
    sum += v;
}
console.log(sum);

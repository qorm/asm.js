let sum = 0;
for (let i = 0; i < 10; i++) {
    if (i === 5) {
        break;
    }
    sum += i;
}
console.log(sum);

let odd = 0;
for (let j = 0; j < 5; j++) {
    if (j & 1) {
        odd += j;
    }
}
console.log(odd);

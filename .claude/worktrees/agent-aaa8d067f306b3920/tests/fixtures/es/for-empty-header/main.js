// for 循环空 header 段:for(;;) / for(a;;c) / for(;test;)
let i = 0;
for (;;) { i++; if (i >= 3) break; }
console.log(i);

let sum = 0;
for (let j = 0;; j++) { if (j >= 4) break; sum += j; }
console.log(sum);

let k = 0;
for (; k < 5;) k++;
console.log(k);

let t = 0;
for (let m = 0; m < 3; m++) t += m;
console.log(t);

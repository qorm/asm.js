// L4 边界:初值非串(否决门控,语义不变);数字 += 不受影响
let s = 5;
s += "x";
s = s + "y";
console.log(s);
let m = 0;
for (let i = 0; i < 3; i++) m += 2;
console.log(m);

console.log(1 / Math.min(-0, 0), 1 / Math.max(-0, 0));
console.log(1 / Math.min(0, -0), 1 / Math.max(0, -0));
console.log(1 / Math.min(-0, -0), 1 / Math.max(0, 0));
console.log(1 / Math.min(5, -0), 1 / Math.max(-0, 3) > 0);
console.log(Math.min(1, 2, 3), Math.max(1, 2, 3), Math.min(-5, 3, 0));
console.log(Math.min(1, NaN, 3), Math.max(NaN, 2));

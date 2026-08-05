const a = [1, 2, 3, 4, 5];
const b = a.toSpliced(1, 2, 9, 8);
console.log(a.join(","), "|", b.join(","));
console.log([1, 2, 3].toSpliced(1, 0, 7).join(","));
console.log([1, 2, 3, 4].toSpliced(2).join(","));
console.log([1, 2, 3].toSpliced(-1, 1, 9).join(","));

function f(){}
f.x = 41;
f.x++;
console.log(f.x);        // 42
console.log(f.x++);      // 42 (postfix returns old)
console.log(f.x);        // 43
console.log(++f.x);      // 44 (prefix returns new)
f.x--;
console.log(f.x);        // 43
f.x += 7;
console.log(f.x);        // 50
f.x -= 20; f.x *= 2;
console.log(f.x);        // 60
const g = () => {};
g.n = 1; g.n++; g.n += 3;
console.log(g.n);        // 5

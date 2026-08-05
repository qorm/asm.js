let x = 1;
{
    let x = 2;
    console.log(x);
    {
        let x = 3;
        console.log(x);
    }
    console.log(x);
}
console.log(x);
if (true) { let y = 10; console.log(y); }
let y = 5;
console.log(y);
for (let i = 0; i < 2; i++) { let x = 100 + i; console.log(x); }
console.log(x);
function f() {
    let a = 1;
    { let a = 2; console.log(a); }
    console.log(a);
    { const a = 3; console.log(a); }
    while (a < 2) { let a = 99; console.log(a); break; }
    return a;
}
console.log(f());
const obj = (() => { let v = 7; { let v = 8; } return { v }; })();
console.log(obj.v);
let s = "";
for (let c of "ab") { let c2 = c + "!"; s += c2; }
console.log(s);
switch (1) {
    case 1: {
        let x = 42;
        console.log(x);
        break;
    }
}
console.log(x);

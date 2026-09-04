function ReturnThis() { return this; }
function foo() { return eval("()=>this"); }
console.log(ReturnThis() === globalThis);
console.log(foo()() === globalThis);

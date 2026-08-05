function foo(){}
const arrow = ()=>{};
class C {}
console.log(foo instanceof Function, foo instanceof Object);
console.log(arrow instanceof Function, arrow instanceof Object);
console.log(C instanceof Function, C instanceof Object);
console.log((5) instanceof Function, ({}) instanceof Function);
console.log([] instanceof Object, [] instanceof Array);
function via(f){ return f instanceof Function; }
console.log(via(foo), via(arrow));

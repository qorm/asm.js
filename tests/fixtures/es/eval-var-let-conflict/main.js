var threw = false;
var a = () => { let x; eval("var x;"); };
try { a(); } catch (e) { threw = e instanceof SyntaxError; }
console.log(threw);

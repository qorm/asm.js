var threw = false;
try { x(); } catch (e) { threw = e instanceof ReferenceError; }
console.log(threw);

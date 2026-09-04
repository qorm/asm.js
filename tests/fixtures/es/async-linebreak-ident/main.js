var threw = false;
try {
  eval("async\nidentifier => {}");
} catch (e) { threw = e instanceof ReferenceError; }
console.log(threw);

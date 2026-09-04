var threw = false;
try {
  for (const x in [1, 2, 3]) { x++ }
} catch (e) { threw = e instanceof TypeError; }
console.log(threw);

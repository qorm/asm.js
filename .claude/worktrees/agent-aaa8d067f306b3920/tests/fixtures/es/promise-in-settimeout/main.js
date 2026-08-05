setTimeout(() => {
  console.log("timer");
  Promise.resolve("resolved").then(v => console.log("then:", v));
  console.log("timer-end");
}, 0);
console.log("main");
setTimeout(() => {
  Promise.resolve(1).then(a => Promise.resolve(a + 1)).then(b => console.log("chain:", b));
}, 0);

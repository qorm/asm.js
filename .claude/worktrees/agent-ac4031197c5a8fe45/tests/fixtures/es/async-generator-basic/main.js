// async generator: body can BOTH yield and await; .next() returns a Promise of {value,done}.
function p(v) { return Promise.resolve(v); }

async function* g() {
  yield 1;
  const x = await p(10);   // await inside async generator
  yield x + 1;             // yields 11
  await p(0);
  const inj = yield 3;     // receive value injected by next(v)
  yield inj * 100;
}

function show(r) { return r.value + " " + r.done; }
const it = g();
it.next().then(function (r1) {
  console.log(show(r1));                 // 1 false
  it.next().then(function (r2) {
    console.log(show(r2));               // 11 false
    it.next().then(function (r3) {
      console.log(show(r3));             // 3 false
      it.next(5).then(function (r4) {    // inject 5
        console.log(show(r4));           // 500 false
        it.next().then(function (r5) {
          console.log(show(r5));         // undefined true
        });
      });
    });
  });
});

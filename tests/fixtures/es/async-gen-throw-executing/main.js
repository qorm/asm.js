var thrownErr = new Error("Catch me.");
var iter;
async function* g() {
  iter.throw(thrownErr);
  yield 1;
  yield 2;
}
iter = g();
iter.next().then(function (result) {
  if (result.value !== 1) throw new Error("v1");
  if (result.done) throw new Error("done1");
  console.log("ok");
});

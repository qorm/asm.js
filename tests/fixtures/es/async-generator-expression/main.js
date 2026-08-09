var gen = async function* () {
  yield "a";
};

var iter = gen();
console.log(typeof iter.next);
iter.next().then(function (result) {
  console.log(result.value + " " + result.done);
});

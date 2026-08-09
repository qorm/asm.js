async function* generate() {
  yield {
    then: function (resolve) {
      resolve(42);
    }
  };
}

generate().next().then(function (result) {
  console.log(result.value + " " + result.done);
});

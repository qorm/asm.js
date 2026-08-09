async function main() {
  var value = await {
    then: function (resolve) {
      resolve(42);
    }
  };
  console.log(value);
}

main();

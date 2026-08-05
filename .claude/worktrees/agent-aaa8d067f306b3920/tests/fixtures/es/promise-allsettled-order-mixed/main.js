Promise.allSettled([Promise.reject("a"), Promise.resolve("b"), 3]).then(function(results) {
    console.log(results.length);
    console.log(results[0].status);
    console.log(results[0].reason);
    console.log(results[1].status);
    console.log(results[1].value);
    console.log(results[2].status);
    console.log(results[2].value);
});

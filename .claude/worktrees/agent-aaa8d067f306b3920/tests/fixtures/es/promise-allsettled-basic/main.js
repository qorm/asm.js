Promise.allSettled([Promise.resolve(1), Promise.reject("err"), 3]).then(function(results) {
    console.log(results[0].status);
    console.log(results[0].value);
    console.log(results[1].status);
    console.log(results[1].reason);
    console.log(results[2].status);
    console.log(results[2].value);
});

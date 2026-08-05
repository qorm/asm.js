Promise.race([Promise.resolve(7), Promise.resolve(9)]).then(function(value) {
    console.log(value);
});

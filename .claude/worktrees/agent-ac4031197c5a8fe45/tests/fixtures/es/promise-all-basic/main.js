Promise.all([Promise.resolve(1), 2, Promise.resolve(3)]).then(function(values) {
    console.log(values[0]);
    console.log(values[1]);
    console.log(values[2]);
});

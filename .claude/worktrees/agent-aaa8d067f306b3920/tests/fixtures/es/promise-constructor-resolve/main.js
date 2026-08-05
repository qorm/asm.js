const promise = new Promise((resolve) => {
    resolve(7);
});

promise.then((value) => {
    console.log(value);
});

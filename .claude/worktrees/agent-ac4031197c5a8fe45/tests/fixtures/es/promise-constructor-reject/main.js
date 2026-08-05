const promise = new Promise((resolve, reject) => {
    reject("bad");
});

promise.catch((reason) => {
    console.log(reason);
});

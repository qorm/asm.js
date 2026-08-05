let executor;
executor = (resolve) => {
    resolve(19);
};

const promise = new Promise(executor);

promise.then((value) => {
    console.log(value);
});

const primary = (resolve) => {
    resolve(43);
};

function identityExecutor(executor) {
    return executor;
}

function wrapExecutor(executor) {
    return identityExecutor(executor);
}

const promise = new Promise(wrapExecutor(primary));

promise.then((value) => {
    console.log(value);
});

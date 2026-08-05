const baseExecutor = (resolve) => {
    resolve(17);
};

const aliasA = baseExecutor;
const aliasB = aliasA;

const promise = new Promise(aliasB);

promise.then((value) => {
    console.log(value);
});

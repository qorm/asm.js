const usePrimary = true;
const primary = (resolve) => {
    resolve(23);
};
const fallback = (resolve) => {
    resolve(99);
};

const executor = usePrimary ? primary : fallback;
const promise = new Promise(executor);

promise.then((value) => {
    console.log(value);
});

const a = 1, b = 2, c = 3;
// trailing comma in named export list must parse
export { a, b, };
export { c, };

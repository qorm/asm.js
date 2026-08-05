console.log("2024-01".replace(/(?<y>\d+)-(?<m>\d+)/, (match, y, m, offset, str, groups) => groups.y + "/" + groups.m));
console.log("aaa".replace(/a/g, (m, i) => i));
console.log("abc".replace(/(.)(.)/, (m, a, b) => b + a));
console.log("x1y2".replace(/(?<c>\w)(?<n>\d)/g, (m, c, n, off, s, g) => g.c + g.n));

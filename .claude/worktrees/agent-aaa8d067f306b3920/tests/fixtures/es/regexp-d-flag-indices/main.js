const re = /(\d+)-(\d+)/d;
console.log(re.hasIndices);
const m = re.exec("12-34");
console.log(JSON.stringify(m.indices[0]), JSON.stringify(m.indices[1]), JSON.stringify(m.indices[2]));
const rn = /(?<y>\d+)-(?<mo>\d+)/d;
const mn = rn.exec("2024-01");
console.log(JSON.stringify(mn.indices.groups.y), JSON.stringify(mn.indices.groups.mo));
const opt = /(a)(b)?/d.exec("a");
console.log(JSON.stringify(opt.indices[1]), opt.indices[2] === undefined);

// Ricostruisce public/index.html da src/index.html + src/words.js.
// Da lanciare solo se modifichi la pagina o la lista di parole: `node build.js`
const fs = require("node:fs"), path = require("node:path");
const page = fs.readFileSync(path.join(__dirname, "src", "index.html"), "utf8");
const words = fs.readFileSync(path.join(__dirname, "src", "words.js"), "utf8");
fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "public", "index.html"), page.replace("/*WORDS*/", words));
console.log("public/index.html aggiornato");

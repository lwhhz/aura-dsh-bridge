import { Bonjour } from "bonjour-service";
const b = new Bonjour();
const found = [];
const browser = b.find({ type: "dsh" }, (s) => {
  found.push({ name: s.name, host: s.host, port: s.port, txt: s.txt });
  console.log("FOUND", JSON.stringify(found[found.length - 1]));
});
setTimeout(() => { console.log("TOTAL", found.length); b.destroy(); process.exit(0); }, 6000);

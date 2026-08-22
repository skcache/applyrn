import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({
  executablePath: process.argv[2],
  headless: true,
  args: ["--no-sandbox", "--no-first-run"],
});
const p = await b.newPage();
await p.goto("https://example.com", { timeout: 30000 });
console.log("TITLE:", await p.title());
await b.close();

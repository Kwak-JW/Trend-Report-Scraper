import fs from 'fs';
import * as cheerio from 'cheerio';

const html = fs.readFileSync('kotra.html', 'utf8');
const $ = cheerio.load(html);

console.log("Total a tags:", $('a').length);
let count = 0;
$('a').each((i, el) => {
    let t = $(el).text().replace(/\s+/g,' ').trim();
    if (t.length > 15) {
        console.log(`[${i}] Text: ${t.substring(0, 50)} | href: ${$(el).attr('href')} | onclick: ${$(el).attr('onclick')}`);
        count++;
    }
});
console.log(`Found ${count} tags with length > 15`);

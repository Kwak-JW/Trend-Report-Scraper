import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

async function testKotraDetails() {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://dream.kotra.or.kr/kotranews/cms/news/actionKotraBoardDetail.do?SITE_NO=3&MENU_ID=180&CONTENTS_NO=1&bbsGbn=243&bbsSn=243&pNttSn=240652', {waitUntil:'networkidle2'});
    const html = await page.content();
    const $ = cheerio.load(html);
    
    // Check images and text near them
    $('img').each((i, el)=>{
        const src = $(el).attr('src') || '';
        if (src.includes('namo/images')) {
             console.log(`\n\nImage src: ${src}`);
             const parent = $(el).parent();
             const grand = parent.parent();
             console.log(`Parent Text: ${parent.text()}`);
             console.log(`Grand Text: ${grand.text()}`);
             console.log(`Prev Text: ${parent.prev().text()}`);
             console.log(`Next Text: ${parent.next().text()}`);
        }
    });

    await browser.close();
}
testKotraDetails();

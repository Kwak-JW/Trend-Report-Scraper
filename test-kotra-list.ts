import puppeteer from 'puppeteer';

async function testKotraList() {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    let u = 'https://dream.kotra.or.kr/kotranews/cms/com/index.do?MENU_ID=180&pageNo=2';
    console.log(`Navigating to ${u}`);
    await page.goto(u, {waitUntil:'networkidle2'});
    
    // get title
    console.log("Title: ", await page.title());
    
    // see if there are articles
    const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => a.href).filter(t => t.includes('actionKotraBoardDetail'));
    });
    console.log(`Found ${links.length} detail links`);
    if (links.length > 0) {
        console.log("First detail link:", links[0]);
    }

    await browser.close();
}
testKotraList();

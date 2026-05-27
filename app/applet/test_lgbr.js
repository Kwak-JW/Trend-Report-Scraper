import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

async function main() {
  console.log('Starting puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const url = 'https://www.lgbr.co.kr/business/list.do?rankOptions=TITLE/50,CONTENTS_PDF/30,KEYWORD/100,KEYWORD_TOP/100';
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    console.log('HTML loaded successfully. Length:', html.length);

    const $ = cheerio.load(html);

    console.log('\n--- Title and Meta info ---');
    console.log('Page Title:', $('title').text().trim());

    // Let's inspect some of the structure of elements.
    console.log('\n--- Finding all elements that might be list items ---');
    console.log('Table rows (tr) count:', $('tr').length);
    console.log('List items in main content class board_list or elements of similar names:');
    
    // Let's print out some elements with classes
    const classes: string[] = [];
    $('[class]').each((_, el) => {
        const cls = $(el).attr('class');
        if (cls) {
            cls.split(/\s+/).forEach(c => {
                if (!classes.includes(c) && c.length < 30) classes.push(c);
            });
        }
    });
    console.log('Top classes on page:', classes.slice(0, 50).join(', '));

    console.log('\n--- Searching for dates matching regular expressions ---');
    const dateRegex = /(\d{4})[-.]\s*(\d{2})[-.]\s*(\d{2})/;
    const r2 = /(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/;
    const r4 = /(\d{4})\.\s*(\d{1,2})/;

    $('tr, li, .item, .list_item, .card, .t_box, .rcnt_wrap, div').each((idx, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        // We only want to print lines that look like small rows containing dates
        if (text.length < 300 && (text.includes('2025') || text.includes('2026') || text.includes('2024'))) {
            const m1 = text.match(dateRegex);
            const m2 = text.match(r2);
            const m4 = text.match(r4);
            if (m1 || m2 || m4) {
                console.log(`[El ${idx}] Tag: ${el.tagName}, Class: ${$(el).attr('class') || 'none'} text: ${text.substring(0, 150)}`);
                if (m1) console.log(`  => Matches dateRegex: ${m1[0]}`);
                if (m2) console.log(`  => Matches r2: ${m2[0]}`);
                if (m4) console.log(`  => Matches r4: ${m4[0]}`);
            }
        }
    });

    console.log('\n--- Let us search specifically for links inside candidate containers ---');
    $('a').each((i, a) => {
        const href = $(a).attr('href');
        const text = $(a).text().trim().replace(/\s+/g, ' ');
        if (href && (href.includes('detail.do') || href.includes('view') || href.includes('business') || href.includes('economy'))) {
            console.log(`Anchor [${i}] text="${text}" href="${href}"`);
        }
    });

  } catch (err) {
    console.error('Error running test:', err);
  } finally {
    await browser.close();
    console.log('Finished.');
  }
}

main();

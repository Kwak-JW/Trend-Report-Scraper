import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });
axios.get('https://dream.kotra.or.kr/kotranews/cms/com/index.do?MENU_ID=180', { httpsAgent: agent }).then(r => {
    const $ = cheerio.load(r.data);
    $('.list_item, .item, tr, li, a').each((_, el) => {
        const h = $(el).attr('href');
        if (h && (h.includes('view.do') || h.includes('MENU_ID'))) {
            // console.log($(el).text().trim(), h);
        }
    });

    const articles = [];
    $('a').each((_, el) => {
       const h = $(el).attr('href');
       if (h && h.includes('MENU_ID=180') && h.includes('ARTICLE_SE')) {
           articles.push(h);
       }
    });
    console.log(articles.slice(0, 5));
}).catch(console.error);

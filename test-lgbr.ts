import axios from 'axios';
import https from 'https';
import * as cheerio from 'cheerio';

async function test_lgbr() {
   const { data } = await axios.get('https://www.lgbr.co.kr/business/list.do?startIndex=10&rankOptions=TITLE/50,CONTENTS_PDF/30,KEYWORD/100,KEYWORD_TOP/100', {
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
   });
   const $ = cheerio.load(data);
   $('li').each((i, el)=>{
       const text = $(el).text().replace(/\s+/g, ' ');
       if(text.match(/202\d\.\d{2}\.\d{2}/)) console.log(`[Row ${i}] ${text.substring(0, 100)}`);
   });
}
test_lgbr();

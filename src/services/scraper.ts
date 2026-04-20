import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';
import { parseISO, isAfter, isBefore, isEqual } from 'date-fns';
import { JobManager } from './jobManager';

export async function startScrapingJob(jobId: string) {
  const job = JobManager.getJob(jobId);
  if (!job) return;

  const { urls, startDate, endDate, localPath } = job.config;

  try {
    JobManager.updateStatus(jobId, 'running');
    JobManager.addLog(jobId, 'info', `🚀 크롤링 작업을 시작합니다. 대상 URL 수: ${urls.length}개`);
    
    // Create directory
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
      JobManager.addLog(jobId, 'info', `📁 저장소 폴더 생성: ${localPath}`);
    }

    const startParsed = parseISO(startDate);
    const endParsed = parseISO(endDate);

    JobManager.addLog(jobId, 'info', `🔄 브라우저 엔진을 시작합니다...`);
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
    });

    for (const targetUrl of urls) {
      JobManager.addLog(jobId, 'info', `🌐 타겟 사이트 분석: ${targetUrl}`);
      try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        
        // Block images, css, fonts for performance (stealth not required)
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        const html = await page.content();
        const $ = cheerio.load(html);

        // Date detection Regex (YYYY-MM-DD or YYYY.MM.DD)
        const dateRegex = /(\d{4})[-.](\d{2})[-.](\d{2})/;
        
        const candidateRows: any[] = [];

        // 1. Find elements that represent a row (tr, li, or div that acts as row)
        $('tr, li, .item, .list_item, .card, .board_list > div').each((_, el) => {
           // Skip headers and navigation parts
           if ($(el).closest('nav, header, footer, .pagination, .gnb').length > 0) return;
           
           const text = $(el).text();
           const match = text.match(dateRegex);
           
           if (match) {
             const [_, year, month, day] = match;
             const parsedDate = new Date(`${year}-${month}-${day}`);
             
             if (!isNaN(parsedDate.getTime())) {
                const isWithinRange = 
                  (isAfter(parsedDate, startParsed) || isEqual(parsedDate, startParsed)) &&
                  (isBefore(parsedDate, endParsed) || isEqual(parsedDate, endParsed));
                
                if (isWithinRange) {
                  candidateRows.push(el);
                }
             }
           } else {
               // If no date found directly on the list row (e.g. KDI), check if it's a valid substantive link
               const hasLink = $(el).find('a[href], button[onclick]').length > 0;
               if (hasLink && text.trim().length > 10) {
                   candidateRows.push(el);
               }
           }
        });

        JobManager.addLog(jobId, 'info', `  => 일치/잠재 후보군(게시물) ${candidateRows.length}개 발견`);

        // 2. Discover Detail Links
        const detailLinks: { title: string, url: string }[] = [];
        
        if (candidateRows.length > 0) {
            for (const row of candidateRows) {
                const anchors = $(row).find('a');
                let longestAnchor = '';
                let longestLength = 0;
                let longestHref = '';

                // Try finding title from anchors
                anchors.each((_, a) => {
                    const text = $(a).text().trim();
                    const href = $(a).attr('href');
                    if (text.length > longestLength && href && !href.startsWith('javascript:')) {
                        longestLength = text.length;
                        longestAnchor = text;
                        longestHref = href;
                    }
                });

                // If not found in anchors, try to find an onclick button (some sites use row-clicking)
                if (!longestHref) {
                    const buttons = $(row).find('button[onclick]');
                    buttons.each((_, b) => {
                       const onclick = $(b).attr('onclick');
                       if (onclick) {
                           const m = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
                           if (m && m[1]) longestHref = m[1];
                       }
                    });
                }

                if (!longestAnchor && longestHref) {
                   longestAnchor = $(row).text().replace(/\s+/g, ' ').substring(0, 50).trim();
                }

                // Convert to absolute URL
                if (longestHref) {
                    try {
                        const absoluteUrl = new URL(longestHref, targetUrl).toString();
                        // Deduplicate (some rows might have duplicate links)
                        if (!detailLinks.find(d => d.url === absoluteUrl)) {
                            detailLinks.push({ title: longestAnchor, url: absoluteUrl });
                        }
                    } catch {
                        // Ignore malformed href
                    }
                }
            }
        } else {
            // No rows found. Treat the target URL itself as the detail page.
            JobManager.addLog(jobId, 'info', `  => 리스트 형태가 아님. 현재 페이지 자체를 단일 리포트 페이지로 간주합니다.`);
            detailLinks.push({ title: $('title').text().trim() || 'Report', url: targetUrl });
        }

        // Limit the number of blindly added detailLinks if there are too many (protection against massive dumps)
        const finalDetailLinks = detailLinks.slice(0, 30);
        if (detailLinks.length > 30) {
             JobManager.addLog(jobId, 'warn', `  => 너무 많은 후보 링크가 발견되었습니다. 최상위 30개만 진행합니다.`);
        }

        // 3. Process detail pages
        for (const detail of finalDetailLinks) {
            JobManager.addLog(jobId, 'info', `  => 문서 확인 중: ${detail.title.substring(0, 30)}...`);
            
            try {
                let $detail = $; // Default onto what we already have if it's the exact same page
                let detailPageToClose = null;
                
                if (detail.url !== targetUrl) {
                    const detailPage = await browser.newPage();
                    detailPageToClose = detailPage;
                    // Block heavy resources
                    await detailPage.setRequestInterception(true);
                    detailPage.on('request', (req) => {
                      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                        req.abort();
                      } else {
                        req.continue();
                      }
                    });

                    await detailPage.goto(detail.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    const detailHtml = await detailPage.content();
                    $detail = cheerio.load(detailHtml);
                }

                // If period was not validated from the row, validate it on the detail page
                const detailText = $detail('body').text();
                const detailDateMatch = detailText.match(dateRegex);
                let isWithinRange = true;
                
                if (detailDateMatch) {
                    const [_, year, month, day] = detailDateMatch;
                    const parsedDate = new Date(`${year}-${month}-${day}`);
                    if (!isNaN(parsedDate.getTime())) {
                        isWithinRange = 
                            (isAfter(parsedDate, startParsed) || isEqual(parsedDate, startParsed)) &&
                            (isBefore(parsedDate, endParsed) || isEqual(parsedDate, endParsed));
                    }
                }
                
                if (!isWithinRange) {
                    JobManager.addLog(jobId, 'info', `     => 기간 외 문서이므로 다운로드를 스킵합니다.`);
                    if (detailPageToClose) await detailPageToClose.close();
                    continue; // Skip the rest
                }

                // Title Extraction
                let reportTitle = detail.title;
                const pageTitle = $detail('title').text().trim();
                
                // If title is too short, or meaningless like "다운로드", fallback to the page title
                if (reportTitle.length < 5 || /(다운로드|상세보기|더보기|자세히보기)/.test(reportTitle)) {
                    reportTitle = pageTitle || `Report_${Date.now()}`;
                }

                // File name sanitization (keep spaces, allow basic korean/english/numbers, remove invalid chars)
                const safeTitle = reportTitle.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().substring(0, 100);

                // Heuristic: Find Download Link
                let downloadUrl = '';
                $detail('a, button').each((_, el) => {
                   const isButton = el.tagName === 'button';
                   const href = isButton ? null : $detail(el).attr('href');
                   const onclick = isButton ? $detail(el).attr('onclick') : null;
                   const text = $detail(el).text();
                   
                   let rawUrl = '';
                   if (!isButton && href && !href.startsWith('javascript:')) {
                       rawUrl = href;
                   } else if (isButton && onclick) {
                       const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
                       if (match && match[1]) {
                           rawUrl = match[1];
                       } else {
                           const windowOpenMatch = onclick.match(/window\.open\s*\(\s*['"]([^'"]+)['"]/);
                           if (windowOpenMatch && windowOpenMatch[1]) {
                               rawUrl = windowOpenMatch[1];
                           }
                       }
                   }

                   if (!rawUrl) return;

                   // Check conditions
                   if (rawUrl.toLowerCase().includes('.pdf') || 
                       /(다운|pdf|첨부|원문|file\/?download)/i.test(text) ||
                       /(file\/?download)/i.test(rawUrl)) {
                       try {
                         downloadUrl = new URL(rawUrl, detail.url).toString();
                       } catch {}
                   }
                });


                if (downloadUrl) {
                    JobManager.addLog(jobId, 'info', `     => 첨부 링크 감지, 다운로드 실행 중...`);
                    // Download File (PDF or other extension)
                    try {
                       const extensionUrl = downloadUrl.toLowerCase().split('.').pop()?.split('?')[0];
                       const finalExtension = (extensionUrl && extensionUrl.length <= 4 && extensionUrl !== 'pdf') ? extensionUrl : 'pdf';
                       
                       const agent = new https.Agent({ rejectUnauthorized: false });
                       const response = await axios({
                           method: 'GET',
                           url: downloadUrl,
                           responseType: 'arraybuffer',
                           timeout: 15000,
                           httpsAgent: agent
                       });
                       
                       const finalFileName = `${safeTitle}.${finalExtension}`;

                       const filePath = path.join(localPath, finalFileName);
                       fs.writeFileSync(filePath, response.data);
                       JobManager.addLog(jobId, 'success', `     ✅ 다운로드 완료 (제목 기준): ${finalFileName}`);
                    } catch (dlErr: any) {
                       JobManager.addLog(jobId, 'warn', `     ❌ 첨부 파일 다운로드 중 오류: ${dlErr.message}, 텍스트 본문 추출로 전환합니다.`);
                       downloadUrl = ''; // Force text extraction fallback
                    }
                }

                if (!downloadUrl) {
                    JobManager.addLog(jobId, 'info', `     => 첨부 없음. 텍스트 본문을 스크래핑합니다.`);
                    // Remove noise
                    $detail('script, style, nav, footer, header, noscript, svg').remove();
                    
                    const extractedText = $detail('body').text()
                       .replace(/\s+/g, ' ')
                       .split('\n')
                       .map(line => line.trim())
                       .filter(line => line.length > 0)
                       .join('\n');
                       
                    const filePath = path.join(localPath, `${safeTitle}.txt`);
                    fs.writeFileSync(filePath, extractedText);
                    JobManager.addLog(jobId, 'success', `     ✅ 스크래핑/추출 완료 (TXT): ${safeTitle}.txt`);
                }

                if (detailPageToClose) {
                    await detailPageToClose.close();
                }
            } catch (err: any) {
                JobManager.addLog(jobId, 'error', `     ❌ 상세 페이지 처리 실패: ${detail.url} - ${err.message}`);
            }
        }
        
        await page.close();

      } catch (err: any) {
        JobManager.addLog(jobId, 'error', `❌ 사이트 접근 실패 (${targetUrl}): ${err.message}`);
      }
    }

    await browser.close();
    JobManager.addLog(jobId, 'done', `🎉 모든 크롤링 및 다운로드 작업이 성공적으로 완료되었습니다.`);

  } catch (err: any) {
    JobManager.addLog(jobId, 'error', `🔥 Job failed entirely: ${err.message}`);
  }
}


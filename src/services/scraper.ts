import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';
import { parseISO, isAfter, isBefore, isEqual, isValid } from 'date-fns';
import { JobManager } from './jobManager.ts';

function extractKoreanDateFallback(text: string): Date | null {
    // try YYYY년 MM월 (일)
    const r2 = /(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/;
    let m = text.match(r2);
    if(m) return new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3] ? m[3].padStart(2, '0') : '01'}`);
    
    // try YYYY. MM월
    const r3 = /(\d{4})\.\s*(\d{1,2})월/;
    m = text.match(r3);
    if(m) return new Date(`${m[1]}-${m[2].padStart(2, '0')}-01`);
    
    return null;
}

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
      
      // Compute pages to crawl for this targetUrl using generic heuristic
      let pagesToCrawl: string[] = [];
      const u = new URL(targetUrl);
      let pageParam = '';
      let isZeroIndexed = false;
      let step = 1;
      const paginationKeywords = ['page', 'pg', 'pageidx', 'pageindex', 'pageno', 'startindex', 'offset'];
      
      for (const key of u.searchParams.keys()) {
          if (paginationKeywords.includes(key.toLowerCase())) {
              pageParam = key;
              const val = parseInt(u.searchParams.get(key) || '1', 10);
              if (val === 0) isZeroIndexed = true;
              if (key.toLowerCase() === 'startindex' || key.toLowerCase() === 'offset') { 
                  step = 10; 
              }
              break;
          }
      }

      if (!pageParam) {
          pageParam = 'page'; // default generic fallback
      }

      for (let i = 1; i <= 30; i++) {
          if (i === 1) {
              pagesToCrawl.push(targetUrl);
          } else {
              const u2 = new URL(targetUrl);
              let val = isZeroIndexed ? (i - 1) * step : i * step - (step - 1);
              u2.searchParams.set(pageParam, val.toString());
              pagesToCrawl.push(u2.toString());
          }
      }

      let allCandidateDetailLinks: { title: string, url: string }[] = [];

      try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });

        for (let pIdx = 0; pIdx < pagesToCrawl.length; pIdx++) {
            const currentUrl = pagesToCrawl[pIdx];
            if (pIdx > 0) {
                JobManager.addLog(jobId, 'info', `  => 과거 데이터 탐색 (Page ${pIdx + 1})...`);
            }
            JobManager.addLog(jobId, 'info', `  => URL 조회: ${currentUrl}`);
            
            let html = '';
            let loadSuccess = false;
            for (let retry = 0; retry < 3; retry++) {
                try {
                    await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    html = await page.content();
                    loadSuccess = true;
                    break;
                } catch (pe) {
                    JobManager.addLog(jobId, 'warn', `     ⚠️ 목록 페이지 로드 재시도 (${retry + 1}/3): ${pe instanceof Error ? pe.message : pe}`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            
            if (!loadSuccess) {
                JobManager.addLog(jobId, 'error', `     ❌ 목록 페이지 로드 실패, 대상 스킵: ${currentUrl}`);
                continue;
            }

            const $ = cheerio.load(html);

            const dateRegex = /(\d{4})[-.]\s*(\d{2})[-.]\s*(\d{2})/;
            const candidateRows: any[] = [];
            
            let oldestDateOnPage: Date | null = null;
            let foundValidDates = false;

            $('tr, li, .item, .list_item, .card, .board_list > div').each((_, el) => {
               if ($(el).closest('nav, header, footer, .pagination, .gnb').length > 0) return;
               
               const text = $(el).text();
               
               // exclude obvious irrelevants
               if(text.includes('영상 보고서') || text.includes('영상보고서')) return;

               const match = text.match(dateRegex);
               let parsedDate: Date | null = null;
               
               if (match) {
                 parsedDate = new Date(`${match[1]}-${match[2]}-${match[3]}`);
               } else {
                 parsedDate = extractKoreanDateFallback(text);
               }
               
               if (parsedDate && isValid(parsedDate)) {
                  foundValidDates = true;

                  const hasLink = $(el).find('a[href], button[onclick]').length > 0;
                  if (hasLink) {
                     if (!oldestDateOnPage || parsedDate < oldestDateOnPage) {
                         oldestDateOnPage = parsedDate;
                     }
                  }

                  const isWithinRange = 
                    (isAfter(parsedDate, startParsed) || isEqual(parsedDate, startParsed)) &&
                    (isBefore(parsedDate, endParsed) || isEqual(parsedDate, endParsed));
                  
                  if (isWithinRange && hasLink) {
                    candidateRows.push(el);
                  }
               } else {
                   // If no date found directly, check if it's a substantive link
                   const hasLink = $(el).find('a[href], button[onclick]').length > 0;
                   if (hasLink && text.trim().length > 10) {
                       candidateRows.push(el);
                   }
               }
            });

            // Extract Links from candidateRows
            if (candidateRows.length > 0) {
                for (const row of candidateRows) {
                    const anchors = $(row).find('a, button[onclick]');
                    let longestAnchor = '';
                    let longestLength = 0;
                    let longestHref = '';

                    anchors.each((_, a) => {
                        const text = $(a).text().trim();
                        const href = $(a).attr('href');
                        const onclick = $(a).attr('onclick');
                        if (text.length > longestLength) {
                            if (href && !href.startsWith('javascript:') && !href.startsWith('tel:') && !href.startsWith('mailto:')) {
                                longestLength = text.length;
                                longestAnchor = text;
                                longestHref = href;
                            } else if (onclick) {
                                // Try generic matchers for URL in onclick
                                const m = onclick.match(/(?:location\.href\s*=|window\.open\s*\()\s*['"]([^'"]+)['"]/);
                                if (m && m[1]) {
                                    longestLength = text.length;
                                    longestAnchor = text;
                                    longestHref = m[1];
                                }
                            } else if (href && href.startsWith('javascript:')) {
                                const m = href.match(/['"](\/[^'\"]+)['"]/);
                                if (m && m[1]) {
                                    longestLength = text.length;
                                    longestAnchor = text;
                                    longestHref = m[1];
                                }
                            }
                        }
                    });

                    if (!longestAnchor && longestHref) {
                       longestAnchor = $(row).text().replace(/\s+/g, ' ').substring(0, 50).trim();
                    }

                    if (longestHref) {
                        try {
                            const absoluteUrl = new URL(longestHref, currentUrl).toString();
                            if (!allCandidateDetailLinks.find(d => d.url === absoluteUrl)) {
                                allCandidateDetailLinks.push({ title: longestAnchor, url: absoluteUrl });
                            }
                        } catch {}
                    }
                }
            } else if (pIdx === 0) {
                // No rows found on first page. Treat target URL itself as detail page (fallback)
                allCandidateDetailLinks.push({ title: $('title').text().trim() || 'Report', url: targetUrl });
            }

            // Pagination Break Logic
            if (foundValidDates && oldestDateOnPage && oldestDateOnPage < startParsed) {
                JobManager.addLog(jobId, 'info', `  => 오래된 게시물(시작일 이전) 감지, 페이지 순회를 중단합니다.`);
                break;
            }
            
            // If no rows were found at all and we are > page 1, we hit the end
            if (candidateRows.length === 0 && !foundValidDates) {
                break;
            }
        } // end of page loop

        await page.close();
        
        JobManager.addLog(jobId, 'info', `  => 최종 수집된 상세 경로(후보군): ${allCandidateDetailLinks.length} 개`);

        const finalDetailLinks = allCandidateDetailLinks.slice(0, 50); // Hard limit
        if (allCandidateDetailLinks.length > 50) {
             JobManager.addLog(jobId, 'warn', `  => 너무 많은 후보 링크가 발견되었습니다. 최상위 50개만 진행합니다.`);
        }

        // 3. Process detail pages concurrently using chunks
        const CONCURRENCY_LIMIT = 5;
        for (let i = 0; i < finalDetailLinks.length; i += CONCURRENCY_LIMIT) {
            const chunk = finalDetailLinks.slice(i, i + CONCURRENCY_LIMIT);
            
            await Promise.all(chunk.map(async (detail) => {
                JobManager.addLog(jobId, 'info', `  => 문서 확인 중: ${detail.title.substring(0, 30)}...`);
                
                try {
                    const detailPage = await browser.newPage();
                    // Block heavy resources
                    await detailPage.setRequestInterception(true);
                    detailPage.on('request', (req) => {
                      if (['media'].includes(req.resourceType())) {
                        req.abort();
                      } else {
                        req.continue();
                      }
                    });

                    let detailHtml = '';
                    let loadSuccess = false;
                    for (let retry = 0; retry < 3; retry++) {
                        try {
                            await detailPage.goto(detail.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                            detailHtml = await detailPage.content();
                            loadSuccess = true;
                            break;
                        } catch (pe) {
                            JobManager.addLog(jobId, 'warn', `     ⚠️ 상세 페이지 로드 재시도 (${retry + 1}/3): ${pe instanceof Error ? pe.message : pe}`);
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                    
                    if (!loadSuccess) {
                        JobManager.addLog(jobId, 'error', `     ❌ 상세 페이지 처리를 건너뜁니다.`);
                        await detailPage.close();
                        return; // return from this async map function
                    }
                    
                    const $detail = cheerio.load(detailHtml);

                    // If period was not validated from the row, validate it on the detail page
                    const detailText = $detail('body').text();
                    const detailDateMatch = detailText.match(/(\d{4})[-.]\s*(\d{2})[-.]\s*(\d{2})/);
                    let isWithinRange = true;
                    
                    if (detailDateMatch) {
                        const parsedDate = new Date(`${detailDateMatch[1]}-${detailDateMatch[2]}-${detailDateMatch[3]}`);
                        if (!isNaN(parsedDate.getTime())) {
                            isWithinRange = 
                                (isAfter(parsedDate, startParsed) || isEqual(parsedDate, startParsed)) &&
                                (isBefore(parsedDate, endParsed) || isEqual(parsedDate, endParsed));
                        }
                    } else {
                        const parsedFb = extractKoreanDateFallback(detailText);
                        if (parsedFb && isValid(parsedFb)) {
                            isWithinRange = 
                                (isAfter(parsedFb, startParsed) || isEqual(parsedFb, startParsed)) &&
                                (isBefore(parsedFb, endParsed) || isEqual(parsedFb, endParsed));
                        }
                    }
                    
                    if (!isWithinRange) {
                        JobManager.addLog(jobId, 'info', `     => 기간 외 문서이므로 다운로드를 스킵합니다.`);
                        await detailPage.close();
                        return; // Skip the rest
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
                       const isButton = el.tagName.toLowerCase() === 'button';
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

                           // Generic JS function extraction? Unpredictable, so we just use what rawUrl caught above.

                           if (rawUrl.startsWith('tel:') || rawUrl.startsWith('mailto:')) return;

                           // Check conditions
                           if (rawUrl.toLowerCase().includes('.pdf') || 
                               /(다운|pdf|첨부|원문|file\/?download)/i.test(text) ||
                               /(file\/?download|userDownload)/i.test(rawUrl)) {
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
                           const fallbackExtension = (extensionUrl && extensionUrl.length <= 4 && extensionUrl !== 'pdf') ? extensionUrl : 'pdf';
                           
                           const agent = new https.Agent({ rejectUnauthorized: false });
                           const response = await axios({
                               method: 'GET',
                               url: downloadUrl,
                               responseType: 'arraybuffer',
                               timeout: 15000,
                               httpsAgent: agent
                           });
                           
                           let headerExtension = '';
                           const contentDisposition = response.headers['content-disposition'];
                           if (contentDisposition) {
                               const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
                               if (filenameMatch && filenameMatch[1]) {
                                   const hdFilename = filenameMatch[1].replace(/['"]/g, '');
                                   const hdExt = hdFilename.split('.').pop()?.toLowerCase();
                                   if (hdExt && hdExt.length <= 4) {
                                       headerExtension = hdExt;
                                   }
                               }
                           }
                           
                           const appliedExtension = headerExtension || fallbackExtension;
                           const finalFileName = `${safeTitle}.${appliedExtension}`;

                           const filePath = path.join(localPath, finalFileName);
                           fs.writeFileSync(filePath, response.data);
                           JobManager.addLog(jobId, 'success', `     ✅ 다운로드 완료 (제목 기준): ${finalFileName}`);
                        } catch (dlErr: any) {
                           JobManager.addLog(jobId, 'warn', `     ❌ 첨부 파일 다운로드 중 오류: ${dlErr.message}, 텍스트 본문 추출로 전환합니다.`);
                           downloadUrl = ''; // Force text extraction fallback
                        }
                    }

                    if (!downloadUrl) {
                        JobManager.addLog(jobId, 'info', `     => 첨부 없음. 페이지 본문을 PDF로 변환합니다.`);
                        
                        try {
                            // 브라우저 컨텍스트 내에서 불필요한 요소 제거 및 이미지 로딩 대기
                            await detailPage.evaluate(async () => {
                                const selectorsToRemove = ['nav', 'header', 'footer', 'aside', '.gnb', '.lnb', '.pagination', '.top_menu', '.bottom_menu', '#header', '#footer'];
                                document.querySelectorAll(selectorsToRemove.join(',')).forEach(el => {
                                    if (el && el.remove) el.remove();
                                });
                                
                                // 이미지 로딩 대기
                                const images = Array.from(document.querySelectorAll('img'));
                                await Promise.all(images.map(img => {
                                    if (img.complete) return Promise.resolve();
                                    return new Promise(resolve => {
                                        img.onload = resolve;
                                        img.onerror = resolve;
                                        // 너무 오래 걸리지 않게 타임아웃 설정
                                        setTimeout(resolve, 3000);
                                    });
                                }));
                            });

                            const filePath = path.join(localPath, `${safeTitle}.pdf`);
                            await detailPage.pdf({
                                path: filePath,
                                format: 'A4',
                                printBackground: true,
                                margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
                            });
                            
                            JobManager.addLog(jobId, 'success', `     ✅ 본문 스크래핑 및 PDF 변환 완료: ${safeTitle}.pdf`);
                        } catch (pdfErr: any) {
                            JobManager.addLog(jobId, 'error', `     ❌ PDF 변환 실패: ${pdfErr.message}`);
                        }
                    }

                    if (detailPage) {
                        await detailPage.close();
                    }
                } catch (err: any) {
                    JobManager.addLog(jobId, 'error', `     ❌ 상세 페이지 처리 실패: ${detail.url} - ${err.message}`);
                }
            }));
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


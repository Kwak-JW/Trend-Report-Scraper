import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';
import { parseISO, isAfter, isBefore, isEqual, isValid } from 'date-fns';
import { JobManager } from './jobManager';

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
      
      const isKIET = targetUrl.includes('kiet.re.kr');
      const isKIETChina = isKIET && targetUrl.includes('trends/china');
      
      // Compute pages to crawl for this targetUrl
      let pagesToCrawl: string[] = [];
      
      if (isKIETChina) {
          JobManager.addLog(jobId, 'info', `  => KIET 중국산업 브리프 전용 순회 최적화를 적용합니다.`);
          const startY = startParsed.getFullYear();
          const startM = startParsed.getMonth() + 1;
          const endY = endParsed.getFullYear();
          const endM = endParsed.getMonth() + 1;

          for (let y = endY; y >= startY; y--) {
              const mStart = (y === startY) ? startM : 1;
              const mEnd = (y === endY) ? endM : 12;
              for (let m = mEnd; m >= mStart; m--) {
                   const mStr = m.toString().padStart(2, '0');
                   const u = new URL(targetUrl);
                   u.searchParams.set('year', y.toString());
                   u.searchParams.set('month', mStr);
                   pagesToCrawl.push(u.toString());
              }
          }
      } else {
          // Standard urls. We will start with targetUrl and maybe augment if we need pagination (max 30 pages)
          for (let i = 1; i <= 30; i++) {
              if (i === 1) {
                  pagesToCrawl.push(targetUrl);
              } else if (isKIET) {
                  const u = new URL(targetUrl);
                  u.searchParams.set('pg', i.toString());
                  pagesToCrawl.push(u.toString());
              } else {
                  // For non-KIET, we don't automatically paginate right now unless requested
                  break;
              }
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
            if (pIdx > 0 && !isKIETChina) {
                JobManager.addLog(jobId, 'info', `  => 과거 데이터 탐색 (Page ${pIdx + 1})...`);
            }
            if (isKIETChina) {
                JobManager.addLog(jobId, 'info', `  => URL 조회: ${currentUrl}`);
            }
            
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const html = await page.content();
            const $ = cheerio.load(html);

            const dateRegex = /(\d{4})[-.]\s*(\d{2})[-.]\s*(\d{2})/;
            const candidateRows: any[] = [];
            
            let oldestDateOnPage: Date | null = null;
            let foundValidDates = false;

            $('tr, li, .item, .list_item, .card, .board_list > div').each((_, el) => {
               if ($(el).closest('nav, header, footer, .pagination, .gnb').length > 0) return;
               
               const text = $(el).text();
               
               // exclude video report (kiet ecolookList)
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
                  if (!oldestDateOnPage || parsedDate < oldestDateOnPage) {
                      oldestDateOnPage = parsedDate;
                  }

                  const isWithinRange = 
                    (isAfter(parsedDate, startParsed) || isEqual(parsedDate, startParsed)) &&
                    (isBefore(parsedDate, endParsed) || isEqual(parsedDate, endParsed));
                  
                  if (isWithinRange) {
                    candidateRows.push(el);
                  }
               } else {
                   // If no date found directly, check if it's a substantive link
                   const hasLink = $(el).find('a[href], button[onclick]').length > 0;
                   if (hasLink && text.trim().length > 10) {
                       // for KIET china logic
                       if (isKIETChina) {
                           const anchorHref = $(el).find('a').attr('href');
                           if (anchorHref && anchorHref.includes('chinaDetailView')) {
                               candidateRows.push(el);
                           }
                       } else {
                           candidateRows.push(el);
                       }
                   }
               }
            });

            // Extract Links from candidateRows
            if (candidateRows.length > 0) {
                for (const row of candidateRows) {
                    const anchors = $(row).find('a');
                    let longestAnchor = '';
                    let longestLength = 0;
                    let longestHref = '';

                    anchors.each((_, a) => {
                        const text = $(a).text().trim();
                        const href = $(a).attr('href');
                        if (text.length > longestLength && href && !href.startsWith('javascript:')) {
                            longestLength = text.length;
                            longestAnchor = text;
                            longestHref = href;
                        }
                    });

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

                    if (longestHref) {
                        try {
                            const absoluteUrl = new URL(longestHref, currentUrl).toString();
                            if (!allCandidateDetailLinks.find(d => d.url === absoluteUrl)) {
                                allCandidateDetailLinks.push({ title: longestAnchor, url: absoluteUrl });
                            }
                        } catch {}
                    }
                }
            } else if (!isKIETChina && pIdx === 0) {
                // No rows found on first page. Treat target URL itself as detail page (fallback)
                allCandidateDetailLinks.push({ title: $('title').text().trim() || 'Report', url: targetUrl });
            }

            // Pagination Break Logic
            if (!isKIETChina && isKIET) {
               // If we found dates, and the oldest date on this page is older than our start target, we don't need to load more pages
               if (foundValidDates && oldestDateOnPage && oldestDateOnPage < startParsed) {
                   JobManager.addLog(jobId, 'info', `  => 오래된 게시물(시작일 이전) 감지, 페이지 순회를 중단합니다.`);
                   break;
               }
               
               // If no rows were found at all and we are > page 1, we hit the end
               if (candidateRows.length === 0 && !foundValidDates) {
                   break;
               }
            }
        } // end of page loop

        await page.close();
        
        JobManager.addLog(jobId, 'info', `  => 최종 수집된 상세 경로(후보군): ${allCandidateDetailLinks.length} 개`);

        const finalDetailLinks = allCandidateDetailLinks.slice(0, 50); // Hard limit
        if (allCandidateDetailLinks.length > 50) {
             JobManager.addLog(jobId, 'warn', `  => 너무 많은 후보 링크가 발견되었습니다. 최상위 50개만 진행합니다.`);
        }

        // 3. Process detail pages
        for (const detail of finalDetailLinks) {
            JobManager.addLog(jobId, 'info', `  => 문서 확인 중: ${detail.title.substring(0, 30)}...`);
            
            try {
                const detailPage = await browser.newPage();
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

                if (detailPage) {
                    await detailPage.close();
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


import { useState, useEffect, useRef, useMemo } from 'react';
import { Plus, Trash2, Play, Download, AlertCircle, CheckCircle2, ChevronRight, Info } from 'lucide-react';

const getBadge = (u: string) => {
  if (u.includes('kiet.re.kr')) return 'KIET';
  if (u.includes('kdi.re.kr')) return 'KDI';
  if (u.includes('stis.or.kr')) return 'STIS';
  if (u.includes('kocca.kr')) return 'KOCCA';
  if (u.includes('lgbr.co.kr')) return 'LGBR';
  if (u.includes('kotra.or.kr')) return 'KOTRA';
  return 'OTHER';
};

const BADGE_COLORS: Record<string, { bg: string, text: string }> = {
  KIET: { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  KDI: { bg: 'bg-blue-100', text: 'text-blue-700' },
  STIS: { bg: 'bg-orange-100', text: 'text-orange-700' },
  KOCCA: { bg: 'bg-teal-100', text: 'text-teal-700' },
  LGBR: { bg: 'bg-red-100', text: 'text-red-700' },
  KOTRA: { bg: 'bg-purple-100', text: 'text-purple-700' },
  OTHER: { bg: 'bg-slate-100', text: 'text-slate-600' }
};

export default function App() {
  const [urls, setUrls] = useState<string[]>([
    'https://www.kiet.re.kr/research/issueList',
    'https://www.kiet.re.kr/research/economyDetailList?detail_gubun=C',
    'https://www.kiet.re.kr/trends/indbriefList',
    'https://www.kiet.re.kr/trends/china',
    'https://www.kiet.re.kr/trends/pointerList',
    'https://www.kdi.re.kr/research/topicList?cd=A',
    'https://www.kdi.re.kr/research/topicList?cd=G',
    'https://www.kdi.re.kr/research/topicList?cd=H',
    'https://www.stis.or.kr/board/pds/list?category=20',
    'https://www.kocca.kr/kocca/bbs/list/B0000141.do?menuNo=204145',
    'https://www.lgbr.co.kr/business/list.do?rankOptions=TITLE/50,CONTENTS_PDF/30,KEYWORD/100,KEYWORD_TOP/100',
    'https://www.lgbr.co.kr/economy/list.do?rankOptions=TITLE/50,CONTENTS_PDF/30,KEYWORD/100,KEYWORD_TOP/100',
    'https://dream.kotra.or.kr/kotranews/cms/com/index.do?MENU_ID=180'
  ]);
  const [enabledBadges, setEnabledBadges] = useState<Set<string>>(new Set(['KIET', 'KDI', 'STIS', 'KOCCA', 'LGBR', 'KOTRA', 'OTHER']));
  const [newUrl, setNewUrl] = useState('');
  const [startDate, setStartDate] = useState(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [localPath, setLocalPath] = useState('./downloads');
  const [jobId, setJobId] = useState<string | null>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const toggleBadge = (badge: string) => {
    const next = new Set(enabledBadges);
    if (next.has(badge)) next.delete(badge);
    else next.add(badge);
    setEnabledBadges(next);
  };

  const activeUrls = useMemo(() => urls.filter(u => enabledBadges.has(getBadge(u))), [urls, enabledBadges]);

  const allAvailableBadges = useMemo(() => Array.from(new Set(urls.map(getBadge))), [urls]);

  const groupedUrls = useMemo(() => {
    const groups: Record<string, string[]> = {};
    activeUrls.forEach(u => {
      const b = getBadge(u);
      if (!groups[b]) groups[b] = [];
      groups[b].push(u);
    });
    return groups;
  }, [activeUrls]);

  const addUrl = () => {
    if (newUrl && !urls.includes(newUrl)) {
      setUrls([...urls, newUrl]);
      setNewUrl('');
      // automatically activate the badge for the new url if it isn't
      const badge = getBadge(newUrl);
      if (!enabledBadges.has(badge)) {
        setEnabledBadges(prev => new Set(prev).add(badge));
      }
    }
  };

  const removeUrl = (url: string) => {
    setUrls(urls.filter((u) => u !== url));
  };

  const startJob = async () => {
    if (activeUrls.length === 0) return alert('적어도 하나 이상의 URL을 활성화/추가하세요.');
    
    setStatus('running');
    setLogs([]);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: activeUrls, startDate, endDate, localPath }),
      });
      if (!res.ok) throw new Error('API Error');
      const data = await res.json();
      setJobId(data.jobId);
      
      const evtSource = new EventSource(`/api/jobs/${data.jobId}/logs`);
      evtSource.onmessage = (event) => {
        const log = JSON.parse(event.data);
        setLogs((prev) => [...prev, log]);
        
        if (log.type === 'done') {
          setStatus('completed');
          evtSource.close();
        } else if (log.type === 'error' && log.message.includes('Job failed entirely')) {
          setStatus('error');
          evtSource.close();
        }
      };
      evtSource.onerror = () => {
         evtSource.close();
      };
    } catch (err: any) {
      alert(`시작 실패: ${err.message}`);
      setStatus('error');
    }
  };

  return (
    <div className="h-screen w-full flex flex-col text-slate-900 bg-slate-50 font-sans overflow-hidden">
      <header className="h-16 px-6 lg:px-8 border-b bg-white flex items-center justify-between shrink-0 shadow-sm z-10">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center shadow-sm">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-800">Trend Report <span className="text-indigo-600">Scraper</span></h1>
          <span className="text-[10px] sm:text-xs font-bold px-2 py-0.5 sm:py-1 bg-slate-100 text-slate-500 rounded border hidden sm:inline-block tracking-wider uppercase">Auto Engine</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="items-center space-x-2 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-full border border-emerald-100 hidden sm:flex">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
            <span className="text-xs font-semibold uppercase tracking-wide">Backend Ready</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden p-6 gap-6 max-w-7xl mx-auto w-full">
        <div className="lg:w-[450px] w-full flex flex-col gap-6 shrink-0 h-full overflow-hidden">
          <div className="bg-white rounded-xl border p-5 shadow-sm flex flex-col flex-1 min-h-0">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Target Sources</h2>
            <div className="flex gap-2 flex-wrap mb-4 shrink-0">
              {allAvailableBadges.map(badge => {
                const isActive = enabledBadges.has(badge);
                const colors = BADGE_COLORS[badge] || BADGE_COLORS.OTHER;
                return (
                  <button 
                    key={badge}
                    onClick={() => toggleBadge(badge)}
                    className={`px-2 py-1 text-[10px] font-bold rounded uppercase tracking-wider transition-all ${
                      isActive ? `${colors.bg} ${colors.text}` : 'bg-slate-50 text-slate-400 border border-slate-200 opacity-60 hover:bg-slate-100 hover:opacity-100'
                    }`}
                  >
                    {badge}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-4 border-t border-slate-100 pt-4">
              {Object.entries(groupedUrls).map(([badge, list]) => {
                const urlList = list as string[];
                const colors = BADGE_COLORS[badge] || BADGE_COLORS.OTHER;
                return (
                  <div key={badge} className="flex gap-3 items-start border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                    <div className={`mt-1 shrink-0 ${colors.bg} ${colors.text} text-[10px] px-2 py-0.5 rounded uppercase font-bold tracking-wider w-[55px] text-center`}>
                      {badge}
                    </div>
                    <div className="flex-1 flex flex-col gap-2 min-w-0">
                      {urlList.map(u => (
                        <div key={u} className="flex items-center justify-between bg-slate-50 border border-slate-100 px-3 py-2 rounded-md group hover:bg-slate-100 transition-colors">
                          <span className="text-xs truncate font-medium text-slate-600 block flex-1" title={u}>{u}</span>
                          <button onClick={() => removeUrl(u)} className="text-slate-300 hover:text-red-500 transition-colors ml-2 shrink-0">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {activeUrls.length === 0 && <p className="text-slate-400 text-xs italic mt-2">No URLs designated or all badges disabled.</p>}
            </div>

            <div className="mt-4 pt-4 border-t shrink-0">
              <div className="flex gap-2">
                <input
                  type="url"
                  className="flex-1 text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-md focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all"
                  placeholder="https://example.com/reports"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addUrl()}
                />
                <button
                  onClick={addUrl}
                  className="px-3 bg-slate-800 text-white rounded-md hover:bg-slate-700 transition"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border p-4 shadow-sm shrink-0">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Configuration</h2>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Date Range</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                  <input
                    type="date"
                    className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Save Path (Local)</label>
                <input
                  type="text"
                  className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="C:\downloads\reports"
                />
              </div>
            </div>
          </div>

          <button
            onClick={startJob}
            disabled={status === 'running'}
            className={`shrink-0 w-full py-3 rounded-lg text-sm font-bold tracking-wide flex items-center justify-center gap-2 transition-all shadow-sm ${
              status === 'running' ? 'bg-slate-200 text-slate-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            <Play className="w-4 h-4 fill-current" />
            {status === 'running' ? 'AUTOMATION RUNNING...' : 'RUN AUTOMATION'}
          </button>
        </div>

        <div className="flex-1 flex flex-col gap-6 overflow-hidden min-h-[400px]">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 shrink-0">
            <div className="bg-white p-4 rounded-xl border shadow-sm">
              <div className="text-[11px] font-bold uppercase text-slate-500 tracking-wider mb-1">Scanning Status</div>
              <div className="text-xl font-bold text-slate-800 capitalize flex items-center">
                {status === 'running' && <span className="w-2.5 h-2.5 bg-indigo-500 rounded-full animate-ping mr-2 shrink-0"></span>}
                {status}
              </div>
            </div>
            <div className="bg-white p-4 rounded-xl border shadow-sm">
              <div className="text-[11px] font-bold uppercase text-slate-500 tracking-wider mb-1">Target Sites</div>
              <div className="text-xl font-bold text-slate-800 font-mono">{urls.length} <span className="text-slate-400 text-xs font-medium font-sans">items</span></div>
            </div>
            <div className="bg-white p-4 rounded-xl border shadow-sm hidden sm:block">
              <div className="text-[11px] font-bold uppercase text-slate-500 tracking-wider mb-1">Logs Events</div>
              <div className="text-xl font-bold text-slate-800 font-mono">{logs.length} <span className="text-slate-400 text-xs font-medium font-sans">events</span></div>
            </div>
          </div>

          <div className="flex-1 bg-slate-900 rounded-xl overflow-hidden shadow-inner flex flex-col">
            <div className="bg-slate-800 px-4 py-2 flex items-center justify-between shrink-0">
              <div className="flex items-center space-x-2">
                <div className="flex space-x-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/50"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/50"></div>
                </div>
                <span className="text-[10px] text-slate-400 font-mono ml-2 uppercase tracking-wider">Crawler Console v1.02</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">UTF-8 / SYSTEM</span>
            </div>
            <div className="p-4 flex-1 overflow-y-auto terminal-scrollbar font-mono text-[12px] leading-relaxed text-slate-300 space-y-1.5">
              {logs.length === 0 && (
                <p className="text-slate-500 animate-pulse">Waiting for user to trigger RUN command...</p>
              )}
              {logs.map((log, i) => (
                <div key={i} className="flex">
                  <span className="text-slate-500 w-[70px] shrink-0">
                    [{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}]
                  </span>
                  <span className={`flex-1 break-words ml-2
                    ${log.type === 'error' ? 'text-red-400' : ''}
                    ${log.type === 'info' ? 'text-slate-300' : ''}
                    ${log.type === 'success' ? 'text-emerald-400' : ''}
                    ${log.type === 'warn' ? 'text-yellow-400' : ''}
                    ${log.type === 'done' ? 'text-indigo-300 font-bold' : ''}
                  `}>
                    {log.message}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>

          {status === 'completed' && jobId && (
            <div className="shrink-0 p-4 bg-indigo-50 rounded-xl border border-indigo-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-indigo-900 font-bold text-sm flex items-center mb-0.5">
                  <CheckCircle2 className="w-4 h-4 mr-1.5" /> All Tasks Completed
                </h3>
                <p className="text-indigo-600/80 text-[11px] font-medium leading-tight max-w-sm">If running via Cloud UI sandbox, click download below to retrieve the aggregate ZIP archive.</p>
              </div>
              <a
                href={`/api/jobs/${jobId}/download`}
                className="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg text-xs font-bold tracking-wide flex items-center shadow-sm transition-all"
              >
                <Download className="w-4 h-4 mr-2" /> 
                DOWNLOAD ZIP
              </a>
            </div>
          )}

          {status === 'error' && (
            <div className="shrink-0 p-4 bg-red-50 rounded-xl border border-red-100 flex items-start text-red-800 space-x-3">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-500" />
              <div className="flex-1">
                <h3 className="font-bold text-sm mb-0.5">Fatal Error Encountered</h3>
                <p className="text-red-600/80 text-[11px] font-medium leading-tight">The crawler process faced a critical exception. Please check the console logs above for details.</p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

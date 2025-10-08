"use client";

// ===============================
// app/page.tsx — 進階功能＋操作說明＋差異熱圖＆放大鏡（browser-image-compression 版）
// - 操作說明（ⓘ 說明彈窗）
// - 進階設定：輸出格式、長邊上限、並行數、檔名模板
// - 對比視窗：滑桿 + 放大鏡（原圖/壓縮圖對照）
// - 差異熱圖：按需生成（|RGB差| 熱度圖）
// - ZIP 下載套用檔名模板
// - 透明 PNG 自動只輸出 WebP（保持透明）
// 注意：所有壓縮與計算都在本機進行
// 依賴：browser-image-compression, jszip, file-saver, react-compare-image
// ===============================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import imageCompression from "browser-image-compression";
import type { Options as ImageCompressionOptions } from "browser-image-compression";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import ReactCompareImage from "react-compare-image";

// ---------- 型別 ----------
type JobStatus = "queued" | "processing" | "done" | "error" | "canceled";

type CompressResult = {
  label: string;
  mime: "image/jpeg" | "image/webp";
  blob: Blob;
  url: string;
  size: number;
  ratio: number; // 1 - out/ori
  ms: number;    // 耗時（該路）
  keepAlpha?: boolean; // 標記保透明
  heatmapUrl?: string; // 差異熱圖（延後生成）
};

type Job = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  url: string; // 原圖預覽（Object URL）
  hasAlpha?: boolean;
  status: JobStatus;
  startedAt?: number;
  endedAt?: number;
  results: CompressResult[];
  error?: string;
};

// ---------- 小工具 ----------
function uid() { return Math.random().toString(36).slice(2, 10); }
function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B","KB","MB","GB"]; const i = Math.floor(Math.log(bytes)/Math.log(k));
  const v = bytes/Math.pow(k,i); return `${v.toFixed(v>=100?0:v>=10?1:2)} ${sizes[i]}`;
}
function revokeSafely(url?: string | null) {
  if (url) try { URL.revokeObjectURL(url); } catch {}
}
async function blobFromUrl(url: string) { const res = await fetch(url); return await res.blob(); }
async function bitmapFromUrl(url: string) { const b = await blobFromUrl(url); return await createImageBitmap(b); }

// ---------- 參數（預設可在進階面板調整） ----------
const DEFAULT_MAX_FILE_MB = 10;
const DEFAULT_MAX_LONG_EDGE = 3000;
const DEFAULT_CONCURRENCY = 1; // 保守：避免卡 UI

// 場景預設
const PRESETS = {
  social: { name: "社群", jpg: 0.75, webp: 0.80 },
  web:    { name: "網站", jpg: 0.80, webp: 0.85 },
  high:   { name: "高品質", jpg: 0.92, webp: 0.90 },
} as const;
type PresetKey = keyof typeof PRESETS;

// 進階設定型別
type Settings = {
  longEdge: number;      // 長邊上限
  concurrency: number;   // 並行上限
  outJPEG: boolean;      // 是否輸出 JPEG
  outWebP: boolean;      // 是否輸出 WebP
  filenameTpl: string;   // 檔名模板
};

export default function Page() {
  // === 基本 state ===
  const [jobs, setJobs] = useState<Job[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [preset, setPreset] = useState<PresetKey>("web");
  const [showInfo, setShowInfo] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 進階設定（可熱調整）
  const [settings, setSettings] = useState<Settings>({
    longEdge: DEFAULT_MAX_LONG_EDGE,
    concurrency: DEFAULT_CONCURRENCY,
    outJPEG: true,
    outWebP: true,
    filenameTpl: "{name}__{fmt}_q{q}_{w}w.{ext}",
  });

  const MAX_FILE_MB = DEFAULT_MAX_FILE_MB; // 固定 10MB 驗證（也可加到進階設定）

  // 對比 & 工具
  const [compare, setCompare] = useState<{ jobId: string; idx: number } | null>(null);
  const [abToggle, setAbToggle] = useState<boolean>(false); // A/B 切換
  const [magnify, setMagnify] = useState<boolean>(false);   // 放大鏡
  const [heatBusy, setHeatBusy] = useState<string | null>(null); // 生成熱圖中的 key: `${jobId}-${idx}`

  // 最新 jobs 供 while 讀取
  const jobsRef = useRef<Job[]>([]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // 支援格式判斷
  const isSupportedImage = useCallback((f: File) => {
    const ok = ["image/jpeg","image/jpg","image/png"]; return ok.includes(f.type);
  },[]);

  // 快速偵測 alpha（僅對 PNG 做，抽樣像素）
  const detectAlphaFast = useCallback(async (file: File): Promise<boolean> => {
    if (!file.type.includes("png")) return false;
    try {
      const bmp = await createImageBitmap(file);
      const w = Math.min(256, bmp.width), h = Math.min(256, bmp.height);
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(bmp, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) { if (data[i] < 255) return true; }
      return false;
    } catch { return false; }
  },[]);

  // 單一路壓縮
  const compressOnce = useCallback(async (
    file: File,
    targetMime: "image/jpeg"|"image/webp",
    quality: number,
    originalSize: number,
    longEdge: number,
    keepAlpha?: boolean
  ): Promise<CompressResult> => {
    const t0 = performance.now();
    const options = {
      maxWidthOrHeight: longEdge,
      initialQuality: quality,
      fileType: targetMime,
      useWebWorker: true,
    } as unknown as ImageCompressionOptions;
    const out = await imageCompression(file, options);
    const ms = Math.round(performance.now() - t0);
    const url = URL.createObjectURL(out);
    return {
      label: `${targetMime==="image/jpeg"?"JPEG":"WebP"} (q=${Math.round(quality*100)})${keepAlpha?" · 保持透明":""}`,
      mime: targetMime,
      blob: out,
      url,
      size: out.size,
      ratio: 1 - out.size / originalSize,
      ms,
      keepAlpha,
    };
  },[]);

  // 佇列處理器
  const processQueue = useCallback(async () => {
    if (running) return; // avoid re-entry
    setRunning(true);

    const updateJob = (id: string, patch: Partial<Job>) =>
      setJobs(prev => prev.map(j => j.id===id?{...j, ...patch}:j));

    try {
      while (true) {
        const processingCount = jobsRef.current.filter(j => j.status === "processing").length;
        if (processingCount >= settings.concurrency) { await new Promise(r => setTimeout(r, 30)); continue; }
        const job = jobsRef.current.find(j => j.status === "queued");
        if (!job) break;

        updateJob(job.id, { status: "processing", startedAt: performance.now(), error: undefined, results: [] });

        try {
          const hasAlpha = await detectAlphaFast(job.file);
          updateJob(job.id, { hasAlpha });

          const qJ = PRESETS[preset].jpg;
          const qW = PRESETS[preset].webp;
          const tasks: Promise<CompressResult>[] = [];

          if (hasAlpha) {
            // 透明：不輸出 JPEG；只輸出 WebP（保透明）
            if (settings.outWebP) tasks.push(compressOnce(job.file, "image/webp", qW, job.size, settings.longEdge, true));
          } else {
            if (settings.outJPEG) tasks.push(compressOnce(job.file, "image/jpeg", qJ, job.size, settings.longEdge));
            if (settings.outWebP) tasks.push(compressOnce(job.file, "image/webp", qW, job.size, settings.longEdge));
          }

          const results = await Promise.all(tasks);
          updateJob(job.id, { results: results.sort((a,b)=>a.size-b.size), status: "done", endedAt: performance.now() });

          // 讓主執行緒有喘息（避免卡畫面）
          await new Promise(r => setTimeout(r, 0));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "壓縮失敗";
          console.error("job failed", err);
          updateJob(job.id, { status: "error", error: msg, endedAt: performance.now() });
        }
      }
    } finally { setRunning(false); }
  }, [compressOnce, detectAlphaFast, preset, running, settings.concurrency, settings.longEdge, settings.outJPEG, settings.outWebP]);

  // 有排隊就開跑
  useEffect(() => { if (jobs.some(j => j.status === "queued")) processQueue(); }, [jobs, processQueue]);

  // 上傳處理（多檔）
  const enqueueFiles = useCallback((files: FileList | null) => {
    setErrorMsg("");
    if (!files || files.length === 0) return;

    const newJobs: Job[] = [];
    Array.from(files).forEach(f => {
      if (!isSupportedImage(f)) { setErrorMsg("僅支援 JPG/PNG，其他檔已忽略。"); return; }
      if (f.size > MAX_FILE_MB*1024*1024) { setErrorMsg(prev => prev? prev : `含有超過 ${MAX_FILE_MB}MB 的檔案，已略過。`); return; }
      const id = uid(); const url = URL.createObjectURL(f);
      newJobs.push({ id, file: f, name: f.name, type: f.type, size: f.size, url, status: "queued", results: [] });
    });
    if (newJobs.length) setJobs(prev => [...prev, ...newJobs]);
  }, [isSupportedImage, MAX_FILE_MB]);

  // 拖放事件
  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); enqueueFiles(e.dataTransfer.files); }, [enqueueFiles]);
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); }, []);

  // 取消/移除/清空
  const cancelJob = useCallback((id: string) => setJobs(prev => prev.map(j => j.id===id && j.status!=="done"? {...j, status: "canceled"}: j)), []);
  const removeJob = useCallback((id: string) => setJobs(prev => prev.filter(j => j.id!==id)), []);
  const clearAll = useCallback(() => {
    setJobs(prev => { prev.forEach(j => { revokeSafely(j.url); j.results.forEach(r => revokeSafely(r.url)); }); return []; });
  },[]);

  // 重新壓縮（依當前 preset + 設定）
  const recompressAll = useCallback(() => {
    setJobs(prev => prev.map(j => j.status!=="processing"? { ...j, status: "queued", results: [], startedAt: undefined, endedAt: undefined } : j));
  },[]);

  // 下載全部 ZIP（可選只打包某格式，並套用檔名模板）
  const downloadZip = useCallback(async (only: "image/webp"|"image/jpeg"|"all" = "all") => {
    const zip = new JSZip();
    const ts = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];

    const qJ = PRESETS[preset].jpg, qW = PRESETS[preset].webp;

    const formatName = (tpl: string, p: { name: string; fmt: string; q: number; w: number; ext: string; }) =>
      tpl
        .replaceAll("{name}", p.name)
        .replaceAll("{fmt}", p.fmt)
        .replaceAll("{q}", String(Math.round(p.q*100)))
        .replaceAll("{w}", String(p.w))
        .replaceAll("{ext}", p.ext);

    for (const j of jobs) {
      if (j.status !== "done") continue;
      for (const r of j.results) {
        if (only !== "all" && r.mime !== only) continue;
        const fmt = r.mime === "image/jpeg" ? "jpg" : "webp";
        const qv = r.mime === "image/jpeg" ? qJ : qW;
        const base = j.name.replace(/\.[^.]+$/, "");
        const out = formatName(settings.filenameTpl, { name: base, fmt, q: qv, w: settings.longEdge, ext: fmt });
        zip.file(out, r.blob);
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, `compressed_${ts}.zip`);
  }, [jobs, preset, settings.filenameTpl, settings.longEdge]);

  // 摘要
  const summary = useMemo(() => {
    const done = jobs.filter(j => j.status === "done");
    const count = done.length;
    let savedBytes = 0; let timeSum = 0; let outCount = 0;
    done.forEach(j => {
      const best = [...j.results].sort((a,b)=>a.size-b.size)[0];
      if (best) { savedBytes += Math.max(0, j.size - best.size); outCount += 1; }
      if (j.startedAt && j.endedAt) timeSum += (j.endedAt - j.startedAt);
    });
    const avgMs = outCount? Math.round(timeSum/outCount) : 0;
    return { count, savedBytes, avgMs };
  }, [jobs]);

  // 鍵盤 A/B 切換
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === "Space") { e.preventDefault(); setAbToggle(t => !t); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);

  // === 差異熱圖：即時生成（按需） ===
  const ensureHeatmap = useCallback(async (job: Job, idx: number) => {
    const r = job.results[idx];
    if (r.heatmapUrl) return r.heatmapUrl;
    const key = `${job.id}-${idx}`;
    setHeatBusy(key);
    try {
      // 讀取原圖與壓縮圖的位圖
      const [bmpA, bmpB] = await Promise.all([bitmapFromUrl(job.url), bitmapFromUrl(r.url)]);
      const baseW = Math.min(bmpA.width, bmpB.width);
      const baseH = Math.min(bmpA.height, bmpB.height);
      const w = Math.min(baseW, 1400);
      const h = Math.round(baseH * (w / baseW));

      // 畫到兩個 canvas
      const ca = document.createElement("canvas"), cb = document.createElement("canvas"), ch = document.createElement("canvas");
      ca.width = cb.width = ch.width = w; ca.height = cb.height = ch.height = h;
      const ax = ca.getContext("2d", { willReadFrequently: true })!;
      const bx = cb.getContext("2d", { willReadFrequently: true })!;
      const hx = ch.getContext("2d")!;
      ax.drawImage(bmpA, 0, 0, w, h);
      bx.drawImage(bmpB, 0, 0, w, h);
      const da = ax.getImageData(0,0,w,h);
      const db = bx.getImageData(0,0,w,h);
      const out = hx.createImageData(w, h);
      const A = da.data, B = db.data, O = out.data;
      for (let i=0;i<A.length;i+=4){
        const dr = A[i]-B[i], dg=A[i+1]-B[i+1], dbv=A[i+2]-B[i+2];
        const d = Math.sqrt(dr*dr+dg*dg+dbv*dbv) / 441.67295593; // normalize 0..1
        // 映射到熱圖（黑→黃→紅）：低差=透明，高差=紅
        const t = Math.min(1, d*3); // 強化可見度
        const rC = Math.round(255 * Math.min(1, Math.max(0, (t-0.33)/0.67)));
        const gC = Math.round(255 * Math.min(1, t<0.66 ? t/0.66 : (1-(t-0.66)/0.34)));
        const bC = 0;
        O[i] = rC; O[i+1] = gC; O[i+2] = bC; O[i+3] = Math.round(255 * Math.min(1, t));
      }
      hx.putImageData(out, 0, 0);
      const url = ch.toDataURL("image/png");
      r.heatmapUrl = url;
      setJobs(prev => prev.map(j => j.id===job.id ? { ...j, results: j.results.map((x,k)=> k===idx? { ...x, heatmapUrl: url } : x)} : j));
      return url;
    } finally {
      setHeatBusy(null);
    }
  }, []);

  // === 放大鏡：在對比視窗內的簡易實作 ===
  const Magnifier: React.FC<{ baseUrl: string; altUrl: string; zoom?: number; diameter?: number; }>
    = ({ baseUrl, altUrl, zoom = 2, diameter = 200 }) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const lensRef = useRef<HTMLCanvasElement>(null);
    const baseImgRef = useRef<HTMLImageElement>(null);
    const altBmpRef = useRef<ImageBitmap | null>(null);

    useEffect(() => {
      (async () => { altBmpRef.current = await bitmapFromUrl(altUrl); })();
    }, [altUrl]);

    const onMove = useCallback((e: React.MouseEvent) => {
      const lens = lensRef.current; const wrap = wrapRef.current; const base = baseImgRef.current; const altBmp = altBmpRef.current;
      if (!lens || !wrap || !base || !altBmp) return;
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left; const y = e.clientY - rect.top;
      const r = diameter/2;
      // 以 base 圖展示，放大鏡顯示「原圖 vs 壓縮圖」左右各半
      const ctx = lens.getContext("2d")!; lens.width = diameter; lens.height = diameter;
      ctx.clearRect(0,0,lens.width,lens.height);
      ctx.save();
      ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI*2); ctx.clip();

      // 取得 base 圖素到原圖座標
      const bx = x / base.clientWidth; const by = y / base.clientHeight;
      const sx = bx * base.naturalWidth; const sy = by * base.naturalHeight;
      const sw = diameter / zoom; const sh = diameter / zoom;

      // 左半：原圖
      ctx.drawImage(base, Math.max(0,sx-sw/2), Math.max(0,sy-sh/2), sw, sh, 0, 0, r, diameter);
      // 右半：壓縮圖（位圖）
      ctx.drawImage(altBmp, Math.max(0,sx-sw/2), Math.max(0,sy-sh/2), sw, sh, r, 0, r, diameter);

      ctx.restore();
      // 邊框與中線
      ctx.beginPath(); ctx.arc(r, r, r-0.5, 0, Math.PI*2); ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r,0); ctx.lineTo(r,diameter); ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.stroke();

      // 讓鏡片跟著滑鼠
      (lens.style as any).left = `${x - r}px`;
      (lens.style as any).top = `${y - r}px`;
    }, [zoom, diameter]);

    return (
      <div ref={wrapRef} className="relative w-full">
        <img ref={baseImgRef} src={baseUrl} alt="base" className="w-full h-auto select-none pointer-events-none"/>
        <canvas ref={lensRef} className="absolute pointer-events-none" style={{ width: diameter, height: diameter, position: 'absolute' }} />
        <div className="absolute inset-0" onMouseMove={onMove} />
      </div>
    );
  };

  // ---------- UI ----------
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <div className="max-w-6xl mx-auto p-6">
        {/* 頂部 */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">批次圖片壓縮（JPG/PNG）</h1>
            <button onClick={()=>setShowInfo(true)} className="text-xs px-2 py-1 rounded bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300">ⓘ 操作說明</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {/* 場景切換 */}
            <select value={preset} onChange={(e)=>setPreset(e.target.value as PresetKey)} className="px-2 py-1.5 rounded-lg border bg-white dark:bg-neutral-800" title="選擇壓縮場景（切換後按重壓）">
              {Object.entries(PRESETS).map(([k,v])=> (
                <option key={k} value={k}>{v.name}（JPG {Math.round(v.jpg*100)} / WebP {Math.round(v.webp*100)}）</option>
              ))}
            </select>
            <button onClick={recompressAll} className="px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-800">重壓</button>

            <button onClick={()=>setShowAdvanced(s=>!s)} className="px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-800">{showAdvanced?"收合進階":"進階設定"}</button>

            <div className="px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-800">已完成：{summary.count} 張</div>
            <div className="px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-800">總節省：{formatBytes(summary.savedBytes)}</div>
            <div className="px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-800">平均耗時：{summary.avgMs} ms/張</div>
            <button onClick={()=>downloadZip("all")} className="px-3 py-1.5 rounded-lg bg-black text-white hover:opacity-90">下載全部</button>
            <button onClick={()=>downloadZip("image/webp")} className="px-3 py-1.5 rounded-lg bg-neutral-900 text-white hover:opacity-90">全部 WebP</button>
            <button onClick={clearAll} className="px-3 py-1.5 rounded-lg bg-neutral-200 dark:bg-neutral-800">清空</button>
          </div>
        </header>

        {/* 進階設定面板 */}
        {showAdvanced && (
          <section className="mt-4 border rounded-xl p-3 text-sm bg-white dark:bg-neutral-800">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={settings.outJPEG} onChange={(e)=>setSettings(s=>({...s, outJPEG: e.target.checked}))} />
                輸出 JPEG
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={settings.outWebP} onChange={(e)=>setSettings(s=>({...s, outWebP: e.target.checked}))} />
                輸出 WebP（透明自動只輸出 WebP）
              </label>
              <label className="flex items-center gap-2">
                長邊上限
                <input type="number" min={1200} max={5000} step={100} value={settings.longEdge} onChange={(e)=>setSettings(s=>({...s, longEdge: Math.max(1200, Math.min(5000, Number(e.target.value)||DEFAULT_MAX_LONG_EDGE))}))} className="w-24 px-2 py-1 rounded border bg-white dark:bg-neutral-900"/>
                px
              </label>
              <label className="flex items-center gap-2">
                並行數
                <select value={settings.concurrency} onChange={(e)=>setSettings(s=>({...s, concurrency: Number(e.target.value)}))} className="px-2 py-1 rounded border bg-white dark:bg-neutral-900">
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
              <label className="flex items-center gap-2 col-span-full">
                檔名模板
                <input
                  value={settings.filenameTpl}
                  onChange={(e)=>setSettings(s=>({...s, filenameTpl: e.target.value }))}
                  className="flex-1 px-2 py-1 rounded border bg-white dark:bg-neutral-900"
                  placeholder="{name}__{fmt}_q{q}_{w}w.{ext}"
                />
              </label>
            </div>
            <div className="text-xs text-neutral-500 mt-2">可用變數：{`{name} {fmt} {q} {w} {ext}`}</div>
            <div className="mt-2">
              <button onClick={recompressAll} className="px-3 py-1.5 rounded bg-black text-white">套用到現有任務並重壓</button>
            </div>
          </section>
        )}

        {/* 上傳區 */}
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          className="mt-6 border-2 border-dashed rounded-2xl p-8 text-center hover:border-neutral-400 transition-colors cursor-pointer"
          onClick={() => document.getElementById("fileInput")?.click()}
        >
          <input id="fileInput" type="file" accept="image/jpeg,image/jpg,image/png" className="hidden" multiple onChange={(e)=>enqueueFiles(e.target.files)} />
          <div className="text-lg">拖放圖片到這裡，或 <span className="underline">點此選擇檔案</span></div>
          <div className="text-xs text-neutral-500 mt-1">支援多檔 JPG / PNG，單檔 ≤ {MAX_FILE_MB} MB</div>
        </div>

        {/* 錯誤訊息 */}
        {errorMsg && <div className="mt-4 text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 text-sm">{errorMsg}</div>}

        {/* 佇列清單 */}
        <section className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {jobs.map(job => (
            <article key={job.id} className="border rounded-xl p-3">
              <div className="aspect-square w-full overflow-hidden rounded-lg border bg-white">
                <img src={job.url} alt={job.name} className="w-full h-full object-contain" />
              </div>
              <div className="mt-2 text-sm">
                <div className="font-medium truncate" title={job.name}>{job.name}</div>
                <div className="text-neutral-500">原大小：{formatBytes(job.size)}</div>
                {job.hasAlpha && <div className="mt-1 inline-block text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">保持透明（僅 WebP）</div>}
                <div className="flex items-center gap-2 mt-2">
                  {job.status === "queued" && <span className="px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800">等待中</span>}
                  {job.status === "processing" && <span className="px-2 py-0.5 rounded bg-blue-600 text-white animate-pulse">處理中…</span>}
                  {job.status === "done" && <span className="px-2 py-0.5 rounded bg-emerald-600 text-white">完成</span>}
                  {job.status === "error" && <span className="px-2 py-0.5 rounded bg-red-600 text-white">失敗</span>}
                  {job.status !== "done" && job.status !== "error" && (
                    <button onClick={()=>cancelJob(job.id)} className="ml-auto px-2 py-0.5 rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700">取消</button>
                  )}
                  {(job.status === "done" || job.status === "error" || job.status === "canceled") && (
                    <button onClick={()=>removeJob(job.id)} className="ml-auto px-2 py-0.5 rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700">移除</button>
                  )}
                </div>

                {/* 結果列 */}
                {job.status === "done" && (
                  <div className="mt-3 space-y-2">
                    {job.results.map((r, idx) => (
                      <div key={idx} className="border rounded-lg p-2">
                        <div className="flex items-center justify-between text-xs">
                          <div className="font-medium">{r.label}</div>
                          <div className="text-neutral-500">{r.mime} · {r.ms} ms</div>
                        </div>
                        <div className="mt-1 text-sm flex items-center gap-2">
                          {/* 這裡用 flex-1 + min-w-0，避免被右側按鈕擠到看不到壓縮率 */}
                          <div className="flex-1 min-w-0 truncate" title={`大小：${formatBytes(r.size)}  壓縮率：${Math.round(r.ratio*100)}%`}>
                            大小：{formatBytes(r.size)}　壓縮率：{Math.round(r.ratio*100)}%
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            <button onClick={()=>setCompare({ jobId: job.id, idx })} className="px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-xs">對比</button>
                            <button
                              onClick={()=>ensureHeatmap(job, idx)}
                              className="px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-xs"
                              disabled={heatBusy === `${job.id}-${idx}`}
                            >{heatBusy === `${job.id}-${idx}`?"熱圖生成中…":(r.heatmapUrl?"重新生成熱圖":"差異熱圖")}</button>
                            {r.heatmapUrl && (
                              <a href={r.heatmapUrl} download={`${job.name.replace(/\.[^.]+$/, "")}__heatmap_${settings.longEdge}w.png`} className="px-2 py-1 rounded bg-black text-white text-xs">下載熱圖</a>
                            )}
                            <a
                              href={r.url}
                              download={
                                settings.filenameTpl
                                  .replaceAll("{name}", job.name.replace(/\.[^.]+$/, ""))
                                  .replaceAll("{fmt}", r.mime === "image/jpeg" ? "jpg" : "webp")
                                  .replaceAll("{q}", String(Math.round((r.mime==="image/jpeg"?PRESETS[preset].jpg:PRESETS[preset].webp)*100)))
                                  .replaceAll("{w}", String(settings.longEdge))
                                  .replaceAll("{ext}", r.mime === "image/jpeg" ? "jpg" : "webp")
                              }
                              className="px-3 py-1 rounded bg-black text-white hover:opacity-90"
                            >下載</a>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {job.status === "error" && (
                  <div className="mt-3 text-xs text-red-600">{job.error || "壓縮失敗"}</div>
                )}
              </div>
            </article>
          ))}
        </section>

        {/* 對比視窗 */}
        {compare && (() => {
          const job = jobs.find(j => j.id === compare.jobId);
          if (!job) return null; const r = job.results[compare.idx];
          return (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={()=>setCompare(null)}>
              <div className="bg-white dark:bg-neutral-900 rounded-2xl p-4 w-full max-w-5xl" onClick={(e)=>e.stopPropagation()}>
                <div className="flex items-center justify-between mb-2 text-sm">
                  <div className="font-medium">對比：原圖 vs {r.label}（空白鍵 A/B）</div>
                  <div className="flex items-center gap-2">
                    <button onClick={()=>setMagnify(m=>!m)} className="px-2 py-1 rounded bg-neutral-200 dark:bg-neutral-800">{magnify?"關閉放大鏡":"放大鏡"}</button>
                    <button onClick={()=>setCompare(null)} className="px-2 py-1 rounded bg-neutral-200 dark:bg-neutral-800">關閉</button>
                  </div>
                </div>
                <div className="w-full">
                  {magnify ? (
                    <Magnifier baseUrl={job.url} altUrl={r.url} zoom={2.5} diameter={220} />
                  ) : (
                    abToggle ? (
                      <img src={r.url} alt="B" className="w-full h-auto object-contain rounded" />
                    ) : (
                      <ReactCompareImage leftImage={job.url} rightImage={r.url} sliderLineColor="#000" />
                    )
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* 操作說明彈窗 */}
        {showInfo && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={()=>setShowInfo(false)}>
            <div className="bg-white dark:bg-neutral-900 rounded-2xl p-4 w-full max-w-2xl text-sm" onClick={(e)=>e.stopPropagation()}>
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">操作說明</div>
                <button onClick={()=>setShowInfo(false)} className="px-2 py-1 rounded bg-neutral-200 dark:bg-neutral-800">關閉</button>
              </div>
              <ul className="list-disc pl-5 space-y-1">
                <li>拖放或選擇 JPG/PNG 圖片，單檔 ≤ {MAX_FILE_MB}MB。所有處理皆在本機，圖片不會上傳。</li>
                <li>「場景」代表壓縮強度：
                  <ul className="list-disc pl-5 mt-1">
                    <li>社群：JPG ≈{Math.round(PRESETS.social.jpg*100)} / WebP ≈{Math.round(PRESETS.social.webp*100)}（較小檔案）</li>
                    <li>網站：JPG ≈{Math.round(PRESETS.web.jpg*100)} / WebP ≈{Math.round(PRESETS.web.webp*100)}（平衡）</li>
                    <li>高品質：JPG ≈{Math.round(PRESETS.high.jpg*100)} / WebP ≈{Math.round(PRESETS.high.webp*100)}（近原圖）</li>
                  </ul>
                </li>
                <li>透明 PNG 會自動以 WebP 保留透明；不輸出 JPEG。</li>
                <li>進階設定可調整輸出格式、長邊上限、並行數，以及檔名模板（可用 {`{name} {fmt} {q} {w} {ext}` }）。</li>
                <li>對比視窗支援滑桿、A/B（空白鍵）與放大鏡；也可生成差異熱圖，快速看出失真處。</li>
              </ul>
            </div>
          </div>
        )}

        {/* 底部提示 */}
        <footer className="mt-10 text-xs text-neutral-500 space-y-1">
          <div>長邊 &gt; 4000px 會先縮到設定的上限（預設 {DEFAULT_MAX_LONG_EDGE}px），以降低記憶體與時間。</div>
          <div>透明 PNG 自動以 WebP 方式保留透明背景，不輸出 JPEG。</div>
        </footer>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { demoPlans } from "@/lib/demo";
import type { PlanMode, Segment } from "@/lib/types";

const formatTime = (ms: number) => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function Waveform({ active }: { active: boolean }) {
  return (
    <div className={`waveform ${active ? "is-playing" : ""}`} aria-hidden="true">
      {Array.from({ length: 96 }, (_, index) => (
        <i
          key={index}
          style={{ height: `${18 + ((index * 29) % 62)}%`, animationDelay: `${index * 18}ms` }}
        />
      ))}
      <span className="playhead" />
    </div>
  );
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

const apiUrl = (path: string) => `${API_BASE}${path}`;

const apiHeaders = (headers?: HeadersInit): HeadersInit => ({
  ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
  ...headers,
});

const withMediaAuth = (url: string) => {
  if (!API_KEY || url.startsWith("blob:")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}api_key=${encodeURIComponent(API_KEY)}`;
};

const mediaUrl = (path: string) => {
  if (path.startsWith("blob:") || path.startsWith("http://") || path.startsWith("https://")) {
    return withMediaAuth(path);
  }
  if (API_BASE.startsWith("http://") || API_BASE.startsWith("https://")) {
    return withMediaAuth(`${new URL(API_BASE).origin}${path}`);
  }
  return withMediaAuth(path);
};

const readDuration = (url: string) =>
  new Promise<number | null>((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => resolve(null);
  });

export default function Studio() {
  const [mode, setMode] = useState<PlanMode>("conservative");
  const [timelines, setTimelines] = useState(demoPlans);
  const [playing, setPlaying] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sourceFile, setSourceFile] = useState("episode-04-final.wav");
  const [mediaSrc, setMediaSrc] = useState("");
  const [durationMs, setDurationMs] = useState(116800);
  const [currentMs, setCurrentMs] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState("");
  const [uploadState, setUploadState] = useState<"ready" | "uploading" | "analyzing" | "error">("ready");
  const fileInput = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const localUrlRef = useRef<string | null>(null);
  const segments = timelines[mode];

  const kept = useMemo(() => segments.filter((item) => item.action === "keep"), [segments]);
  const removedMs = useMemo(
    () =>
      segments
        .filter((item) => item.action === "delete")
        .reduce((sum, item) => sum + item.source_end - item.source_start, 0),
    [segments],
  );
  const outputMs = kept.reduce((sum, item) => sum + item.source_end - item.source_start, 0);
  const progress = durationMs ? Math.min(100, Math.max(0, (currentMs / durationMs) * 100)) : 0;

  useEffect(() => {
    return () => {
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!mediaSrc) {
      setPlaying(false);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [playing, mediaSrc]);

  const update = (next: Segment[]) => {
    setSaved(false);
    setTimelines((current) => ({ ...current, [mode]: next }));
  };

  const toggleSegment = (id: string) => {
    update(
      segments.map((item) =>
        item.segment_id === id
          ? {
              ...item,
              action: item.action === "keep" ? "delete" : "keep",
              reason: item.action === "keep" ? "人工删除" : "人工恢复",
            }
          : item,
      ),
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= segments.length) return;
    const next = [...segments];
    [next[index], next[target]] = [next[target], next[index]];
    update(next.map((item, output_order) => ({ ...item, output_order })));
  };

  const runExport = () => {
    setSaved(true);
    setExporting(true);
    window.setTimeout(() => setExporting(false), 1600);
  };

  const pollJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(apiUrl(`/jobs/${jobId}`), { headers: apiHeaders() });
      if (!response.ok) return;
      const job = await response.json();
      setJobStage(`${job.stage} · ${job.progress}%`);
      if (["review", "completed", "failed"].includes(job.status)) return;
      await new Promise((resolve) => window.setTimeout(resolve, 800));
    }
  };

  const selectFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024 * 1024) {
      window.alert("文件超过 2GB 上限");
      return;
    }
    const audioSuffixes = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"];
    const hasAudioSuffix = audioSuffixes.some((suffix) => file.name.toLowerCase().endsWith(suffix));
    if ((!file.type && !hasAudioSuffix) || (file.type && !file.type.startsWith("audio/") && !hasAudioSuffix)) {
      window.alert("请选择音频文件");
      return;
    }

    if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    const localUrl = URL.createObjectURL(file);
    localUrlRef.current = localUrl;
    setSourceFile(file.name);
    setMediaSrc(localUrl);
    setCurrentMs(0);
    setPlaying(false);
    setUploadState("uploading");
    setJobStage("正在上传本地音频");

    try {
      const detectedDuration = await readDuration(localUrl);
      if (detectedDuration) setDurationMs(detectedDuration);

      const projectResponse = await fetch(apiUrl("/projects"), {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ title: file.name.replace(/\.[^.]+$/, "") || "未命名播客" }),
      });
      if (!projectResponse.ok) throw new Error("创建项目失败");
      const project = await projectResponse.json();
      setProjectId(project.id);

      const form = new FormData();
      form.append("file", file);
      const uploadResponse = await fetch(apiUrl(`/projects/${project.id}/source`), {
        method: "POST",
        headers: apiHeaders(),
        body: form,
      });
      if (!uploadResponse.ok) throw new Error(await uploadResponse.text());
      const upload = await uploadResponse.json();
      setMediaSrc(mediaUrl(upload.media_url));
      setUploadState("analyzing");
      setJobStage("正在转写与生成剪辑提案");

      const processResponse = await fetch(apiUrl(`/projects/${project.id}/process`), {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ object_key: upload.object_key, duration_ms: detectedDuration }),
      });
      if (!processResponse.ok) throw new Error("启动分析失败");
      const job = await processResponse.json();
      await pollJob(job.id);

      const plansResponse = await fetch(apiUrl(`/projects/${project.id}/plans`), { headers: apiHeaders() });
      if (plansResponse.ok) {
        const data = await plansResponse.json();
        const next = { ...demoPlans };
        for (const plan of data.plans || []) {
          if (plan.mode === "conservative" || plan.mode === "restructured") {
            next[plan.mode as PlanMode] = plan.segments;
          }
        }
        setTimelines(next);
      }
      setUploadState("ready");
    } catch (error) {
      setUploadState("error");
      setJobStage(error instanceof Error ? error.message : "上传或分析失败");
    }
  };

  const togglePlayback = () => {
    if (!mediaSrc) {
      fileInput.current?.click();
      return;
    }
    setPlaying((value) => !value);
  };

  const playSegment = (segment: Segment) => {
    if (!mediaSrc || !audioRef.current) {
      fileInput.current?.click();
      return;
    }
    audioRef.current.currentTime = segment.source_start / 1000;
    setCurrentMs(segment.source_start);
    setPlaying(true);
  };

  return (
    <main>
      <audio
        ref={audioRef}
        src={mediaSrc}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration)) setDurationMs(Math.round(duration * 1000));
        }}
        onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1000))}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <header className="topbar">
        <a className="brand" href="#" aria-label="声裁首页">
          <span className="brand-mark">声</span>
          <span>声裁</span>
          <small>PODCAST CUTTER</small>
        </a>
        <div className="project-meta">
          <span className="status-dot" />
          <span>项目 04</span>
          <strong>AI 落地，不从模型开始</strong>
        </div>
        <nav>
          <button className="text-button">版本记录 <b>3</b></button>
          <button className="avatar">林</button>
        </nav>
      </header>

      <section className="hero-strip">
        <div>
          <p className="eyebrow">AUTOMATED ROUGH CUT / 2026.06.12</p>
          <h1>先听结构，<br />再决定<span>删什么。</span></h1>
        </div>
        <div className="hero-note">
          <span>原始音频</span>
          <strong>{formatTime(durationMs)}</strong>
          <small className="source-name">{sourceFile}</small>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.flac"
            hidden
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
          <button
            className="replace-file"
            onClick={() => fileInput.current?.click()}
            disabled={uploadState === "uploading" || uploadState === "analyzing"}
          >
            {uploadState === "uploading"
              ? "正在上传音频"
              : uploadState === "analyzing"
                ? "正在转写与分析"
                : uploadState === "error"
                  ? "上传失败，重新选择"
                  : "更换音频文件 ↗"}
          </button>
        </div>
        <div className="hero-note accent">
          <span>预计成片</span>
          <strong>{formatTime(outputMs)}</strong>
          <small>已精简 {formatTime(removedMs)}</small>
        </div>
      </section>

      <section className="transport">
        <button className="play" onClick={togglePlayback}>
          {playing ? "Ⅱ" : "▶"}
        </button>
        <div className="timecode">
          <strong>{formatTime(currentMs)}</strong>
          <span>/ {formatTime(durationMs)}</span>
        </div>
        <div className="waveform-shell" style={{ "--progress": `${progress}%` } as CSSProperties}>
          <Waveform active={playing} />
        </div>
        <button className="speed">1.0×</button>
      </section>
      {jobStage ? (
        <div className={`job-status ${uploadState === "error" ? "error" : ""}`}>
          <span>{projectId ? `项目 ${projectId.slice(0, 8)}` : "本地预览"}</span>
          <strong>{jobStage}</strong>
        </div>
      ) : null}

      <section className="workspace">
        <aside className="plan-panel">
          <p className="section-label">AI 剪辑提案</p>
          <div className="plan-switch">
            <button className={mode === "conservative" ? "active" : ""} onClick={() => setMode("conservative")}>
              <span>01</span>
              <strong>保守版</strong>
              <small>忠于原始叙事</small>
            </button>
            <button className={mode === "restructured" ? "active" : ""} onClick={() => setMode("restructured")}>
              <span>02</span>
              <strong>重构版</strong>
              <small>按主题重排</small>
            </button>
          </div>

          <div className="analysis-card">
            <div className="analysis-head">
              <span>编辑判断</span>
              <em>{mode === "conservative" ? "LOW RISK" : "NEW ARC"}</em>
            </div>
            <p>
              {mode === "conservative"
                ? "保持原有问答推进，仅处理明显跑题、重复确认和长停顿。"
                : "将结论提前，随后按“问题—方法—案例—落地”重新建立叙事弧线。"}
            </p>
            <dl>
              <div><dt>保留段落</dt><dd>{kept.length}</dd></div>
              <div><dt>删除段落</dt><dd>{segments.length - kept.length}</dd></div>
              <div><dt>平均置信度</dt><dd>92%</dd></div>
            </dl>
          </div>

          <div className="legend">
            <p><i className="keep" /> 保留在成片</p>
            <p><i className="cut" /> 建议删除</p>
            <p><i className="moved" /> AI 调整顺序</p>
          </div>
        </aside>

        <section className="timeline-panel">
          <div className="timeline-head">
            <div>
              <p className="section-label">文字时间线</p>
              <h2>{mode === "conservative" ? "原叙事精简" : "主题重构"}</h2>
            </div>
            <div className="timeline-actions">
              <span>{saved ? "已保存版本 04" : "有未保存修改"}</span>
              <button onClick={() => setSaved(true)}>保存版本</button>
            </div>
          </div>

          <div className="segments">
            {segments.map((segment, index) => (
              <article className={`segment ${segment.action === "delete" ? "deleted" : ""}`} key={segment.segment_id}>
                <div className="segment-order">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <button onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移">↑</button>
                    <button onClick={() => move(index, 1)} disabled={index === segments.length - 1} aria-label="下移">↓</button>
                  </div>
                </div>
                <button className="segment-play" onClick={() => playSegment(segment)}>▶</button>
                <div className="segment-copy">
                  <div className="segment-kicker">
                    <time>{formatTime(segment.source_start)} — {formatTime(segment.source_end)}</time>
                    <span>{segment.speaker}</span>
                    <em>{segment.reason}</em>
                  </div>
                  <p>{segment.text}</p>
                </div>
                <div className="segment-decision">
                  <span>{Math.round(segment.confidence * 100)}%</span>
                  <button onClick={() => toggleSegment(segment.segment_id)}>
                    {segment.action === "keep" ? "删除" : "恢复"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      <footer className="export-bar">
        <div>
          <span className="export-index">FINAL / 04</span>
          <p><strong>{kept.length}</strong> 个片段 · 目标响度 <strong>-16 LUFS</strong> · 接缝交叉淡化 <strong>40ms</strong></p>
        </div>
        <div className="format">
          <button className="selected">MP3 <small>192 kbps</small></button>
          <button className="selected">WAV <small>48k / 24bit</small></button>
        </div>
        <button className="export-button" onClick={runExport} disabled={exporting}>
          <span>{exporting ? "正在排队导出" : "确认并导出"}</span>
          <b>{exporting ? "···" : "↗"}</b>
        </button>
      </footer>
    </main>
  );
}

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
const AUTH_STORAGE_KEY = "podcast-cut-auth";

const apiUrl = (path: string) => `${API_BASE}${path}`;

const apiHeaders = (headers?: HeadersInit, token?: string): HeadersInit => ({
  ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...headers,
});

const withMediaAuth = (url: string, token?: string) => {
  if ((!API_KEY && !token) || url.startsWith("blob:")) return url;
  const separator = url.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  if (API_KEY) params.set("api_key", API_KEY);
  if (token) params.set("session_token", token);
  return `${url}${separator}${params.toString()}`;
};

const mediaUrl = (path: string, token?: string) => {
  if (path.startsWith("blob:") || path.startsWith("http://") || path.startsWith("https://")) {
    return withMediaAuth(path, token);
  }
  if (API_BASE.startsWith("http://") || API_BASE.startsWith("https://")) {
    return withMediaAuth(`${new URL(API_BASE).origin}${path}`, token);
  }
  return withMediaAuth(path, token);
};

const readDuration = (url: string) =>
  new Promise<number | null>((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => resolve(null);
  });

type JobRead = {
  status: "uploaded" | "transcribing" | "analyzing" | "review" | "exporting" | "completed" | "failed";
  stage: string;
  progress: number;
  error_message?: string | null;
};

type TimelineVersionRead = {
  id: string;
  version?: number;
  title?: string;
  timeline?: Segment[];
  created_at?: string;
};

type ExportRead = {
  id: string;
  format: string;
  status: JobRead["status"];
  download_url?: string | null;
};

type PreviewRead = {
  media_url: string;
  duration_ms: number;
};

type UserRead = {
  id: string;
  email: string;
  display_name: string;
};

type AuthRead = {
  token: string;
  user: UserRead;
};

const storedAuth = (): AuthRead | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthRead) : null;
  } catch {
    return null;
  }
};

export default function Studio() {
  const [mode, setMode] = useState<PlanMode>("conservative");
  const [timelines, setTimelines] = useState(demoPlans);
  const [playing, setPlaying] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [sourceFile, setSourceFile] = useState("episode-04-final.wav");
  const [mediaSrc, setMediaSrc] = useState("");
  const [originalMediaSrc, setOriginalMediaSrc] = useState("");
  const [durationMs, setDurationMs] = useState(116800);
  const [originalDurationMs, setOriginalDurationMs] = useState(116800);
  const [currentMs, setCurrentMs] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectAuthToken, setProjectAuthToken] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState("");
  const [exportDownloads, setExportDownloads] = useState<ExportRead[]>([]);
  const [previewSegmentStarts, setPreviewSegmentStarts] = useState<Record<string, number>>({});
  const [uploadState, setUploadState] = useState<"ready" | "uploading" | "analyzing" | "error">("ready");
  const [authToken, setAuthToken] = useState("");
  const [user, setUser] = useState<UserRead | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<TimelineVersionRead[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const localUrlRef = useRef<string | null>(null);
  const segments = timelines[mode];
  const projectToken = projectAuthToken ?? authToken;

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
    const auth = storedAuth();
    if (!auth) return;
    setAuthToken(auth.token);
    setUser(auth.user);
    fetch(apiUrl("/auth/me"), { headers: apiHeaders(undefined, auth.token) })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((nextUser: UserRead) => {
        const next = { token: auth.token, user: nextUser };
        setUser(nextUser);
        window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
      })
      .catch(() => {
        setAuthToken("");
        setUser(null);
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      });
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

  const restoreOriginalPreview = () => {
    if (originalMediaSrc && mediaSrc !== originalMediaSrc) {
      setMediaSrc(originalMediaSrc);
      setDurationMs(originalDurationMs);
      setCurrentMs(0);
      setPlaying(false);
      setPreviewSegmentStarts({});
      setJobStage("预览已回到原始音频，点击应用刷新剪辑预览");
    }
  };

  const update = (next: Segment[]) => {
    setSaved(false);
    restoreOriginalPreview();
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

  const loadVersions = async (targetProjectId = projectId) => {
    if (!targetProjectId) return [];
    const response = await fetch(apiUrl(`/projects/${targetProjectId}/timeline`), { headers: apiHeaders(undefined, projectToken) });
    if (!response.ok) return [];
    const data = (await response.json()) as TimelineVersionRead[];
    setVersions(data);
    return data;
  };

  const saveCurrentTimeline = async (title = `${mode === "conservative" ? "保守版" : "重构版"}人工剪辑`) => {
    if (!projectId) {
      window.alert("请先上传并完成转写，再保存版本");
      return null;
    }
    const response = await fetch(apiUrl(`/projects/${projectId}/timeline`), {
      method: "PUT",
      headers: apiHeaders({ "Content-Type": "application/json" }, projectToken),
      body: JSON.stringify({ title, segments }),
    });
    if (!response.ok) throw new Error(await response.text());
    const timeline = (await response.json()) as TimelineVersionRead;
    setSaved(true);
    await loadVersions(projectId);
    return timeline;
  };

  const submitAuth = async () => {
    const path = authMode === "login" ? "/auth/login" : "/auth/register";
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        email: authEmail,
        password: authPassword,
        ...(authMode === "register" ? { display_name: authName } : {}),
      }),
    });
    if (!response.ok) {
      setJobStage(await response.text());
      return;
    }
    const auth = (await response.json()) as AuthRead;
    setAuthToken(auth.token);
    setUser(auth.user);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
    setAuthOpen(false);
    setAuthPassword("");
    setJobStage(`已登录：${auth.user.display_name}`);
  };

  const logout = async () => {
    if (authToken) {
      await fetch(apiUrl("/auth/logout"), { method: "POST", headers: apiHeaders(undefined, authToken) }).catch(() => null);
    }
    setAuthToken("");
    setUser(null);
    setAuthOpen(false);
    setProjectId(null);
    setProjectAuthToken(null);
    setVersions([]);
    setMediaSrc("");
    setOriginalMediaSrc("");
    setCurrentMs(0);
    setPlaying(false);
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    setJobStage("已退出登录");
  };

  const runExport = async () => {
    if (!projectId) {
      window.alert("请先上传并完成转写，再导出剪辑结果");
      return;
    }
    setExporting(true);
    setExportDownloads([]);
    setJobStage("保存人工剪辑时间线");
    try {
      const timelineResponse = await fetch(apiUrl(`/projects/${projectId}/timeline`), {
        method: "PUT",
        headers: apiHeaders({ "Content-Type": "application/json" }, projectToken),
        body: JSON.stringify({
          title: `${mode === "conservative" ? "保守版" : "重构版"}人工剪辑`,
          segments,
        }),
      });
      if (!timelineResponse.ok) throw new Error(await timelineResponse.text());
      const timeline = (await timelineResponse.json()) as TimelineVersionRead;
      setSaved(true);
      await loadVersions(projectId);
      setJobStage("提交音频导出任务");

      const exportResponse = await fetch(apiUrl(`/projects/${projectId}/export`), {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }, projectToken),
        body: JSON.stringify({ timeline_version_id: timeline.id, formats: ["mp3", "wav"] }),
      });
      if (!exportResponse.ok) throw new Error(await exportResponse.text());
      const job = (await exportResponse.json()) as { id: string };
      await pollJob(job.id);

      const exportsResponse = await fetch(apiUrl(`/projects/${projectId}/exports`), { headers: apiHeaders(undefined, projectToken) });
      if (!exportsResponse.ok) throw new Error("读取导出文件失败");
      const rows = ((await exportsResponse.json()) as ExportRead[]).filter((item) => item.download_url);
      setExportDownloads(rows);
      setJobStage("导出完成，可下载成片");
    } catch (error) {
      setJobStage(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  const previewStartsFor = (items: Segment[]) => {
    let cursor = 0;
    const starts: Record<string, number> = {};
    for (const segment of [...items].filter((item) => item.action === "keep").sort((a, b) => a.output_order - b.output_order)) {
      starts[segment.segment_id] = cursor;
      cursor += segment.source_end - segment.source_start;
    }
    return starts;
  };

  const applyPreview = async () => {
    if (!projectId) {
      window.alert("请先上传并完成转写，再应用预览");
      return;
    }
    if (!kept.length) {
      window.alert("至少保留一个片段才能生成预览");
      return;
    }
    setApplying(true);
    setPlaying(false);
    setJobStage("正在应用剪辑到本地预览");
    try {
      const response = await fetch(apiUrl(`/projects/${projectId}/preview`), {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }, projectToken),
        body: JSON.stringify({
          title: `${mode === "conservative" ? "保守版" : "重构版"}预览`,
          segments,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const preview = (await response.json()) as PreviewRead;
      setMediaSrc(mediaUrl(preview.media_url, projectToken));
      setDurationMs(preview.duration_ms);
      setCurrentMs(0);
      setPreviewSegmentStarts(previewStartsFor(segments));
      setJobStage("已应用到预览播放器");
    } catch (error) {
      setJobStage(error instanceof Error ? error.message : "应用预览失败");
    } finally {
      setApplying(false);
    }
  };

  const pollJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 3600; attempt += 1) {
      const response = await fetch(apiUrl(`/jobs/${jobId}`), { headers: apiHeaders(undefined, projectToken) });
      if (!response.ok) throw new Error("读取任务进度失败");
      const job = (await response.json()) as JobRead;
      setJobStage(`${job.stage} · ${job.progress}%`);
      if (job.status === "failed") throw new Error(job.error_message || job.stage || "分析失败");
      if (job.status === "review" || job.status === "completed") return job;
      await new Promise((resolve) => window.setTimeout(resolve, attempt < 10 ? 800 : 2000));
    }
    throw new Error("分析仍在运行，请稍后刷新查看进度");
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
    setOriginalMediaSrc(localUrl);
    setCurrentMs(0);
    setPlaying(false);
    setPreviewSegmentStarts({});
    setUploadState("uploading");
    setJobStage("正在上传本地音频");

    try {
      const detectedDuration = await readDuration(localUrl);
      if (detectedDuration) {
        setDurationMs(detectedDuration);
        setOriginalDurationMs(detectedDuration);
      }

      const projectResponse = await fetch(apiUrl("/projects"), {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }, authToken),
        body: JSON.stringify({ title: file.name.replace(/\.[^.]+$/, "") || "未命名播客" }),
      });
      if (!projectResponse.ok) throw new Error("创建项目失败");
      const project = await projectResponse.json();
      setProjectId(project.id);
      setProjectAuthToken(authToken);

      const form = new FormData();
      form.append("file", file);
      const uploadResponse = await fetch(apiUrl(`/projects/${project.id}/source`), {
        method: "POST",
        headers: apiHeaders(undefined, authToken),
        body: form,
      });
      if (!uploadResponse.ok) throw new Error(await uploadResponse.text());
      const upload = await uploadResponse.json();
      const serverMedia = mediaUrl(upload.media_url, authToken);
      setMediaSrc(serverMedia);
      setOriginalMediaSrc(serverMedia);
      setUploadState("analyzing");
      setJobStage("正在转写与生成剪辑提案");

      const processResponse = await fetch(apiUrl(`/projects/${project.id}/process`), {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }, authToken),
        body: JSON.stringify({ object_key: upload.object_key, duration_ms: detectedDuration }),
      });
      if (!processResponse.ok) throw new Error("启动分析失败");
      const job = await processResponse.json();
      await pollJob(job.id);

      const plansResponse = await fetch(apiUrl(`/projects/${project.id}/plans`), { headers: apiHeaders(undefined, authToken) });
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
      await loadVersions(project.id);
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
    const previewStart = previewSegmentStarts[segment.segment_id];
    if (Object.keys(previewSegmentStarts).length && previewStart === undefined) return;
    const start = previewStart ?? segment.source_start;
    audioRef.current.currentTime = start / 1000;
    setCurrentMs(start);
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
          <button
            className="text-button"
            onClick={async () => {
              await loadVersions();
              setVersionsOpen(true);
            }}
          >
            版本记录 <b>{versions.length}</b>
          </button>
          <button
            className="avatar"
            onClick={() => {
              setAuthOpen((value) => !value);
              setVersionsOpen(false);
            }}
          >
            {(user?.display_name || user?.email || "访").slice(0, 1).toUpperCase()}
          </button>
        </nav>
      </header>
      {authOpen ? (
        <div className="popover auth-popover">
          <div className="popover-head">
            <strong>{user ? user.display_name : authMode === "login" ? "登录" : "注册"}</strong>
            <button onClick={() => setAuthOpen(false)}>×</button>
          </div>
          {user ? (
            <>
              <p>{user.email}</p>
              <button className="wide-action" onClick={logout}>退出登录</button>
            </>
          ) : (
            <>
              <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="邮箱" />
              <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="密码" type="password" />
              {authMode === "register" ? (
                <input value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="昵称" />
              ) : null}
              <button className="wide-action" onClick={submitAuth}>{authMode === "login" ? "登录" : "注册"}</button>
              <button className="link-action" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
                {authMode === "login" ? "创建新账号" : "已有账号，去登录"}
              </button>
            </>
          )}
        </div>
      ) : null}
      {versionsOpen ? (
        <div className="popover versions-popover">
          <div className="popover-head">
            <strong>版本记录</strong>
            <button onClick={() => setVersionsOpen(false)}>×</button>
          </div>
          {versions.length ? (
            versions.map((item) => (
              <button
                className="version-row"
                key={item.id}
                onClick={() => {
                  if (item.timeline) {
                    restoreOriginalPreview();
                    setTimelines((current) => ({ ...current, [mode]: item.timeline as Segment[] }));
                    setSaved(true);
                  }
                  setVersionsOpen(false);
                }}
              >
                <strong>版本 {item.version}</strong>
                <span>{item.title}</span>
              </button>
            ))
          ) : (
            <p>当前项目还没有保存版本</p>
          )}
        </div>
      ) : null}

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
              <button onClick={applyPreview} disabled={applying || uploadState !== "ready"}>
                {applying ? "应用中" : "应用"}
              </button>
              <button onClick={() => saveCurrentTimeline().catch((error) => setJobStage(error instanceof Error ? error.message : "保存版本失败"))}>
                保存版本
              </button>
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
        {exportDownloads.length ? (
          <div className="download-list">
            {exportDownloads.map((item) => (
              <a key={item.id} href={mediaUrl(item.download_url || "", projectToken)} download>
                下载 {item.format.toUpperCase()}
              </a>
            ))}
          </div>
        ) : null}
      </footer>
    </main>
  );
}

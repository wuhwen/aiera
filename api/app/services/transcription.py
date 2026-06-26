from functools import lru_cache
from pathlib import Path
from typing import Callable

ProgressCallback = Callable[[str, int], None]


def _ms(seconds: float) -> int:
    return max(0, int(round(seconds * 1000)))


@lru_cache(maxsize=2)
def _load_model(model_name: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe_with_faster_whisper(
    audio_path: Path,
    *,
    model_name: str,
    device: str,
    compute_type: str,
    language: str | None,
    beam_size: int,
    on_progress: ProgressCallback | None = None,
) -> list[dict]:
    if not audio_path.exists():
        raise FileNotFoundError(f"source audio not found: {audio_path}")

    if on_progress:
        on_progress("加载 faster-whisper 模型", 22)
    model = _load_model(model_name, device, compute_type)
    if on_progress:
        on_progress("模型就绪，开始语音识别", 28)
    segments, _ = model.transcribe(
        str(audio_path),
        language=language or None,
        beam_size=beam_size,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )

    rows: list[dict] = []
    for index, segment in enumerate(segments):
        text = segment.text.strip()
        if not text:
            continue
        start = _ms(segment.start)
        end = max(start + 1, _ms(segment.end))
        if on_progress:
            on_progress(f"已转写 {index + 1} 个语音片段", min(58, 32 + index))
        rows.append(
            {
                "segment_id": f"seg-{index + 1:04d}",
                "source_start": start,
                "source_end": end,
                "text": text,
                "speaker": "说话人",
            }
        )
    if not rows:
        raise RuntimeError("ASR returned no speech segments")
    return rows


def plans_from_transcript(transcript: list[dict]) -> tuple[list[dict], list[dict]]:
    conservative: list[dict] = []
    for output_order, segment in enumerate(transcript):
        conservative.append(
            {
                **segment,
                "output_order": output_order,
                "action": "keep",
                "reason": "真实转录片段",
                "confidence": 0.88,
            }
        )

    restructured = [{**segment, "reason": "按原始顺序保留，等待人工调整"} for segment in conservative]
    return conservative, restructured

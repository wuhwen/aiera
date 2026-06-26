import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

ProgressCallback = Callable[[str, int], None]


def _seconds(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def _concat_line(path: Path) -> str:
    return "file '" + str(path).replace("'", "'\\''") + "'\n"


def render_audio_export(
    *,
    source_path: Path,
    timeline: list[dict],
    output_path: Path,
    output_format: str,
    on_progress: ProgressCallback | None = None,
) -> None:
    kept = sorted(
        (segment for segment in timeline if segment.get("action") == "keep"),
        key=lambda segment: segment.get("output_order", 0),
    )
    if not kept:
        raise RuntimeError("timeline has no kept segments")
    if not source_path.exists():
        raise FileNotFoundError(f"source audio not found: {source_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_root = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
    with tempfile.TemporaryDirectory(prefix="podcast-export-", dir=tmp_root) as tmp_dir_name:
        tmp_dir = Path(tmp_dir_name)
        concat_file = tmp_dir / "segments.txt"
        segment_paths: list[Path] = []
        for index, segment in enumerate(kept):
            segment_path = tmp_dir / f"segment-{index:04d}.wav"
            if on_progress:
                on_progress(f"剪切第 {index + 1}/{len(kept)} 个保留片段", min(70, 10 + int(index / len(kept) * 55)))
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    _seconds(int(segment["source_start"])),
                    "-to",
                    _seconds(int(segment["source_end"])),
                    "-i",
                    str(source_path),
                    "-vn",
                    "-ac",
                    "2",
                    "-ar",
                    "48000",
                    "-c:a",
                    "pcm_s16le",
                    str(segment_path),
                ],
                check=True,
            )
            segment_paths.append(segment_path)

        concat_file.write_text("".join(_concat_line(path) for path in segment_paths), encoding="utf-8")
        if on_progress:
            on_progress(f"拼接 {len(kept)} 个音频片段", 76)

        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-vn",
        ]
        if output_format == "mp3":
            command += ["-c:a", "libmp3lame", "-b:a", "192k"]
        elif output_format == "wav":
            command += ["-c:a", "pcm_s16le"]
        else:
            raise RuntimeError(f"unsupported export format: {output_format}")
        command.append(str(output_path))
        subprocess.run(command, check=True)

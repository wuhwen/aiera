import time
from pathlib import Path

from celery import Celery
from sqlalchemy import select

from .database import SessionLocal
from .models import EditPlan, Export, Job, JobStatus, Project, TimelineVersion, Transcript
from .services.exporter import render_audio_export
from .services.providers import mock_result
from .services.transcription import plans_from_transcript, transcribe_with_faster_whisper
from .settings import get_settings

settings = get_settings()
storage_root = Path(settings.local_storage_dir).resolve()
celery_app = Celery("podcast-worker", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_reject_on_worker_lost=True,
    task_track_started=True,
)


def set_job(db, job: Job, project: Project, status: JobStatus, stage: str, progress: int) -> None:
    job.status = status
    job.stage = stage
    job.progress = progress
    project.status = status
    db.commit()


def local_object_path(object_key: str) -> Path:
    path = (storage_root / object_key).resolve()
    if not path.is_relative_to(storage_root):
        raise ValueError("invalid object key")
    return path


def export_object_key(project_id: str, export_id: str, export_format: str) -> str:
    return f"exports/{project_id}/{export_id}.{export_format}"


def build_processing_result(project: Project, progress):
    if settings.asr_provider == "mock":
        progress("使用演示 Provider 生成转录", 24)
        time.sleep(0.1)
        return "mock", mock_result()
    if settings.asr_provider != "faster_whisper":
        raise RuntimeError(f"Unsupported ASR provider: {settings.asr_provider}")
    if not project.source_object_key:
        raise RuntimeError("source audio not uploaded")

    progress("检查音频文件", 18)
    transcript = transcribe_with_faster_whisper(
        local_object_path(project.source_object_key),
        model_name=settings.whisper_model,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
        language=settings.whisper_language,
        beam_size=settings.whisper_beam_size,
        on_progress=progress,
    )
    progress(f"转写完成，共 {len(transcript)} 个片段", 60)
    conservative, restructured = plans_from_transcript(transcript)
    progress("已生成可编辑分段", 68)

    class Result:
        pass

    result = Result()
    result.transcript = transcript
    result.conservative = conservative
    result.restructured = restructured
    return f"faster-whisper:{settings.whisper_model}", result


@celery_app.task(
    bind=True,
    autoretry_for=(TimeoutError, ConnectionError),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=4,
)
def process_project(self, job_id: str) -> None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if not job or job.status in {JobStatus.review, JobStatus.completed}:
            return
        project = db.get(Project, job.project_id)
        try:
            job.attempt = self.request.retries + 1
            set_job(db, job, project, JobStatus.transcribing, "准备分析任务", 8)

            def progress(stage: str, progress_value: int) -> None:
                set_job(db, job, project, JobStatus.transcribing, stage, progress_value)

            provider, result = build_processing_result(project, progress)
            set_job(db, job, project, JobStatus.transcribing, "保存转录结果", 72)
            transcript = db.scalar(select(Transcript).where(Transcript.project_id == project.id))
            if not transcript:
                db.add(Transcript(project_id=project.id, segments=result.transcript, provider=provider))
                db.commit()
            set_job(db, job, project, JobStatus.analyzing, "生成剪辑方案", 78)
            if not db.scalars(select(EditPlan).where(EditPlan.project_id == project.id)).first():
                db.add_all(
                    [
                        EditPlan(
                            project_id=project.id,
                            mode="conservative",
                            timeline=result.conservative,
                            summary="保持原叙事顺序，移除一处跑题内容并标记口癖。",
                        ),
                        EditPlan(
                            project_id=project.id,
                            mode="restructured",
                            timeline=result.restructured,
                            summary="结论先行，随后按方法、案例和落地步骤重新组织。",
                        ),
                    ]
                )
                db.commit()
            set_job(db, job, project, JobStatus.analyzing, "整理时间线与审核材料", 92)
            set_job(db, job, project, JobStatus.review, "等待人工审核", 100)
        except Exception as exc:
            job.status = JobStatus.failed
            job.stage = "处理失败"
            job.error_code = "PIPELINE_FAILED"
            job.error_message = str(exc)[:500]
            project.status = JobStatus.failed
            db.commit()
            raise


@celery_app.task(
    bind=True,
    autoretry_for=(TimeoutError, ConnectionError),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=3,
)
def export_project(self, job_id: str) -> None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if not job or job.status == JobStatus.completed:
            return
        project = db.get(Project, job.project_id)
        try:
            set_job(db, job, project, JobStatus.exporting, "准备导出音频", 5)
            exports = db.scalars(select(Export).where(Export.job_id == job.id)).all()
            parts = job.idempotency_key.split(":")
            if len(parts) < 4 or parts[0] != "export":
                raise RuntimeError("invalid export job key")
            timeline = db.get(TimelineVersion, parts[2])
            if not timeline:
                raise RuntimeError("timeline version not found")
            if not project.source_object_key:
                raise RuntimeError("source audio not uploaded")

            source_path = local_object_path(project.source_object_key)
            for index, item in enumerate(exports):
                base_progress = 10 + int(index / max(1, len(exports)) * 80)

                def progress(stage: str, progress_value: int) -> None:
                    set_job(
                        db,
                        job,
                        project,
                        JobStatus.exporting,
                        f"{item.format.upper()} {stage}",
                        min(95, base_progress + int(progress_value * 0.8 / max(1, len(exports)))),
                    )

                item.object_key = export_object_key(project.id, item.id, item.format)
                db.commit()
                render_audio_export(
                    source_path=source_path,
                    timeline=timeline.timeline,
                    output_path=local_object_path(item.object_key),
                    output_format=item.format,
                    on_progress=progress,
                )
                item.status = JobStatus.completed
                db.commit()
            set_job(db, job, project, JobStatus.completed, "导出完成", 100)
        except Exception as exc:
            job.status = JobStatus.failed
            job.stage = "导出失败"
            job.error_code = "EXPORT_FAILED"
            job.error_message = str(exc)[:500]
            project.status = JobStatus.failed
            for item in db.scalars(select(Export).where(Export.job_id == job.id)):
                item.status = JobStatus.failed
            db.commit()
            raise

import time

from celery import Celery
from sqlalchemy import select

from .database import SessionLocal
from .models import EditPlan, Export, Job, JobStatus, Project, Transcript
from .services.providers import mock_result
from .settings import get_settings

settings = get_settings()
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
            set_job(db, job, project, JobStatus.transcribing, "音频校验与转写", 18)
            if not settings.mock_providers:
                raise RuntimeError("真实腾讯云 ASR Provider 尚未配置")
            time.sleep(0.1)
            result = mock_result()
            transcript = db.scalar(select(Transcript).where(Transcript.project_id == project.id))
            if not transcript:
                db.add(Transcript(project_id=project.id, segments=result.transcript, provider="mock"))
            set_job(db, job, project, JobStatus.analyzing, "规则清理与双方案分析", 62)
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
            set_job(db, job, project, JobStatus.exporting, "拼接与响度标准化", 35)
            exports = db.scalars(select(Export).where(Export.job_id == job.id)).all()
            if not settings.mock_providers:
                raise RuntimeError("真实 COS/FFmpeg Export Provider 尚未配置")
            time.sleep(0.1)
            for item in exports:
                item.status = JobStatus.completed
                item.object_key = f"exports/{project.id}/{item.id}.{item.format}"
            set_job(db, job, project, JobStatus.completed, "导出完成", 100)
        except Exception as exc:
            job.status = JobStatus.failed
            job.stage = "导出失败"
            job.error_code = "EXPORT_FAILED"
            job.error_message = str(exc)[:500]
            project.status = JobStatus.failed
            db.commit()
            raise


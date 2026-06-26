import mimetypes
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .database import Base, engine, get_db
from .models import EditPlan, Export, Job, JobStatus, Project, TimelineVersion, Transcript
from .schemas import (
    ExportCreate,
    ExportRead,
    JobRead,
    ProcessRequest,
    ProjectCreate,
    ProjectRead,
    SourceUploadRead,
    TimelineSave,
    TimelineVersionRead,
    UploadSessionRead,
    UploadSessionRequest,
)
from .security import current_owner
from .services.timeline import validate_timeline
from .settings import get_settings
from .tasks import export_project, process_project

settings = get_settings()
storage_root = Path(settings.local_storage_dir).resolve()


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def owned_project(db: Session, project_id: str, owner_id: str) -> Project:
    project = db.scalar(select(Project).where(Project.id == project_id, Project.owner_id == owner_id))
    if not project:
        raise HTTPException(404, "project not found")
    return project


def media_owner(
    api_key: str | None = Query(default=None),
    x_api_key: str | None = Header(default=None),
    x_user_id: str = Header(default="studio"),
) -> str:
    if settings.api_key and not secrets.compare_digest(x_api_key or api_key or "", settings.api_key):
        raise HTTPException(401, "invalid API key")
    return x_user_id[:64]


def source_url(project: Project) -> str | None:
    if not project.source_object_key:
        return None
    return f"/api/projects/{project.id}/source"


def read_project(project: Project) -> ProjectRead:
    return ProjectRead.model_validate(project).model_copy(update={"source_url": source_url(project)})


def safe_filename(filename: str) -> str:
    name = Path(filename).name.strip()
    return "".join(char if char.isalnum() or char in ".-_" else "_" for char in name) or "audio"


def local_object_path(object_key: str) -> Path:
    path = (storage_root / object_key).resolve()
    if not path.is_relative_to(storage_root):
        raise HTTPException(400, "invalid object key")
    return path


def dispatch(task, job_id: str) -> None:
    if settings.mock_providers and settings.redis_url == "memory://":
        task.run(job_id)
    else:
        task.delay(job_id)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "time": datetime.now(UTC).isoformat()}


@app.get("/api/projects", response_model=list[ProjectRead])
def list_projects(
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> list[ProjectRead]:
    projects = db.scalars(select(Project).where(Project.owner_id == owner_id).order_by(Project.created_at.desc()))
    return [read_project(project) for project in projects]


@app.post("/api/projects", response_model=ProjectRead, status_code=201)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> ProjectRead:
    project = Project(owner_id=owner_id, title=payload.title)
    db.add(project)
    db.commit()
    db.refresh(project)
    return read_project(project)


@app.post("/api/projects/{project_id}/upload-session", response_model=UploadSessionRead)
def upload_session(
    project_id: str,
    payload: UploadSessionRequest,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> UploadSessionRead:
    project = owned_project(db, project_id, owner_id)
    if payload.size_bytes > settings.max_upload_bytes:
        raise HTTPException(413, "file exceeds 2GB limit")
    object_key = f"originals/{owner_id}/{project.id}/{uuid.uuid4()}-{safe_filename(payload.filename)}"
    project.source_filename = payload.filename
    project.source_object_key = object_key
    db.commit()
    return UploadSessionRead(
        object_key=object_key,
        upload_url=f"/api/projects/{project.id}/source",
        media_url=f"/api/projects/{project.id}/source",
        upload_id=str(uuid.uuid4()),
        bucket=settings.cos_bucket or "mock-podcast-bucket",
        region=settings.cos_region,
        temporary_credentials={
            "tmpSecretId": "mock" if settings.mock_providers else "",
            "tmpSecretKey": "mock" if settings.mock_providers else "",
            "sessionToken": "mock" if settings.mock_providers else "",
        },
        expires_in=1800,
        mock=settings.mock_providers,
    )


@app.post("/api/projects/{project_id}/source", response_model=SourceUploadRead)
async def upload_source_audio(
    project_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> SourceUploadRead:
    project = owned_project(db, project_id, owner_id)
    content_type = file.content_type or "application/octet-stream"
    suffix = Path(file.filename or "").suffix.lower()
    allowed_suffixes = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
    if not content_type.startswith("audio/") and suffix not in allowed_suffixes:
        raise HTTPException(415, "only audio files are supported")

    filename = safe_filename(file.filename or "audio")
    object_key = f"originals/{owner_id}/{project.id}/{uuid.uuid4()}-{filename}"
    target = local_object_path(object_key)
    target.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    try:
        with target.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > settings.max_upload_bytes:
                    raise HTTPException(413, "file exceeds 2GB limit")
                output.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    project.source_filename = file.filename or filename
    project.source_object_key = object_key
    db.commit()
    return SourceUploadRead(
        project_id=project.id,
        filename=project.source_filename,
        object_key=object_key,
        media_url=f"/api/projects/{project.id}/source",
        content_type=content_type,
        size_bytes=written,
    )


@app.get("/api/projects/{project_id}/source")
def stream_source_audio(
    project_id: str,
    db: Session = Depends(get_db),
    owner_id: str = Depends(media_owner),
) -> FileResponse:
    project = owned_project(db, project_id, owner_id)
    if not project.source_object_key:
        raise HTTPException(404, "source audio not uploaded")
    path = local_object_path(project.source_object_key)
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "source audio file not found")
    media_type = mimetypes.guess_type(project.source_filename or path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=project.source_filename or path.name)


@app.post("/api/projects/{project_id}/process", response_model=JobRead, status_code=202)
def start_process(
    project_id: str,
    payload: ProcessRequest,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> Job:
    project = owned_project(db, project_id, owner_id)
    if payload.duration_ms and payload.duration_ms > settings.max_duration_ms:
        raise HTTPException(422, "audio exceeds 2 hour limit")
    if payload.object_key:
        project.source_object_key = payload.object_key
    project.duration_ms = payload.duration_ms
    key = f"process:{project.id}:{project.source_object_key or 'demo'}"
    job = db.scalar(select(Job).where(Job.idempotency_key == key))
    if not job:
        job = Job(
            project_id=project.id,
            kind="process",
            status=JobStatus.uploaded,
            stage="排队中",
            progress=0,
            idempotency_key=key,
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        dispatch(process_project, job.id)
    return job


@app.get("/api/jobs/{job_id}", response_model=JobRead)
def get_job(
    job_id: str,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> Job:
    job = db.scalar(select(Job).join(Project).where(Job.id == job_id, Project.owner_id == owner_id))
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.get("/api/projects/{project_id}/transcript")
def get_transcript(
    project_id: str,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> dict:
    owned_project(db, project_id, owner_id)
    transcript = db.scalar(select(Transcript).where(Transcript.project_id == project_id))
    if not transcript:
        raise HTTPException(404, "transcript not ready")
    return {"project_id": project_id, "provider": transcript.provider, "segments": transcript.segments}


@app.get("/api/projects/{project_id}/plans")
def get_plans(
    project_id: str,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> dict:
    owned_project(db, project_id, owner_id)
    plans = db.scalars(select(EditPlan).where(EditPlan.project_id == project_id)).all()
    return {
        "plans": [
            {"id": item.id, "mode": item.mode, "summary": item.summary, "segments": item.timeline}
            for item in plans
        ]
    }


@app.put("/api/projects/{project_id}/timeline", response_model=TimelineVersionRead)
def save_timeline(
    project_id: str,
    payload: TimelineSave,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> TimelineVersion:
    owned_project(db, project_id, owner_id)
    transcript = db.scalar(select(Transcript).where(Transcript.project_id == project_id))
    if not transcript:
        raise HTTPException(409, "transcript not ready")
    validate_timeline(payload.segments, transcript.segments)
    version = (db.scalar(select(func.max(TimelineVersion.version)).where(TimelineVersion.project_id == project_id)) or 0) + 1
    row = TimelineVersion(
        project_id=project_id,
        version=version,
        title=payload.title,
        timeline=[item.model_dump() for item in payload.segments],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.get("/api/projects/{project_id}/timeline", response_model=list[TimelineVersionRead])
def list_timelines(
    project_id: str,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> list[TimelineVersion]:
    owned_project(db, project_id, owner_id)
    return list(
        db.scalars(
            select(TimelineVersion)
            .where(TimelineVersion.project_id == project_id)
            .order_by(TimelineVersion.version.desc())
        )
    )


@app.post("/api/projects/{project_id}/export", response_model=JobRead, status_code=202)
def create_export(
    project_id: str,
    payload: ExportCreate,
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> Job:
    owned_project(db, project_id, owner_id)
    timeline = db.scalar(
        select(TimelineVersion).where(
            TimelineVersion.id == payload.timeline_version_id,
            TimelineVersion.project_id == project_id,
        )
    )
    if not timeline:
        raise HTTPException(404, "timeline version not found")
    formats = sorted(set(payload.formats))
    key = f"export:{project_id}:{timeline.id}:{','.join(formats)}"
    job = db.scalar(select(Job).where(Job.idempotency_key == key))
    if not job:
        job = Job(
            project_id=project_id,
            kind="export",
            status=JobStatus.exporting,
            stage="排队中",
            progress=0,
            idempotency_key=key,
        )
        db.add(job)
        db.flush()
        db.add_all([Export(project_id=project_id, job_id=job.id, format=item) for item in formats])
        db.commit()
        db.refresh(job)
        dispatch(export_project, job.id)
    return job


@app.get("/api/projects/{project_id}/exports", response_model=list[ExportRead])
def list_exports(
    project_id: str,
    expires: int = Query(default=900, ge=60, le=3600),
    db: Session = Depends(get_db),
    owner_id: str = Depends(current_owner),
) -> list[ExportRead]:
    owned_project(db, project_id, owner_id)
    rows = db.scalars(select(Export).where(Export.project_id == project_id).order_by(Export.created_at.desc())).all()
    return [
        ExportRead(
            id=row.id,
            format=row.format,
            status=row.status,
            download_url=f"/api/downloads/{row.id}?token=mock-signed" if row.object_key else None,
            expires_in=expires if row.object_key else None,
        )
        for row in rows
    ]

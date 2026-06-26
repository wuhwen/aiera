from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import JobStatus


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    status: JobStatus
    source_filename: str | None
    duration_ms: int | None
    created_at: datetime
    source_url: str | None = None


class UploadSessionRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0)
    content_type: str = "audio/mpeg"


class UploadSessionRead(BaseModel):
    object_key: str
    upload_url: str | None = None
    media_url: str | None = None
    upload_id: str
    bucket: str
    region: str
    temporary_credentials: dict[str, str]
    expires_in: int
    mock: bool = False


class SourceUploadRead(BaseModel):
    project_id: str
    filename: str
    object_key: str
    media_url: str
    content_type: str
    size_bytes: int


class ProcessRequest(BaseModel):
    object_key: str | None = None
    duration_ms: int | None = Field(default=None, gt=0)


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    project_id: str
    kind: str
    status: JobStatus
    stage: str
    progress: int
    attempt: int
    error_code: str | None
    error_message: str | None
    updated_at: datetime


class TranscriptSegment(BaseModel):
    segment_id: str
    source_start: int = Field(ge=0)
    source_end: int = Field(gt=0)
    text: str
    speaker: str | None = None

    @model_validator(mode="after")
    def valid_range(self) -> "TranscriptSegment":
        if self.source_end <= self.source_start:
            raise ValueError("source_end must be greater than source_start")
        return self


class TimelineSegment(TranscriptSegment):
    output_order: int = Field(ge=0)
    action: Literal["keep", "delete"]
    reason: str = ""
    confidence: float = Field(ge=0, le=1)


class TimelineSave(BaseModel):
    title: str = Field(default="人工审核版", min_length=1, max_length=120)
    segments: list[TimelineSegment]


class TimelineVersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    version: int
    title: str
    timeline: list[dict]
    created_at: datetime


class ExportCreate(BaseModel):
    formats: list[Literal["mp3", "wav"]] = ["mp3", "wav"]
    timeline_version_id: str


class ExportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    format: str
    status: JobStatus
    download_url: str | None = None
    expires_in: int | None = None

from typing import Protocol


class CapCutDraftAdapter(Protocol):
    """Optional boundary for future timeline-to-draft conversion."""

    def create_draft(self, project_id: str, timeline: list[dict]) -> str:
        """Return the object key of a generated CapCut draft archive."""
        ...


class DisabledCapCutAdapter:
    def create_draft(self, project_id: str, timeline: list[dict]) -> str:
        raise NotImplementedError("CapCut draft export is outside the MVP critical path")


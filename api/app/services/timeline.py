from collections import Counter

from fastapi import HTTPException

from ..schemas import TimelineSegment


def validate_timeline(segments: list[TimelineSegment], transcript: list[dict]) -> None:
    source = {item["segment_id"]: item for item in transcript}
    ids = [item.segment_id for item in segments]
    duplicates = [item for item, count in Counter(ids).items() if count > 1]
    if duplicates:
        raise HTTPException(422, f"duplicate segment ids: {', '.join(duplicates)}")

    orders = [item.output_order for item in segments if item.action == "keep"]
    if len(orders) != len(set(orders)):
        raise HTTPException(422, "kept segments must have unique output_order")

    for item in segments:
        original = source.get(item.segment_id)
        if not original:
            raise HTTPException(422, f"unknown segment id: {item.segment_id}")
        if item.source_start != original["source_start"] or item.source_end != original["source_end"]:
            raise HTTPException(422, f"source range changed: {item.segment_id}")
        if item.text != original["text"]:
            raise HTTPException(422, f"original transcript text changed: {item.segment_id}")


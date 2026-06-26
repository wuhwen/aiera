from dataclasses import dataclass


@dataclass
class ProviderResult:
    transcript: list[dict]
    conservative: list[dict]
    restructured: list[dict]


def mock_result() -> ProviderResult:
    rows = [
        ("seg-001", 0, 12600, "欢迎来到本期节目。今天我们想认真聊聊，小团队怎样开始使用人工智能。"),
        ("seg-002", 12600, 24800, "嗯，其实很多团队第一反应是先买工具，但我觉得应该先找到重复发生的问题。"),
        ("seg-003", 24800, 39200, "比如每周都要整理访谈、写摘要、同步行动项，这些工作很适合先自动化。"),
        ("seg-004", 39200, 48700, "对，对。我们之前也买过很多工具，后来发现没有明确流程，工具反而增加了负担。"),
        ("seg-005", 48700, 62500, "所以第一步不是模型选型，而是画出工作流，标出输入、判断和最终交付物。"),
        ("seg-006", 62500, 74200, "这里稍微岔开一下，我昨天还去看了一个特别有意思的展览。"),
        ("seg-007", 74200, 89200, "回到团队落地，第二步是用一个低风险任务做两周试验，并且保留人工审核。"),
        ("seg-008", 89200, 103400, "如果两周后节省的时间可以量化，再考虑接入正式数据和权限系统。"),
        ("seg-009", 103400, 116800, "简单总结：先找高频问题，再画流程，小范围试验，最后才是规模化。"),
    ]
    transcript = [
        {"segment_id": sid, "source_start": start, "source_end": end, "text": text, "speaker": "主持人"}
        for sid, start, end, text in rows
    ]

    def item(index: int, action: str = "keep", reason: str = "", confidence: float = 0.9) -> dict:
        segment = dict(transcript[index])
        segment.update(output_order=index, action=action, reason=reason, confidence=confidence)
        return segment

    conservative = [item(i) for i in range(len(transcript))]
    conservative[1].update(reason="保留观点，建议轻微去除开头口癖", confidence=0.86)
    conservative[3].update(reason="保留案例，重复确认词可在音频边界中弱化", confidence=0.82)
    conservative[5].update(action="delete", reason="与本期主题明显无关", confidence=0.96)
    for order, segment in enumerate(item for item in conservative if item["action"] == "keep"):
        segment["output_order"] = order

    order = [0, 8, 1, 2, 4, 3, 6, 7, 5]
    restructured = []
    for output_order, index in enumerate(order):
        segment = item(index)
        segment["output_order"] = output_order
        segment["reason"] = "按“结论先行—方法—案例—落地”重新组织"
        if index == 5:
            segment.update(action="delete", reason="偏离主题", confidence=0.97)
        restructured.append(segment)
    return ProviderResult(transcript, conservative, restructured)


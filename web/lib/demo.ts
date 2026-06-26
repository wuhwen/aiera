import type { Segment } from "./types";

const source = [
  ["seg-001", 0, 12600, "欢迎来到本期节目。今天我们想认真聊聊，小团队怎样开始使用人工智能。"],
  ["seg-002", 12600, 24800, "嗯，其实很多团队第一反应是先买工具，但我觉得应该先找到重复发生的问题。"],
  ["seg-003", 24800, 39200, "比如每周都要整理访谈、写摘要、同步行动项，这些工作很适合先自动化。"],
  ["seg-004", 39200, 48700, "对，对。我们之前也买过很多工具，后来发现没有明确流程，工具反而增加了负担。"],
  ["seg-005", 48700, 62500, "所以第一步不是模型选型，而是画出工作流，标出输入、判断和最终交付物。"],
  ["seg-006", 62500, 74200, "这里稍微岔开一下，我昨天还去看了一个特别有意思的展览。"],
  ["seg-007", 74200, 89200, "回到团队落地，第二步是用一个低风险任务做两周试验，并且保留人工审核。"],
  ["seg-008", 89200, 103400, "如果两周后节省的时间可以量化，再考虑接入正式数据和权限系统。"],
  ["seg-009", 103400, 116800, "简单总结：先找高频问题，再画流程，小范围试验，最后才是规模化。"],
] as const;

function make(order: number[], mode: "conservative" | "restructured"): Segment[] {
  return order.map((sourceIndex, outputOrder) => {
    const [id, start, end, text] = source[sourceIndex];
    const isAside = id === "seg-006";
    const isFiller = id === "seg-002" || id === "seg-004";
    return {
      segment_id: id,
      source_start: start,
      source_end: end,
      output_order: outputOrder,
      action: isAside ? "delete" : "keep",
      reason: isAside
        ? "偏离本期主题"
        : isFiller
          ? "保留观点，弱化口癖"
          : mode === "restructured"
            ? "按主题结构重新组织"
            : "核心叙事",
      confidence: isAside ? 0.97 : isFiller ? 0.84 : 0.93,
      text,
      speaker: sourceIndex % 3 === 0 ? "嘉宾" : "主持人",
    };
  });
}

export const demoPlans = {
  conservative: make([0, 1, 2, 3, 4, 5, 6, 7, 8], "conservative"),
  restructured: make([0, 8, 1, 2, 4, 3, 6, 7, 5], "restructured"),
};


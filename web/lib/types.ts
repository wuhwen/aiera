export type Segment = {
  segment_id: string;
  source_start: number;
  source_end: number;
  output_order: number;
  action: "keep" | "delete";
  reason: string;
  confidence: number;
  text: string;
  speaker?: string;
};

export type PlanMode = "conservative" | "restructured";


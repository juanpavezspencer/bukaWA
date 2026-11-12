import type { ChatModel, ChatRequest, ChatResponse } from "@bukuwa/ai";

type Block = ChatResponse["content"][number];
type Step = (req: ChatRequest) => Partial<ChatResponse> & { content: ChatResponse["content"] };

/** Test double for the agent model: each step sees the request (and so earlier tool results). */
export class ScriptedChat implements ChatModel {
  requests: ChatRequest[] = [];
  constructor(public steps: Step[] = []) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("no more scripted chat steps");
    return { stopReason: "end_turn", model: "claude-sonnet-5-5", ...step(req) };
  }
}

let n = 0;
export const call = (name: string, input: unknown): Step => () => ({
  stopReason: "tool_use",
  content: [{ type: "tool_use", id: `tu_${++n}`, name, input } as unknown as Block],
});
export const say = (text: string | ((lastResult: any) => string)): Step => (req) => ({
  content: [{ type: "text", text: typeof text === "string" ? text : text(lastResult(req)), citations: null } as unknown as Block],
});

/** Parsed content of the most recent tool_result in the conversation. */
export function lastResult(req: ChatRequest): any {
  for (const m of [...req.messages].reverse()) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    const r = m.content.find((b) => b.type === "tool_result");
    if (r && r.type === "tool_result") return JSON.parse(r.content as string);
  }
  return undefined;
}

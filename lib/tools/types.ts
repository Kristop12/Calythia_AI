/** OpenAI-compatible tool / function schemas for LM Studio chat completions. */

export type JsonSchema = {
  type: "object";
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Which mcpRoute ToolGroups activate this tool */
  groups: string[];
  /** Always include when native tools are on (e.g. run_agent_task) */
  codingOnly?: boolean;
  browserOnly?: boolean;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  error?: string;
};

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

export type AgentMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

/** Fields a later reader needs to tell which model and which tools a turn offered. */
export function turnStartTraceData(input: {
  turn: number;
  adapterName: string;
  modelName?: string;
  promptCacheKey?: string;
  toolNames: readonly string[];
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    turn: input.turn,
    adapter: input.adapterName,
    tools: [...input.toolNames],
  };
  if (input.modelName) data.model = input.modelName;
  if (input.promptCacheKey) data.promptCacheKey = input.promptCacheKey;
  return data;
}

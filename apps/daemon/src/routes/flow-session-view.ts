interface SessionInput {
  id:string;title:string;status:string;agentId:string;parentSessionId?:string;updatedAt:string;
  metadata?:Record<string,unknown>;
}
export function flowSessionView(s:SessionInput) {
  const metadata=s.metadata??{};
  const totals=metadata.usageTotals as {totalTokens?:unknown}|undefined;
  return {
    id:s.id,title:s.title,status:s.status,agentId:s.agentId,parentSessionId:s.parentSessionId,updatedAt:s.updatedAt,
    metadata:{
      ...(typeof metadata.usageCostUsd==='number'?{usageCostUsd:metadata.usageCostUsd}:{}),
      ...(typeof totals?.totalTokens==='number'?{usageTotals:{totalTokens:totals.totalTokens}}:{})
    }
  };
}

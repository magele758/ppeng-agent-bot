/** `/api/approvals` 返回全部审批（含已批准/已拒绝/已过期）；收件箱与导航徽标只应展示待处理项。 */
export type MaybePendingApproval = { status?: string };

export function isPendingApproval(a: MaybePendingApproval): boolean {
  return !a.status || a.status === 'pending';
}

export function pendingApprovals<T extends MaybePendingApproval>(items: readonly T[] | undefined | null): T[] {
  return (items ?? []).filter(isPendingApproval);
}

export interface UpdatePreview { current: string; target: string; notes: string }
export async function chooseUpdate(steps: {
 select: () => Promise<string | undefined>;
 preview: (candidate: string) => UpdatePreview;
 confirm: (preview: UpdatePreview) => Promise<boolean>;
}): Promise<{candidate:string;preview:UpdatePreview}|undefined> {
 const candidate=await steps.select();if(!candidate)return;
 const preview=steps.preview(candidate);
 if(!await steps.confirm(preview))return;
 return {candidate,preview};
}

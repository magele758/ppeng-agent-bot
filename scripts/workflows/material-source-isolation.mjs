/** Materials may be values or lazy preparations, isolated along with updates. */
export async function updateMaterialTargets(targets,update,report) {
 for(const [name,material] of targets) {
  try { await update(name,typeof material==='function'?await material():material); }
  catch(error) { report(name,error); }
 }
}

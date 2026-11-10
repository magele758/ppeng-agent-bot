/** Independent jobs must still receive fresh materials when a sibling fails. */
export async function updateMaterialTargets(targets,update,report) {
 for(const [name,material] of targets) {
  try { await update(name,material); }
  catch(error) { report(name,error); }
 }
}

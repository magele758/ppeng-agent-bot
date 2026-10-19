/** Fixed restart scenario inventory shared by runner and report validator. */
export const CASES=[];
for(const mode of ['chat','task'])for(const termination of ['SIGTERM','SIGKILL']){
  for(const phase of ['model','tool','retry','partial-tools'])CASES.push({name:`${phase}-${mode}-${termination}`,phase,mode,termination,action:['model','retry'].includes(phase)?'fresh':phase==='partial-tools'?'inspect-tools':'inspect'});
  CASES.push({name:`approval-pending-${mode}-${termination}`,phase:'approval',mode,termination,action:'pending'});
}
for(const termination of ['SIGTERM','SIGKILL'])for(const variant of ['one','partial-approved','partial-rejected','resume','settled','mixed','rejected','cancel','partial-cancel'])CASES.push({name:`approval-${variant}-chat-${termination}`,phase:variant==='one'?'approval-one':'approval',mode:'chat',termination,action:variant});
for(const phase of ['completed','failed','cancelled'])CASES.push({name:`terminal-${phase}-chat-SIGKILL`,phase:`terminal-${phase}`,mode:'chat',termination:'SIGKILL',action:'terminal'});
CASES.push({name:'retry-cancelled-chat-SIGKILL',phase:'retry',mode:'chat',termination:'SIGKILL',action:'cancel-before-stop'});
// A completed task and a gracefully cancelled retry are green mutation controls even if crash recovery is broken.
CASES.push({name:'terminal-completed-task-SIGKILL',phase:'terminal-completed',mode:'task',termination:'SIGKILL',action:'terminal'});

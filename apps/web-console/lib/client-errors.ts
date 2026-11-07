export type ErrorContext = { page: string; sessionId: string; buildId: string; userAgent: string };
export type ClientError = ErrorContext & { at: string; kind: string; message: string; stack: string; componentStack: string };
function text(value: unknown, limit: number): string {
 if (typeof value !== 'string') return '';
 return value.slice(0, limit).replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, '$1')
  .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]');
}
function errorMessage(error: unknown): string {
 if (error instanceof Error) return error.message;
 if (typeof error === 'string') return error;
 return 'Non-Error rejection';
}
export function makeClientError(kind: string, error: unknown, context: ErrorContext, componentStack = ''): ClientError {
 return { ...context, page:context.page.split('#').map(part=>part.split('?')[0]).join('#').slice(0,1000),
  at:new Date().toISOString(),kind,message:text(errorMessage(error),2000),
  stack:text(error instanceof Error ? error.stack : '',8000),componentStack:text(componentStack,4000) };
}
export function createErrorReporter(send: (row: ClientError) => Promise<unknown>) {
 const seen = new Set<string>();
 return async (row: ClientError) => {
  const key = JSON.stringify([row.kind,row.message,row.stack.split('\n').slice(0,2).join('\n'),row.page,row.sessionId]);
  if (seen.has(key) || seen.size >= 10) return;
  seen.add(key);
  try { await send(row); } catch { /* Reporting must never recursively report itself. */ }
 };
}
export function installErrorListeners(target: EventTarget, report: (kind: string, error: unknown) => void) {
 const onError = (event: Event) => {
  const error = event as ErrorEvent;
  report('error', error.error ?? error.message);
 };
 const onRejection = (event: Event) => report('unhandledrejection', (event as PromiseRejectionEvent).reason);
 target.addEventListener('error',onError);
 target.addEventListener('unhandledrejection',onRejection);
 return () => { target.removeEventListener('error',onError);target.removeEventListener('unhandledrejection',onRejection); };
}
let sessionId = '';
export function setDiagnosticSession(id: string | null) { sessionId = id ?? ''; }
const deliver = createErrorReporter(row => fetch('/api/client-errors',{
 method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(row),keepalive:true
}));
export function reportClientError(kind: string, error: unknown, componentStack = '') {
 try {
  const context = {page:location.pathname+location.hash,sessionId,
   buildId:process.env.NEXT_PUBLIC_BUILD_ID ?? '',userAgent:navigator.userAgent};
  void deliver(makeClientError(kind,error,context,componentStack));
 } catch { /* Diagnostics must also work during partial teardown. */ }
}

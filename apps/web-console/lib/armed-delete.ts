export function armedDeleteAction(armed: boolean): 'arm' | 'delete' {
  return armed ? 'delete' : 'arm';
}

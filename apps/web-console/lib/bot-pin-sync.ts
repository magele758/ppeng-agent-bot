import type { BotPinState } from './bot-pin.ts';
type Request = (path: string, init?: RequestInit) => Promise<unknown>;
const path = '/api/bot-pin-settings';
export function createPinSync(request: Request) {
 const write = async (state: BotPinState, initialize = false) => {
  const result = await request(path, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,initialize})});
  return (result as {state:BotPinState}).state;
 };
 return {
  save: write,
  async refresh(local: BotPinState): Promise<BotPinState> {
   const result = await request(path) as {state:BotPinState|null};
   if (result.state !== null) return result.state;
   if (local.customized) return write(local,true);
   return local;
  }
 };
}

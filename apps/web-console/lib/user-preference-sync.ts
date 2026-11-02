import type { UserPreferences } from './user-preference-schema.ts';
export function createPreferenceSync(request: (path:string,init?:RequestInit)=>Promise<unknown>) {
 const write = async (values:UserPreferences, initialize:boolean) => {
  const result = await request('/api/user/preferences',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({values,initialize})}) as {values:UserPreferences};
  return result.values;
 };
 return {migrate:(values:UserPreferences)=>write(values,true),save:(values:UserPreferences)=>write(values,false)};
}

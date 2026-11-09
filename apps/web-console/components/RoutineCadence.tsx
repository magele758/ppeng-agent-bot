import {useI18n} from '@/lib/i18n';
import {intervalUnit} from '@/lib/interval-unit';
import type {CronJobInfo} from '@/lib/cron';

function parseDailyCron(value:string){
  const daily=/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(value);
  if(!daily)return null;
  const time=daily[2].padStart(2,'0')+':'+daily[1].padStart(2,'0');
  const weekdaysOnly=daily[3]==='1-5';
  return {time,weekdaysOnly};
}
export function RoutineCadence({job}:{job:CronJobInfo}) {
  const {t,locale}=useI18n();
  const value=job.scheduleValue;
  if(job.scheduleKind==='every_ms'){
    const {unit,count}=intervalUnit(value);
    const duration=new Intl.NumberFormat(locale,{style:'unit',unit,unitDisplay:'long'}).format(count);
    return <>{t('botSettings.everyDuration',{duration})}</>;
  }
  if(job.scheduleKind==='once_at'){
    try{return <>{new Intl.DateTimeFormat(locale,{timeZone:job.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(value))}</>;}
    catch{return <>{value}</>;}
  }
  const parsed=parseDailyCron(value);
  if(parsed)return <>{t(parsed.weekdaysOnly?'botSettings.weekdaysAt':'botSettings.dailyAt',{time:parsed.time})}</>;
  return <>{value}</>;
}

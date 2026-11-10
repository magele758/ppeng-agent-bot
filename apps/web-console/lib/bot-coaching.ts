export type CoachingProfile = {role?:string;host?:string;executor?:string;completion?:string;requiredSkills?:string[]};
export type CoachingCheck = {scenario:string;outcome:'passed'|'failed'|'blocked';evidence:string};
export type CoachingLesson = {id:string;rule:string;source:string;status:'candidate'|'verified'|'retired';checks:CoachingCheck[]};
export type BotCoaching = {revision:number;profile:CoachingProfile;lessons:CoachingLesson[]};
export const emptyCoaching = ():BotCoaching=>({revision:0,profile:{},lessons:[]});
export function newCoachingLesson():CoachingLesson{return {id:crypto.randomUUID(),rule:'',source:'',status:'candidate',checks:[]};}
export function replaceCoachingLesson(rows:CoachingLesson[],lesson:CoachingLesson){return rows.map(row=>row.id===lesson.id?lesson:row);}

import {register} from 'node:module';
import {fileURLToPath} from 'node:url';
const index=process.argv.indexOf('--mutation');
register('./concurrency-loader.mjs',import.meta.url,{data:{root:fileURLToPath(new URL('../../',import.meta.url)),mutation:index<0?null:process.argv[index+1]}});

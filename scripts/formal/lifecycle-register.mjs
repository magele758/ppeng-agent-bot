import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
register('./lifecycle-loader.mjs', import.meta.url, { data: { root: fileURLToPath(new URL('../../', import.meta.url)), mutation: process.argv[process.argv.indexOf('--mutation') + 1] } });

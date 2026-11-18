import { readFile, mkdir, writeFile } from 'node:fs/promises';
const assets = await Promise.all(['html','css','js'].map(ext => readFile(new URL(`./public/page.${ext}`,import.meta.url),'utf8')));
const worker = await readFile(new URL('./src/worker.mjs',import.meta.url),'utf8');
await mkdir(new URL('./dist/',import.meta.url),{recursive:true});
await writeFile(new URL('./dist/worker.mjs',import.meta.url),assets.map((value,i)=>`const ${['PAGE_HTML','PAGE_CSS','PAGE_JS'][i]} = ${JSON.stringify(value)};`).join('\n')+'\n'+worker);

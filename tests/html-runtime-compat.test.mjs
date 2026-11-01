import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('HTML sanitizer starts when CommonJS require(ESM) is disabled like the deployment runtime',()=>{
 const result=spawnSync(process.execPath,['--no-experimental-require-module','--input-type=module','-e',`import {renderHtmlTemplate} from './server/email-html.mjs'; const r=renderHtmlTemplate('<p>Hello {{customer_name}}</p>',{customer_name:'Example'});if(r.text!=='Hello Example')process.exit(2);`],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});

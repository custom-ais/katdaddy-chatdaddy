import '../scripts/test-no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
test('test fetch guard refuses live provider destinations before transport',()=>{
 assert.throws(()=>fetch('https://verify.twilio.com/v2/Services/test/Verifications'),/External network fetch blocked/);
 assert.throws(()=>fetch('https://api.twilio.com/'),/External network fetch blocked/);
});
test('loopback harness redirects cannot follow to an external provider',async t=>{
 const server=http.createServer((_req,res)=>{res.writeHead(302,{Location:'https://api.twilio.com/'});res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/`;
 assert.equal((await fetch(url,{redirect:'manual'})).status,302);
 await assert.rejects(fetch(url),/fetch failed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {normalizeClientHubUrl} from '../shared/client-hub.mjs';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/admin/ClientHubSettings.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const url='https://clienthub.getjobber.com/client_hubs/12345678-1234-1234-1234-123456789abc/login/new?source=share_login';
function harness(saved={}) {
 const states=[],calls=[];let cursor=0;
 const plain=({children,title,description,hint})=>React.createElement('div',null,title,description,hint,children);
 const react={...React,useState:init=>{const i=cursor++;if(!(i in states))states[i]=typeof init==='function'?init():init;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useEffect:()=>{}};
 const deps={react,'lucide-react':{Link2:()=>null},'../../shared/client-hub.mjs':{normalizeClientHubUrl},'../lib/api':{api:async(...args)=>{calls.push(args);return {accountName:'Example Account',confirmationToken:'opaque-test-token'};}},'./DashboardContext':{useDashboard:()=>({data:{integrations:{clientHub:saved}},mutate:async(...args)=>calls.push(args)})},'./ui':{Field:plain,Section:plain,ErrorNote:plain,inputClass:'',primaryButton:'',secondaryButton:''}};
 const out={};new Function('require','exports',code)(id=>deps[id]||require(id),out);
 const render=()=>{cursor=0;return out.ClientHubSettings();};
 function find(node,predicate) {if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
 return {calls,render,find,button:(tree,label)=>find(tree,node=>node.type==='button'&&node.props.children===label),input:tree=>find(tree,node=>node.type==='input'&&node.props.type==='url')};
}
test('Client Hub is optional, email-only, manual-source attestation and separately saved without automatic requests',()=>{
 const h=harness(),tree=h.render(),html=renderToStaticMarkup(tree);
 assert.match(html,/never verification codes or texts/);assert.match(html,/does not prove ownership/);assert.match(html,/Other settings use/);assert.match(html,/Blank disables/);
 assert.equal(h.button(tree,'Save Client Hub').props.disabled,true);assert.equal(h.calls.length,0);
 assert.match(source,/addEventListener\('beforeunload'/);
});
test('URL edit clears attestation; explicit account verification and checkbox bind save token',async()=>{
 const h=harness();let tree=h.render();h.input(tree).props.onChange({target:{value:url}});tree=h.render();
 assert.equal(h.button(tree,'Save Client Hub').props.disabled,true);
 await h.button(tree,'Verify account for link').props.onClick();tree=h.render();
 assert.match(renderToStaticMarkup(tree),/Verified connected account.*Example Account/);
 h.find(tree,node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();
 assert.equal(h.button(tree,'Save Client Hub').props.disabled,false);
 await h.button(tree,'Save Client Hub').props.onClick();
 assert.deepEqual(h.calls[1].slice(0,3),['/api/admin/jobber/client-hub',{url,confirmAccount:true,confirmationToken:'opaque-test-token'},'POST']);
 tree=h.render();h.input(tree).props.onChange({target:{value:url+'bad'}});tree=h.render();assert.equal(h.button(tree,'Save Client Hub').props.disabled,true);
});
test('blank disables without account call or token; discard does not save unrelated settings',async()=>{
 const h=harness({url,enabled:true});let tree=h.render();h.input(tree).props.onChange({target:{value:''}});tree=h.render();
 await h.button(tree,'Save Client Hub').props.onClick();assert.deepEqual(h.calls[0].slice(0,3),['/api/admin/jobber/client-hub',{url:'',confirmAccount:false},'POST']);
 tree=h.render();h.input(tree).props.onChange({target:{value:'https://wrong.example'}});tree=h.render();h.button(tree,'Discard Client Hub changes').props.onClick();assert.equal(h.calls.length,1);assert.equal(h.input(h.render()).props.value,url);
});

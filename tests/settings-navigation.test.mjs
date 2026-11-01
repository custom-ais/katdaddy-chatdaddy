import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/admin/SettingsPage.tsx',import.meta.url),'utf8');
const root=await readFile(new URL('../src/admin/AdminRoot.tsx',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('export const SETTINGS_PAGES'),source.indexOf('export function SettingsPage('));
const exports={};new Function('require','exports',ts.transpileModule(helpers,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(require,exports);
test('all Settings sections have explicit deep links with safe default and browser history restoration',()=>{
 assert.deepEqual(exports.SETTINGS_PAGES.map(x=>x[0]),['connections','booking','schedule','services','coverage','business','answers','templates','security']);
 for(const [id] of exports.SETTINGS_PAGES) assert.equal(exports.settingsPageFromSearch(`?tab=settings&settings=${id}`),id);
 for(const value of ['', '?settings=unknown','?settings=__proto__']) assert.equal(exports.settingsPageFromSearch(value),'connections');
 assert.match(source,/history\.pushState\(null, '', `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`\)/);
 assert.match(source,/addEventListener\('popstate', restore\)/);
 assert.match(source,/removeEventListener\('popstate', restore\)/);
 assert.doesNotMatch(root,/if \(p\.toString\(\)\) history\.replaceState\(null, '', '\/admin'\)/);
});
test('inactive panels stay mounted and the shared save state remains outside the panels',()=>{
 for(const [id] of exports.SETTINGS_PAGES) assert.ok(source.includes(`hidden={page !== '${id}'}`),id);
 const navigate=source.slice(source.indexOf('  const navigate ='),source.indexOf('  const { data, mutate }',source.indexOf('export function SettingsPage(')));
 assert.doesNotMatch(navigate,/setC\(|setDirty\(|setTechs\(|setTechDirty\(|save\(/);
 assert.match(source,/Unsaved \{changed\.join\(' and '\)\} — kept as you switch sections/);
 assert.equal((source.match(/<SaveDock changed=/g)||[]).length,1);
 assert.ok(source.lastIndexOf('<SaveDock')>source.lastIndexOf('data-settings-panel='));
 assert.match(source,/if \(dirty\) return;/);
 assert.match(source,/if \(techDirty\).*\/api\/admin\/technicians/);
 assert.match(source,/if \(dirty\).*\/api\/admin\/config/);
});
test('all original settings controls are retained in the nine visible subpages',()=>{
 for(const title of ['Online booking','Owner booking alerts','Approvals','Route rules','Services and prices','Service area map','Hours and capacity','Office contact and visit prep','Add BOB to dryerventsquadaz.com']) assert.equal(source.split(`title="${title}"`).length-1,1,title);
 for(const child of ['Connections','Technicians','Answers','Password']) assert.equal((source.match(new RegExp(`<${child}(?: | />)`,'g'))||[]).length,1,child);
 assert.match(source,/nav aria-label="Settings sections" className="flex flex-wrap/);
 assert.match(source,/aria-current=\{page === id \? 'page' : undefined\}/);
});

test('top-level navigation and history keep Settings mounted; dirty drafts warn on reload',()=>{
 assert.match(root,/url.searchParams.set\('tab', t\)/);
 assert.match(root,/addEventListener\('popstate', restore\)/);
 assert.match(root,/settingsMounted && <div hidden=\{tab !== 'settings'\}><SettingsPage active=\{tab === 'settings'\}/);
 assert.match(source,/active && <SaveDock/);
 assert.match(source,/addEventListener\('beforeunload', warn\)/);
 assert.match(source,/removeEventListener\('beforeunload', warn\)/);
 assert.match(source,/if \(!dirty && !techDirty\) return;/);
});
test('top-level route parser restores Settings and other tabs without trusting arbitrary query values',()=>{
 const constants=root.match(/const TABS: Tab\[\] = [^;]+;/)[0];
 const helper=root.slice(root.indexOf('export function adminTabFromSearch'),root.indexOf('\nfunction Dashboard('));
 const compiled=ts.transpileModule(`${constants}\n${helper}`,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const out={};new Function('require','exports',compiled)(require,out);
 for(const tab of ['appointments','inbox','analytics','activity','bot','settings']) assert.equal(out.adminTabFromSearch(`?tab=${tab}&settings=schedule`),tab);
 assert.equal(out.adminTabFromSearch('?tab=unknown'),'appointments');
 assert.equal(out.adminTabFromSearch('?approval=APR-test'),'inbox');
 assert.equal(out.adminTabFromSearch('?jobber=connected&settings=connections'),'settings');
});

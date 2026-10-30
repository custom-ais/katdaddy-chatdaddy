import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../server/store.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
process.chdir(root);
if(existsSync('.env'))for(const line of readFileSync('.env','utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_]+)\s*=\s*(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
const dbPath=process.env.BOB_DB_PATH||join(root,'.data','bob.sqlite');
if(!existsSync(dbPath)){console.error('No existing BOB database was found. No changes were made.');process.exit(1);}
const rl=createInterface({input:stdin,output:stdout});
console.log('Stop the BOB server before continuing. This removes the management password and signs out all administrators. Customer bookings and requests are preserved. Restart BOB afterward to obtain a new private setup code.');
const answer=await rl.question('Type RESET ACCESS to continue: ');rl.close();
if(answer!=='RESET ACCESS'){console.log('No changes made.');process.exit(0);}
const store=openStore(dbPath);store.atomic(()=>{store.db.prepare("DELETE FROM settings WHERE key='auth'").run();store.db.exec('DELETE FROM admins');store.audit('admin.access.reset','local operator');});store.close();console.log('Management access reset. Restart BOB to create your new password.');

import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const dir='state/live-architect/tunnel-milestone/',target=dir+'deploy-lighting-companion.mjs';if(existsSync(target))throw Error('No wrapper replacement');
const old=readFileSync(dir+'deploy-fine-companion.mjs','utf8');
const pre=`
for(const name of ['local-lighting-bridge-v2-review.json','local-lighting-curve-v3-review.json']){
 const r=JSON.parse(await readFile(join(root,'state/live-architect/tunnel-milestone',name)));
 if(r.status!=='completed'||!r.result.messages.some(m=>m.role==='assistant'&&JSON.parse(m.content.replace(/^\x60\x60\x60json\\s*|\\s*\x60\x60\x60$/g,'')).verdict==='approve'))throw Error('Source review missing');
 for(const f of r.files)if(hash(await readFile(join(source,f.file)))!==f.sha256)throw Error('Reviewed source changed');
}
const verified=JSON.parse(await readFile(join(root,'state/live-architect/tunnel-milestone/local-readonly-fixtures-v2-review.json')));
if(JSON.parse(verified.result.message.content).verdict!=='approve')throw Error('Fixture review not approved');
for(const f of verified.files)if(hash(await readFile(join(source,f.file)))!==f.sha256)throw Error('Fixture source changed');
const route=JSON.parse(await readFile(join(root,'state/live-architect/tunnel-milestone/local-readonly-route-final.json')));
if(route.sourceCommit!=='f84bb0c'||!route.result.message.content.startsWith('{verdict:approve,findings:[]'))throw Error('Route review unresolved');
const suite=await readFile(join(root,'state/live-architect/tunnel-milestone/companion-lighting-suite.log'),'utf8');
if(!/ℹ pass 1350[\\s\\S]*ℹ fail 0/.test(suite))throw Error('Full tests missing');
`;
const text=old.replace("const expected = 'd89f7cf';","const expected = 'f84bb0c';").replace('const oldBytes =',pre+'\nconst oldBytes =');
if(text===old||!text.includes('f84bb0c'))throw Error('Source not pinned');writeFileSync(target,text);console.log('Pinned reviewed runtime wrapper ready');

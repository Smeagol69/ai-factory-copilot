import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const assets=new Map([
  ['/local-chat.js',[new URL('../app/public/local-chat.js',import.meta.url),'text/javascript']],
  ['/local-chat.css',[new URL('../app/public/local-chat.css',import.meta.url),'text/css']],
  ['/re-investigation.js',[new URL('../app/public/re-investigation.js',import.meta.url),'text/javascript']],
  ['/re-investigation.css',[new URL('../app/public/re-investigation.css',import.meta.url),'text/css']],
]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorText=e=>String(e?.message??'Local chat unavailable').replace(/(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,500);
async function readBody(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Object.assign(Error('Use application/json'),{statusCode:415});
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>24576)throw Object.assign(Error('Chat input too large'),{statusCode:413});chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}
  catch{throw Object.assign(Error('Invalid JSON request'),{statusCode:400});}
}

// An additive extension keeps the existing control room/check routes intact.
// The static page is served from its existing source with these two assets.
export function attachLocalChat(server,chat,{investigation}={}){
  const previous=server.listeners('request');server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    const handled=req.url==='/'||assets.has(req.url)||req.url?.startsWith('/api/local-chat/')||req.url?.startsWith('/api/re-investigation/');
    if(!handled){for(const listener of previous)listener.call(server,req,res);return;}
    const json=(code,data)=>{const text=JSON.stringify(data);if(Buffer.byteLength(text)>262144){res.writeHead(503).end('Chat response exceeds limit');return;}
      res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}).end(text);};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const authority=`127.0.0.1:${req.socket.localPort}`,origin=`http://${authority}`;
    if(req.headers.host!==authority||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'){
      req.resume();json(403,{error:'Local application origin required'});return;}
    (async()=>{
      if(req.url==='/'&&req.method==='GET'){
        const html=readFileSync(new URL('../app/public/index.html',import.meta.url),'utf8').replace('</head>','<link rel="stylesheet" href="/local-chat.css"><script src="/local-chat.js" defer></script><link rel="stylesheet" href="/re-investigation.css"><script src="/re-investigation.js" defer></script></head>');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);return;
      }
      if(assets.has(req.url)&&req.method==='GET'){
        const [file,type]=assets.get(req.url);res.writeHead(200,{'Content-Type':type+'; charset=utf-8'}).end(readFileSync(fileURLToPath(file)));return;
      }
      if(req.url.startsWith('/api/re-investigation/')){
        if(!investigation){json(503,{error:'RE investigation service unavailable'});return;}
        if(req.method==='GET'&&req.url==='/api/re-investigation/status'){json(200,investigation.status());return;}
        if(req.method==='POST'&&['/api/re-investigation/start','/api/re-investigation/cancel'].includes(req.url)){
          const args=await readBody(req);
          if(req.url.endsWith('/start')){
            if(Object.keys(args).some(k=>k!=='targetId')||(args.targetId!==undefined&&args.targetId!=='satisfactory'))throw Object.assign(Error('Choose a registered game target'),{statusCode:400});
            json(200,investigation.start({targetId:args.targetId??'satisfactory'}));return;
          }
          if(Object.keys(args).some(k=>k!=='id')||!uuid.test(args.id))throw Object.assign(Error('Valid investigation ID required'),{statusCode:400});
          json(200,investigation.cancel(args.id));return;
        }
        json(404,{error:'Unknown investigation route'});return;
      }
      if(req.method==='GET'){
        if(req.url==='/api/local-chat/status'){const s=await chat.status();json(200,{...s,...s.modelStatus,activeConversationId:s.activeConversationId??null});return;}
        if(req.url==='/api/local-chat/conversations'){json(200,await chat.list());return;}
        const id=req.url.slice('/api/local-chat/conversations/'.length);
        if(req.url.startsWith('/api/local-chat/conversations/')&&uuid.test(id)){
          const record=await chat.get(id);json(record?200:404,record??{error:'Conversation not found'});return;
        }
      }
      if(req.method==='POST'&&['/api/local-chat/send','/api/local-chat/cancel'].includes(req.url)){
        const args=await readBody(req),keys=Object.keys(args),cancel=req.url.endsWith('/cancel');
        if(keys.some(k=>!['conversationId',...(cancel?[]:['message'])].includes(k)) ||
            (args.conversationId!==undefined&&!uuid.test(args.conversationId)) || (cancel&&!args.conversationId))throw Object.assign(Error('Invalid chat fields'),{statusCode:400});
        if(!cancel&&(typeof args.message!=='string'||!args.message.trim()))throw Object.assign(Error('Enter a message'),{statusCode:400});
        if(!cancel&&args.message.length>6000)throw Object.assign(Error('Message exceeds6000 characters'),{statusCode:413});
        const result=cancel?await chat.cancel(args.conversationId):await chat.send(args);json(200,result);return;
      }
      json(404,{error:'Unknown local chat route'});
    })().catch(error=>{if(!res.writableEnded)json(error.statusCode??503,{error:errorText(error),conversationId:error.conversationId});});
  });
  return server;
}

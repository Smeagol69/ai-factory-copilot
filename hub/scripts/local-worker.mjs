import { resolve } from 'node:path';
import { runtimeContext } from '../lib/project.mjs';
import { createLocalModelGateway } from '../lib/local-worker-gateway.mjs';
const context=await runtimeContext();
const [{McpServer},{StdioServerTransport},{z}]=await Promise.all([
  context.moduleAt('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'),
  context.moduleAt('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'),
  context.moduleAt('node_modules/zod/index.js'),
]);
const server=new McpServer({name:'copilot-local-model',version:'1.0.0'}, {instructions:'Explicit user-authorized local model collaboration. No inference on connection or status. Each chat call is a bounded local run using the same persistent Copilot conversations and project MCP tools. No API credit fallback, automatic task polling, extra permissions or game writes. Preserve conversationId for follow-ups; unknown outcomes are not automatically replayed.'});
const gateway=createLocalModelGateway({root:context.root});
const id=z.string().uuid();
const tools=[
  ['local_model_status','Read local HauhauCS installation, ownership and activity without starting inference.',z.object({}).strict(),true],
  ['local_model_chat','Ask HauhauCS an explicit project question or scoped work request. Uses local hardware and shared MCP context; saves a separate conversation visible in Copilot. Reuse conversationId to continue. It cannot edit source/game files through this chat.',z.object({message:z.string().trim().min(1).max(6000),conversationId:id.optional()}).strict(),false],
  ['local_model_cancel','Request cancellation of the active local conversation. A partial or unknown outcome is not proof of completion.',z.object({conversationId:id}).strict(),false],
];
for(const [name,description,schema,readOnlyHint] of tools)server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint,destructiveHint:false,idempotentHint:readOnlyHint,openWorldHint:false}},async args=>{
  try{const result=await gateway.dispatch(name,args);return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};}
  catch(error){return {isError:true,content:[{type:'text',text:String(error.message).slice(0,500)}]};}
});
await server.connect(new StdioServerTransport());

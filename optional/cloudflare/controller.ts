import { DurableObject } from 'cloudflare:workers';
import { SubscriptionVault } from './vault';
interface Env {
  HOST: DurableObjectNamespace<SubscriptionHost>;
  // Separate deployment secrets: never share these with RedAgent, facets, or the image.
  CLOUD_HOST_ADMIN_TOKEN: string;
  CLOUD_VAULT_KEY_HEX: string;
}
function keyBytes(raw: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(raw ?? '')) throw new Error('Vault key unavailable');
  return new Uint8Array(raw.match(/../g)!.map(part=>Number.parseInt(part,16)));
}
async function authorized(request: Request, expected: string): Promise<boolean> {
  const value=request.headers.get('authorization');
  if (!expected || expected.length<32 || !value || value.length>1024) return false;
  const enc=new TextEncoder();
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(`Bearer ${expected}`)));
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
/** Control plane scaffold. There is deliberately no public login, token import,
 * credential RPC, start, or refresh endpoint until cloud-host onboarding is implemented.
 * Do not claim deploying this starts a companion. The container is never started here.
 */
export class SubscriptionHost extends DurableObject<Env> {
  async status() {
    const vault=await SubscriptionVault.create(this.ctx.storage,keyBytes(this.env.CLOUD_VAULT_KEY_HEX),this.ctx.id.toString());
    return {...await vault.status(),implementation:'scaffold',inferenceEnabled:false};
  }
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    if(!await authorized(request,env.CLOUD_HOST_ADMIN_TOKEN))return new Response('Not found',{status:404});
    if(request.method!=='GET'||new URL(request.url).pathname!=='/status')return new Response('Not found',{status:404});
    try {return Response.json(await env.HOST.getByName('personal-singleton').status(),{headers:{'Cache-Control':'no-store'}});}
    catch {return Response.json({error:'Cloud host configuration unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}
  }
};

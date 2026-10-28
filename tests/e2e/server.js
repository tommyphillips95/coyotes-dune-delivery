// Local mock server for the mobile e2e suite: serves frontend/ and runs the
// real netlify/functions with Supabase, Stripe, Twilio and Firebase mocked.
// Nothing external is contacted.
"use strict";
const http=require('http'),fs=require('fs'),path=require('path'),Module=require('module');
const REPO=path.join(__dirname,'..','..');
Object.assign(process.env,{JWT_SECRET:'e2e-secret-e2e-secret-e2e-secret-xx',SUPABASE_URL:'https://fake',SUPABASE_SERVICE_KEY:'k',
 STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_PUBLISHABLE_KEY:'pk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'pw-e2e-123',
 INTERNAL_FUNCTION_SECRET:'int', SITE_ORIGIN:'http://localhost:'+(process.env.PORT||8899)});
const SEED={applications:[],orders:[],customers:[],dispatch_offers:[],driver_locations:[],order_status_logs:[],sms_logs:[],documents:[]};
const fake=require('./fakedb').create(JSON.parse(JSON.stringify(SEED)));
global.FAKE=fake; const stripeCalls=[]; global.STRIPE=stripeCalls; const pis={};
class Stripe{ constructor(){ this.paymentIntents={
  create:async(p,o)=>{const id='pi_'+(Object.keys(pis).length+1);pis[id]={id,client_secret:id+'_secret',status:'requires_payment_method',...p};stripeCalls.push(['pi.create',p,o]);return pis[id];},
  retrieve:async(id)=>{stripeCalls.push(['pi.retrieve',id]);return pis[id]||{id,status:'requires_payment_method',amount:0,metadata:{}};},
  update:async(id,p)=>{stripeCalls.push(['pi.update',id,p]);Object.assign(pis[id],p);return pis[id];},
  cancel:async(id)=>{stripeCalls.push(['pi.cancel',id]);pis[id].status='canceled';return pis[id];},
  capture:async(id,p)=>{stripeCalls.push(['pi.capture',id,p]);pis[id].status='succeeded';return pis[id];}};
  this.customers={create:async(p)=>{stripeCalls.push(['cus.create',p]);return {id:'cus_1',...p};},retrieve:async(id)=>({id})};
  this.refunds={create:async(p)=>{stripeCalls.push(['refund',p]);return {id:'re_1',status:'succeeded',...p};}};
  this.webhooks={constructEvent:(b)=>JSON.parse(b)}; } }
global.PIS=pis;
const realLoad=Module._load;
Module._load=function(r){ if(r==='@supabase/supabase-js') return {createClient:()=>fake};
 if(r==='stripe') return Stripe; if(r==='twilio') return ()=>({messages:{create:async(m)=>{stripeCalls.push(['sms',m]);return {sid:'SM1'};}}});
 if(r==='firebase-admin') return {apps:[],initializeApp(){},credential:{cert(){}},messaging:()=>({send:async()=>'x'})};
 return realLoad.apply(this,arguments); };
const fnLog=[]; global.FNLOG=fnLog;
const uploads=[]; fake.storage={from:(bucket)=>({upload:async(p,d,o)=>{uploads.push({bucket,path:p,bytes:d.length,head:Buffer.from(d).slice(0,8).toString('hex'),opts:o});return {data:{path:p},error:null};}})};
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.woff2':'font/woff2','.ico':'image/x-icon','.webmanifest':'application/json'};
exports.start=(port)=>new Promise((ok)=>{const srv=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'); const chunks=[];for await(const c of req) chunks.push(c); const rawBuf=Buffer.concat(chunks); const isMP=/multipart/i.test(req.headers['content-type']||''); let body=isMP?rawBuf.toString('base64'):rawBuf.toString('utf8');
  if(u.pathname==='/__state'){res.end(JSON.stringify({db:fake.db,stripe:stripeCalls,fn:fnLog,pis,uploads}));return;}
  if(u.pathname==='/__seed'){const j=JSON.parse(body);for(const [t,rows] of Object.entries(j)){fake.db[t]=(fake.db[t]||[]).concat(rows);}res.end('{}');return;}
  if(u.pathname==='/__patch'){const j=JSON.parse(body);const r=fake.db[j.table].find(x=>x.id===j.id);Object.assign(r,j.set);res.end('{}');return;}
  if(u.pathname==='/__charge'){const h=require(path.join(REPO,'netlify/functions/payment-webhook.js')).handler;const r=await h({httpMethod:'POST',headers:{'stripe-signature':'t'},body:JSON.stringify({id:'evt_'+Date.now(),type:'charge.refunded',data:{object:JSON.parse(body)}})});res.writeHead(r.statusCode);res.end(r.body);return;}
  if(u.pathname==='/__webhook'){const h=require(path.join(REPO,'netlify/functions/payment-webhook.js')).handler;const j=JSON.parse(body);const pi=pis[j.pi];if(j.type==='payment_intent.succeeded'){pi.status='succeeded';pi.amount_received=pi.amount;}const r=await h({httpMethod:'POST',headers:{'stripe-signature':'t'},body:JSON.stringify({id:'evt_'+Date.now(),type:j.type,data:{object:pi}})});fnLog.push(['WEBHOOK',j.type,r.statusCode,r.body]);res.writeHead(r.statusCode);res.end(r.body);return;}
  let m=u.pathname.match(/^\/(?:api|\.netlify\/functions)\/([a-z-]+)(\/.*)?$/);
  if(u.pathname==='/api/submit-order') m=[0,'create-order'];
  if(u.pathname==='/api/applications') m=[0,'submit-application'];
  if(m){ const f=path.join(REPO,'netlify/functions',m[1]+'.js'); if(!fs.existsSync(f)){res.writeHead(404);res.end('{}');return;}
    const q={};u.searchParams.forEach((v,k)=>q[k]=v);
    const ev={httpMethod:req.method,path:u.pathname,rawUrl:'http://localhost'+req.url,rawQuery:u.search.slice(1),headers:Object.fromEntries(Object.entries(req.headers)),queryStringParameters:q,body,isBase64Encoded:isMP};
    let r; try{ r=await require(f).handler(ev,{}); }catch(e){ r={statusCode:599,body:String(e.stack)}; }
    fnLog.push([req.method,u.pathname,r.statusCode,(r.body||'').slice(0,300)]);
    const hh={...(r.headers||{})}; if(process.env.JSONCT && !Object.keys(hh).some(k=>/content-type/i.test(k))) hh['Content-Type']='application/json'; res.writeHead(r.statusCode,hh);res.end(r.body||'');return;}
  let p=path.join(REPO,'frontend',decodeURIComponent(u.pathname)); if(fs.existsSync(p)&&fs.statSync(p).isDirectory()) p=path.join(p,'index.html');
  if(!fs.existsSync(p)){ if(/^\/(admin|apply)\//.test(u.pathname)) p=path.join(REPO,'frontend',u.pathname.split('/')[1],'index.html'); else {res.writeHead(404);res.end('nf');return;} }
  res.writeHead(200,{'content-type':types[path.extname(p)]||'application/octet-stream'});fs.createReadStream(p).pipe(res);
});srv.listen(port,()=>ok(srv));});
if(require.main===module) exports.start(process.env.PORT||8899).then(()=>console.log('up'));

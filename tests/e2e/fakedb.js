"use strict";
// Permissive in-memory supabase fake with joins for customer/driver, dotted eq.
function create(seed) {
  const db = {}; Object.keys(seed||{}).forEach(t=>db[t]=seed[t].map(r=>({...r})));
  let n=1; const log=[];
  const T=(x)=>db[x]||(db[x]=[]);
  const get=(r,c)=>c.split('.').reduce((o,k)=>o==null?o:o[k],r);
  function join(name,row,sel){
    const o={...row};
    if(name==='orders'||name==='driver_applications'){
      if(/customer:customers/.test(sel)&&row.customer_id) o.customer=T('customers').find(c=>c.id===row.customer_id)||null;
      if(/order_items/.test(sel)) o.order_items=T('order_items').filter(i=>i.order_id===row.id);
      if(/status_logs/.test(sel)) o.status_logs=T('order_status_logs').filter(i=>i.order_id===row.id);
      if(/documents\(/.test(sel)) o.documents=T('documents').filter(i=>i.application_id===row.id);
    }
    if(name==='dispatch_offers'&&/orders\(/.test(sel)) o.orders=T('orders').find(x=>x.id===row.order_id)||null;
    if(name==='applications'&&/documents\(/.test(sel)) o.documents=T('documents').filter(i=>i.application_id===row.id);
    return o;
  }
  function from(name){
    const s={op:'select',f:[],ord:null,lim:null,single:null,payload:null,ret:false,sel:'*',onConflict:null};
    const m=r=>s.f.every(f=>f(join(name,r,'customer:customers')));
    function run(){
      const rows=T(name); let data;
      if(s.op==='insert'||s.op==='upsert'){
        const arr=Array.isArray(s.payload)?s.payload:[s.payload]; const out=[];
        for(const r of arr){
          let ex=s.op==='upsert'&&rows.find(x=>(s.onConflict||'id').split(',').every(k=>x[k]===r[k]));
          if(ex){Object.assign(ex,r);out.push(ex);} else {const nr={id:r.id||name+'-'+n++,created_at:new Date().toISOString(),...r};rows.push(nr);out.push(nr);}
        }
        data=s.ret?out.map(r=>join(name,r,s.sel)):null;
      } else if(s.op==='update'){ const hit=rows.filter(m); hit.forEach(r=>Object.assign(r,s.payload)); data=s.ret?hit.map(r=>join(name,r,s.sel)):null; }
      else if(s.op==='delete'){ const hit=rows.filter(m); hit.forEach(r=>rows.splice(rows.indexOf(r),1)); data=null; }
      else { data=rows.filter(m).map(r=>join(name,r,s.sel)); if(s.ord){const{c,a}=s.ord;data.sort((x,y)=>(x[c]<y[c]?-1:x[c]>y[c]?1:0)*(a?1:-1));} }
      if(Array.isArray(data)&&s.lim!=null) data=data.slice(0,s.lim);
      log.push({name,op:s.op,payload:s.payload});
      if(s.single==='maybe') return {data:Array.isArray(data)?data[0]||null:data,error:null};
      if(s.single==='one'){const row=Array.isArray(data)?data[0]:data;return row?{data:row,error:null}:{data:null,error:{code:'PGRST116',details:'The result contains 0 rows',message:'no rows'}};}
      return {data,error:null,count:Array.isArray(data)?data.length:0};
    }
    const b={
      select(x){ if(s.op!=='select') s.ret=true; if(x) s.sel=x; return b;},
      insert(r){s.op='insert';s.payload=r;return b;}, upsert(r,o){s.op='upsert';s.payload=r;s.onConflict=o&&o.onConflict;return b;},
      update(p){s.op='update';s.payload=p;return b;}, delete(){s.op='delete';return b;},
      eq(c,v){s.f.push(r=>get(r,c)===v);return b;}, neq(c,v){s.f.push(r=>get(r,c)!==v);return b;},
      lt(c,v){s.f.push(r=>get(r,c)<v);return b;}, lte(c,v){s.f.push(r=>get(r,c)<=v);return b;},
      gt(c,v){s.f.push(r=>get(r,c)>v);return b;}, gte(c,v){s.f.push(r=>get(r,c)>=v);return b;},
      in(c,v){s.f.push(r=>v.includes(get(r,c)));return b;},
      is(c,v){s.f.push(r=>(get(r,c)??null)===v);return b;},
      not(c,op,v){ if(op==='is') s.f.push(r=>(get(r,c)??null)!==v); else if(op==='in'){const vs=String(v).replace(/[()]/g,'').split(',');s.f.push(r=>!vs.includes(String(get(r,c))));} else s.f.push(r=>get(r,c)!==v); return b;},
      filter(c,op,v){ if(op==='eq') return b.eq(c,v); if(op==='in'){const vs=String(v).replace(/[()"]/g,'').split(',');s.f.push(r=>vs.includes(String(get(r,c))));return b;} return b;},
      or(){return b;}, ilike(c,v){const re=new RegExp('^'+String(v).replace(/%/g,'.*')+'$','i');s.f.push(r=>re.test(get(r,c)||''));return b;},
      order(c,o){s.ord={c,a:!(o&&o.ascending===false)};return b;}, limit(x){s.lim=x;return b;}, range(a,z){s.lim=z-a+1;return b;},
      maybeSingle(){s.single='maybe';return b;}, single(){s.single='one';return b;},
      then(res,rej){try{res(run());}catch(e){rej?rej(e):console.error(e);}},
    };
    return b;
  }
  return { db, log, from, rpc: async (fn,args)=>{log.push({rpc:fn,args});return {data:null,error:null};},
    storage:{from:()=>({upload:async()=>({data:{path:'x'},error:null}),createSignedUrl:async()=>({data:{signedUrl:'http://x'},error:null}),getPublicUrl:()=>({data:{publicUrl:'http://x'}})})},
    auth:{} };
}
module.exports={create};

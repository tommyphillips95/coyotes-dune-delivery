window.Stripe=function(pk){return {elements(){return {create(){return {mount(sel){const el=typeof sel==='string'?document.querySelector(sel):sel; if(el){el.innerHTML='<div style="height:40px;border:1px solid #ccc">4242 4242 4242 4242  12/30  123</div>';}},on(){},destroy(){},unmount(){},update(){}}}}},
 confirmCardPayment: async (cs)=>{ const id=cs.replace(/_secret.*/,''); if(window.__declineNext){window.__declineNext=false;return {error:{type:'card_error',message:'Your card was declined.'}};}
   await fetch('/__webhook',{method:'POST',body:JSON.stringify({pi:id,type:'payment_intent.succeeded'})}); return {paymentIntent:{id,status:'succeeded'}};},
 retrievePaymentIntent: async()=>({paymentIntent:{status:'succeeded'}})};};

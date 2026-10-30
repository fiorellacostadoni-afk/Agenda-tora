
(() => {
 const businessId='00000000-0000-4000-8000-000000000001';
 const demoParams=new URLSearchParams(location.search);
 if(window.__TUSTURNA_VERCEL_PREVIEW__){
  demoParams.set('reservar',businessId);
  if(!demoParams.has('mode'))demoParams.set('mode','sena');
  history.replaceState(null,'',location.pathname+'?'+demoParams.toString()+location.hash);
 }
 const mode=new URLSearchParams(location.search).get('mode')||'sena';
 const checkoutToken='a'.repeat(96);
 let bookings=0,checkouts=0;
 const updateCounts=()=>{const el=document.getElementById('paymentDemoCounts');if(el)el.textContent='Turnos simulados: '+bookings+' · Intentos de pago simulados: '+checkouts};
 const catalog={negocio_id:businessId,nombre:'Negocio de prueba',zona_horaria:'America/Argentina/Buenos_Aires',modalidad_pago:mode,porcentaje_senia:15,tipo_senia:'porcentaje',cobro_online_disponible:true,metodos_pago:['efectivo','transferencia'],servicios:[{id:'service',nombre:'Servicio de prueba',precio:10000,duracion_minutos:30,intervalo_turnos_minutos:30}],profesionales:[{id:'professional',nombre:'Profesional de prueba',servicios:[{servicio_id:'service',intervalo_turnos_minutos:30}]}]};
 const client={auth:{onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}}},async getSession(){return {data:{session:null}}}},
  async rpc(name,args){
   if(name.startsWith('catalogo_reserva'))return {data:catalog,error:null};
   if(name==='obtener_fechas_disponibles'){let days=[];for(let d=new Date(args.p_desde+'T12:00:00Z');d<=new Date(args.p_hasta+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1)){if(d>Date.now())days.push({fecha:d.toISOString().slice(0,10)})}return {data:days,error:null};}
   if(name==='obtener_horarios_disponibles')return {data:[{inicio:args.p_fecha+'T13:00:00Z',fin:args.p_fecha+'T13:30:00Z'}],error:null};
   if(name==='reservar_turno_con_checkout_publico'){bookings++;updateCounts();return {data:{turno_id:'00000000-0000-4000-8000-000000000002',checkout_token:checkoutToken},error:null};}
   if(name==='reservar_turno_publico'){bookings++;updateCounts();return {data:'00000000-0000-4000-8000-000000000002',error:null};}
   throw new Error('Unexpected fixture RPC: '+name);
  },
  functions:{async invoke(name,options){
   if(name==='mercadopago-create-checkout'){
    if(options.body.action==='availability')return {data:{available:true},error:null};
    if(options.body.checkout_token!==checkoutToken)return {data:null,error:{context:Response.json({error:'No se pudo autorizar el pago de la reserva.'},{status:403})}};
    checkouts++;updateCounts();
    if(new URLSearchParams(location.search).has('fail')&&checkouts===1)return {data:null,error:{context:Response.json({error:'Falla simulada. Volvé a preparar el pago.'},{status:503})}};
    return {data:{checkout_url:'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=demo-tusturna',amount_total:10000,amount_to_pay:mode==='total'?10000:1500,expires_at:new Date(Date.now()+30*60000).toISOString()},error:null};
   }
   if(name==='send-booking-notification')return {data:{email:'disabled'},error:null};
   throw new Error('Unexpected fixture function: '+name);
  }}
 };
 window.supabase={createClient:()=>client};
 window.__TUSTURNA_PREVIEW_FIXTURE_READY__=true;
 document.addEventListener('DOMContentLoaded',()=>{
  const banner=document.createElement('div');banner.style.cssText='padding:12px 20px;background:#fff8dc;color:#5f4614;text-align:center;font:14px Arial';banner.textContent='Vista de prueba: no se guardan turnos ni se cobran pagos. ';
  const count=document.createElement('span');count.id='paymentDemoCounts';banner.append(count);document.body.prepend(banner);updateCounts();
  document.addEventListener('click',event=>{if(event.target.closest('#publicPayMercadoPago')){event.preventDefault();document.getElementById('publicCheckoutStatus').textContent='Prueba completada. No se abrió un pago real.';}});
 });
})();
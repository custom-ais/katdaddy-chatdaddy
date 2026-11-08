(()=>{
 'use strict';
 const script=document.currentScript;
 if(!script||document.getElementById('dvs-bob-widget'))return;
 const origin=new URL(script.src).origin;
 const wrapper=document.createElement('div');wrapper.id='dvs-bob-widget';
 const shadow=wrapper.attachShadow({mode:'open'});
 const style=document.createElement('style');style.textContent=`:host{all:initial}*{box-sizing:border-box}button{font:600 14px system-ui,sans-serif;cursor:pointer}.dock{position:fixed;right:24px;bottom:24px;display:flex;align-items:center;gap:10px;z-index:2147483002}.launcher{border:0;border-radius:50px;background:#e8641e;color:#fff;box-shadow:0 5px 25px #17263635;padding:9px 19px 9px 9px;display:flex;gap:10px;align-items:center}.launcher img{display:block;width:40px;height:40px;flex-shrink:0;border-radius:50%;background:#fff;object-fit:contain}.launcher:focus-visible,.close:focus-visible,.nudge button:focus-visible{outline:3px solid #f6bc91;outline-offset:4px}.panel{position:fixed;right:24px;bottom:90px;width:440px;height:min(730px,calc(100dvh - 115px));border:1px solid #d4dde6;border-radius:19px;overflow:hidden;background:#fff;box-shadow:0 20px 80px #12294040;z-index:2147483001;display:none}.panel.open{display:block}iframe{display:block;border:0;width:100%;height:100%}.launcher.hide{display:none}.close{border:0;border-radius:50%;height:52px;width:52px;padding:0;color:#fff;background:#e8641e;box-shadow:0 5px 25px #17263635;font-size:28px;line-height:1;display:none}.close.open{display:grid;place-items:center}
.nudge{position:fixed;right:24px;bottom:92px;width:320px;padding:14px 14px 14px 14px;border:1px solid #e3e9ef;border-radius:18px;background:#fff;color:#172536;box-shadow:0 14px 44px #12294030;z-index:2147483000;font:15px/1.45 system-ui,sans-serif;display:none;opacity:0;transform:translateY(8px);transition:opacity .25s ease,transform .25s ease}.nudge.show{display:block}.nudge.in{opacity:1;transform:none}.nudge-row{display:flex;gap:10px;align-items:flex-start;padding-right:18px}.nudge img{width:36px;height:36px;border-radius:50%;flex-shrink:0;background:#fff;border:1px solid #dbe7f3}.nudge-hi{display:block;font-weight:800;font-size:15px;color:#0f2236}.nudge p{margin:2px 0 0;font-size:14px;font-weight:500;color:#33475b}.nudge-actions{display:grid;gap:8px;margin-top:12px}.nudge-cta{width:100%;border:0;border-radius:12px;background:#e8641e;color:#fff;padding:10px 12px}.nudge-cta:hover{background:#d4560f}.nudge-ask{width:100%;border:1px solid #cfd9e3;border-radius:12px;background:#fff;color:#172536;padding:9px 12px}.nudge-ask:hover{background:#f4f7fa}.nudge-x{position:absolute;top:6px;right:6px;width:28px;height:28px;border:0;border-radius:50%;background:transparent;color:#5b6b7c;font-size:18px;line-height:1}.nudge-x:hover{background:#f1f5f9}.nudge::after{content:'';position:absolute;right:34px;bottom:-8px;width:14px;height:14px;background:#fff;border-right:1px solid #e3e9ef;border-bottom:1px solid #e3e9ef;transform:rotate(45deg)}
@media(prefers-reduced-motion:reduce){.nudge{transition:none;transform:none}}
@media(max-width:520px){.panel{right:8px;left:8px;width:auto;bottom:82px;height:calc(100dvh - 97px);border-radius:15px}.dock{right:14px;bottom:15px}.nudge{right:12px;left:12px;width:auto;bottom:80px}}`;
 const launch=document.createElement('button');launch.className='launcher';launch.type='button';launch.setAttribute('aria-expanded','false');launch.setAttribute('aria-controls','bob-chat-panel');launch.textContent='Chat & book with BOB';
 const avatar=document.createElement('img');avatar.src=origin+'/bob-avatar.png';avatar.alt='';avatar.width=40;avatar.height=40;launch.prepend(avatar);
 const panel=document.createElement('div');panel.id='bob-chat-panel';panel.className='panel';panel.setAttribute('role','region');panel.setAttribute('aria-label','DVS booking assistant');
 const close=document.createElement('button');close.type='button';close.className='close';close.textContent='\u00d7';close.setAttribute('aria-label','Close booking assistant');
 let iframe,open=false,ready=false,loadedAt=0;
 // The chat says 'bob:ready' once it's running. One that loaded but never said so (blocked, or the network
 // dropped) is loaded again the next time it's opened, instead of staying broken until the page is reloaded.
 const stuck=()=>iframe&&!ready&&loadedAt&&Date.now()-loadedAt>3000;
 // start: a starting path from the nudge (cleaning, repair, emergency, pest); the chat begins it if nothing's been said yet.
 // While the chat is open the launcher becomes a round close button in the same spot, below the chat.
 const toggle=(value,start='')=>{const focused=shadow.activeElement===launch;open=value;panel.classList.toggle('open',open);close.classList.toggle('open',open);launch.classList.toggle('hide',open);launch.setAttribute('aria-expanded',String(open));if(open){hideNudge();}if(open&&stuck()){iframe.remove();iframe=null;}if(open&&!iframe){const frame=document.createElement('iframe');iframe=frame;ready=false;loadedAt=0;frame.src=origin+'/chat?embed=1'+(start?'&start='+encodeURIComponent(start):'');frame.title='BOB \u2014 Dryer Vent Squad booking assistant';frame.referrerPolicy='strict-origin';frame.addEventListener('load',()=>{if(frame!==iframe)return;loadedAt=Date.now();if(open)frame.contentWindow?.postMessage({type:'bob:restore'},origin);});panel.append(frame);}else if(open&&iframe){iframe.contentWindow?.postMessage({type:'bob:restore'},origin);if(start)iframe.contentWindow?.postMessage({type:'bob:start',start},origin);}if(!open)launch.focus();else if(focused)close.focus();};
 launch.addEventListener('click',()=>toggle(!open));close.addEventListener('click',()=>toggle(false));shadow.addEventListener('keydown',e=>{if(e.key==='Escape'&&open)toggle(false);});
 window.addEventListener('message',event=>{if(event.origin!==origin||!iframe||event.source!==iframe.contentWindow)return;if(event.data?.type==='bob:ready')ready=true;if(event.data?.type==='bob:minimize')toggle(false);});

 // ---- The nudge: BOB introduces itself and offers to book or answer questions (ASCII only, so it
 // shows right on any page). Shows once per visit as soon as the visitor starts scrolling, after 30
 // seconds on the page, or (with a mouse) when the pointer heads off the page. Never opens the chat
 // by itself. Dismissing it keeps it away for two weeks. Turn it off with data-nudge="off" on the
 // script tag; data-nudge-delay sets the seconds.
 const NUDGES=[
  {key:'emergency',test:/emergenc|fire|overheat|too hot|running hot|clog|burning|safety/,text:'Dryer running hot or clogged? I can get help on the way fast, or answer your questions.',cta:'Get help now'},
  {key:'pest',test:/nest|bird|pest|animal|rodent|critter|squirrel/,text:'Birds or pests in your dryer vent? I can book nest removal, or answer your questions.',cta:'Book nest removal'},
  {key:'repair',test:/repair|reroute|upgrade|install|damag|disconnect|crush|termination|roof/,text:'Damaged or disconnected vent? I can book an assessment, or answer your questions.',cta:'Book an assessment'},
  {key:'cleaning',test:/pric|cost|package|clean/,text:'I can get your exact price and book a cleaning in about a minute, or answer your questions.',cta:'Get my price'},
 ];
 // The home page covers everything, so it gets the general offer; other pages match their topic.
 const home=/^\/?(index\.\w+)?$/.test(location.pathname);
 const page=home?'':(location.pathname+' '+document.title).toLowerCase();
 const pick=NUDGES.find(n=>n.test.test(page))||{key:'',text:'I can help you book a visit, or answer any questions about your dryer vent.',cta:'Book a visit'};
 const nudge=document.createElement('div');nudge.className='nudge';nudge.setAttribute('role','dialog');nudge.setAttribute('aria-label','Message from BOB');
 const row=document.createElement('div');row.className='nudge-row';
 const face=document.createElement('img');face.src=origin+'/bob-avatar.png';face.alt='';face.width=36;face.height=36;
 const copy=document.createElement('div');copy.setAttribute('aria-live','polite');
 const hi=document.createElement('strong');hi.className='nudge-hi';hi.textContent="Hi, I'm BOB!";
 const words=document.createElement('p');words.textContent="Dryer Vent Squad's booking assistant. "+pick.text;copy.append(hi,words);row.append(face,copy);
 const cta=document.createElement('button');cta.type='button';cta.className='nudge-cta';cta.textContent=pick.cta;
 const ask=document.createElement('button');ask.type='button';ask.className='nudge-ask';ask.textContent='Ask a question';
 const actions=document.createElement('div');actions.className='nudge-actions';actions.append(cta,ask);
 const x=document.createElement('button');x.type='button';x.className='nudge-x';x.textContent='\u00d7';x.setAttribute('aria-label','Dismiss message');
 nudge.append(x,row,actions);
 const store=(kind,key,value)=>{try{const s=kind==='session'?sessionStorage:localStorage;if(value===undefined)return s.getItem(key);s.setItem(key,value);}catch{return null;}};
 const off=script.dataset.nudge==='off';
 const delay=Math.max(5,Number(script.dataset.nudgeDelay)||30)*1000;
 let shown=false;
 const allowed=()=>{if(off||shown||open||store('session','bob-nudge-shown'))return false;const dismissed=Number(store('local','bob-nudge-dismissed')||0);return !(dismissed&&Date.now()-dismissed<14*864e5);};
 function showNudge(){if(!allowed())return;shown=true;store('session','bob-nudge-shown','1');nudge.classList.add('show');requestAnimationFrame(()=>requestAnimationFrame(()=>nudge.classList.add('in')));}
 function hideNudge(){nudge.classList.remove('in','show');}
 cta.addEventListener('click',()=>{hideNudge();toggle(true,pick.key);});
 // 'question': the chat opens its list of common questions, ready for the visitor's own.
 ask.addEventListener('click',()=>{hideNudge();toggle(true,'question');});
 x.addEventListener('click',()=>{store('local','bob-nudge-dismissed',String(Date.now()));hideNudge();launch.focus();});
 launch.addEventListener('click',()=>{shown=true;store('session','bob-nudge-shown','1');});
 if(!off){
  const timer=()=>{if(document.visibilityState==='visible')showNudge();else document.addEventListener('visibilitychange',function v(){if(document.visibilityState==='visible'){document.removeEventListener('visibilitychange',v);setTimeout(showNudge,3000);}});};
  setTimeout(timer,delay);
  // As soon as they start scrolling (a little past the top, so a bump of the trackpad doesn't count).
  const onScroll=()=>{if(window.scrollY>=80){window.removeEventListener('scroll',onScroll);showNudge();}};
  window.addEventListener('scroll',onScroll,{passive:true});
  if(window.matchMedia&&window.matchMedia('(pointer:fine)').matches)document.addEventListener('mouseout',e=>{if(!e.relatedTarget&&e.clientY<=0)showNudge();});
 }
 const dock=document.createElement('div');dock.className='dock';dock.append(close,launch);
 shadow.append(style,panel,nudge,dock);document.body.append(wrapper);
})();

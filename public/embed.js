(()=>{
 'use strict';
 const script=document.currentScript;
 if(!script||document.getElementById('dvs-bob-widget'))return;
 const origin=new URL(script.src).origin;
 const wrapper=document.createElement('div');wrapper.id='dvs-bob-widget';
 const shadow=wrapper.attachShadow({mode:'open'});
 const style=document.createElement('style');style.textContent=`:host{all:initial}*{box-sizing:border-box}button{font:600 14px system-ui,sans-serif;cursor:pointer}.launcher{position:fixed;right:24px;bottom:24px;border:0;border-radius:50px;background:#e8641e;color:#fff;box-shadow:0 5px 25px #17263635;padding:9px 19px 9px 9px;display:flex;gap:10px;align-items:center;z-index:2147483000}.launcher img{display:block;width:40px;height:40px;flex-shrink:0;border-radius:50%;background:#fff;object-fit:contain}.launcher:focus-visible,.close:focus-visible{outline:3px solid #f6bc91;outline-offset:4px}.panel{position:fixed;right:24px;bottom:90px;width:440px;height:min(730px,calc(100dvh - 115px));border:1px solid #d4dde6;border-radius:19px;overflow:hidden;background:#fff;box-shadow:0 20px 80px #12294040;z-index:2147483001;display:none}.panel.open{display:block}iframe{display:block;border:0;width:100%;height:100%}.close{position:fixed;right:29px;bottom:94px;border:1px solid #c8d4df;border-radius:50%;height:34px;width:34px;color:#263e54;background:#fff;z-index:2147483002;display:none}.close.open{display:grid;place-items:center}@media(max-width:520px){.panel{right:8px;left:8px;width:auto;bottom:82px;height:calc(100dvh - 97px);border-radius:15px}.launcher{right:14px;bottom:15px}.close{right:13px;bottom:87px}}`;
 const launch=document.createElement('button');launch.className='launcher';launch.type='button';launch.setAttribute('aria-expanded','false');launch.setAttribute('aria-controls','bob-chat-panel');launch.textContent='Chat & book with BOB';
 const avatar=document.createElement('img');avatar.src=origin+'/bob-avatar.png';avatar.alt='';avatar.width=40;avatar.height=40;launch.prepend(avatar);
 const panel=document.createElement('div');panel.id='bob-chat-panel';panel.className='panel';panel.setAttribute('role','region');panel.setAttribute('aria-label','DVS booking assistant');
 const close=document.createElement('button');close.type='button';close.className='close';close.textContent='×';close.setAttribute('aria-label','Close booking assistant');
 let iframe,open=false;
 const toggle=(value)=>{open=value;panel.classList.toggle('open',open);close.classList.toggle('open',open);launch.setAttribute('aria-expanded',String(open));if(open&&!iframe){iframe=document.createElement('iframe');iframe.src=origin+'/chat?embed=1';iframe.title='BOB — Dryer Vent Squad booking assistant';iframe.referrerPolicy='strict-origin';panel.append(iframe);}if(!open)launch.focus();};
 launch.addEventListener('click',()=>toggle(!open));close.addEventListener('click',()=>toggle(false));shadow.addEventListener('keydown',e=>{if(e.key==='Escape'&&open)toggle(false);});
 shadow.append(style,panel,launch,close);document.body.append(wrapper);
})();

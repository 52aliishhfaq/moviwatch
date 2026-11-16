(()=>{'use strict';
const KEY='moviwatch-install-choice-v1',ua=navigator.userAgent||'';
const ios=/iPhone|iPad|iPod/i.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const macSafari=/Macintosh/i.test(ua)&&/Safari/i.test(ua)&&!/Chrome|Chromium|Edg|Firefox|OPR/i.test(ua);
const android=/Android/i.test(ua),edge=/Edg\\//i.test(ua),chromium=/Chrome|Chromium/i.test(ua)||edge,firefox=/Firefox/i.test(ua);
let promptEvent=null,modal=null,steps=null,primary=null,explained=false;
const standalone=()=>matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: minimal-ui)').matches||navigator.standalone===true;
const choice=()=>{try{return localStorage.getItem(KEY)||''}catch{return ''}};
const save=v=>{try{localStorage.setItem(KEY,v)}catch{}};
function guide(){
 if(ios)return ['Add Moviwatch to your Home Screen',['Open this page in Safari.','Tap Share — the square with the upward arrow.','Choose “Add to Home Screen”, then tap “Add”.','If offered, enable “Open as Web App”.'],'iOS requires this confirmation in the Share menu; websites cannot trigger it automatically.'];
 if(macSafari)return ['Add Moviwatch to your Mac',['Open Moviwatch in Safari 17 or later.','Choose File → Add to Dock from the macOS menu bar.','Confirm Add. Moviwatch appears in your Dock and Applications.'],'Safari controls this step from its own menu.'];
 if(android)return ['Install Moviwatch on Android',['Open the ⋮ menu in Chrome.','Tap “Install app” or “Add to Home screen”.','Confirm Install / Add.'],'Chrome may show its native install confirmation directly when ready.'];
 if(edge)return ['Install Moviwatch on Windows',['Open the Edge ⋯ menu.','Choose Apps → Install this site as an app.','Confirm Install; pin it to Start or taskbar if you like.'],'Desktop shortcut placement is controlled by Windows.'];
 if(chromium)return ['Install Moviwatch on your computer',['Open the browser menu (⋮).','Choose “Install Moviwatch” or “Install page as app”.','Confirm Install, then pin the app to your desktop or taskbar if desired.'],'The browser owns the final installation confirmation.'];
 if(firefox)return ['Create a Moviwatch shortcut',['This Firefox version does not provide the standard PWA install prompt.','For an app-style install, open this site in Chrome or Edge and choose Install.','On phones, use “Add to Home Screen” when available.'],'Playback still works in Firefox; only native app installation differs.'];
 return ['Add Moviwatch to your device',['Open your browser menu and look for “Install app”, “Add to Home Screen”, or “Create shortcut”.','If unavailable, try Chrome or Edge on desktop, or Safari on iPhone/iPad.','Confirm the browser’s Add / Install dialog.'],'Your browser controls installation; Moviwatch never creates a shortcut without your confirmation.'];
}
function build(){
 if(modal)return;
 modal=document.createElement('div');modal.className='pwa-backdrop';
 modal.innerHTML='<section class="pwa-dialog" role="dialog" aria-modal="true" aria-labelledby="pwaTitle" aria-describedby="pwaCopy"><button class="pwa-close" type="button" aria-label="Close">×</button><div class="pwa-brand"><img class="pwa-icon" src="/assets/moviwatch-app-icon.svg" alt=""><p class="pwa-kicker">MOVIWATCH · YOUR MOVIE SPACE</p><h2 class="pwa-title" id="pwaTitle">Your movies.<br>One tap away.</h2><p class="pwa-copy" id="pwaCopy">Install Moviwatch for a cleaner, full-screen experience and quick access from your desktop, phone, or tablet.</p></div><div class="pwa-benefits"><div class="pwa-benefit"><span class="pwa-benefit-icon">↗</span><strong>Quick launch</strong><small>Open from your device</small></div><div class="pwa-benefit"><span class="pwa-benefit-icon">▣</span><strong>App window</strong><small>Less browser clutter</small></div><div class="pwa-benefit"><span class="pwa-benefit-icon">★</span><strong>Your library</strong><small>Always close by</small></div></div><button class="pwa-primary" type="button"><span aria-hidden="true">✦</span><span class="pwa-primary-label">Install Moviwatch</span></button><div class="pwa-steps" hidden><strong class="pwa-steps-title"></strong><ol class="pwa-steps-list"></ol><p class="pwa-footnote pwa-steps-note"></p></div><button class="pwa-secondary" type="button">Not now</button><p class="pwa-footnote">Free to install · No account needed to browse</p></section>';
 document.body.append(modal);primary=modal.querySelector('.pwa-primary');steps=modal.querySelector('.pwa-steps');
 const close=()=>hide(true);modal.querySelector('.pwa-close').onclick=close;modal.querySelector('.pwa-secondary').onclick=close;
 modal.addEventListener('click',e=>{if(e.target===modal)close()});modal.querySelector('.pwa-dialog').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close()}});
 primary.onclick=install;refreshLabel();
}
function refreshLabel(){if(primary)primary.querySelector('.pwa-primary-label').textContent=explained?'Done':promptEvent?'Install Moviwatch':ios?'Show install steps':'How to install'}
function showGuide(){
 const [title,lines,note]=guide();steps.querySelector('.pwa-steps-title').textContent=title;
 const list=steps.querySelector('ol');list.replaceChildren();lines.forEach(line=>{const li=document.createElement('li');li.textContent=line;list.append(li)});
 steps.querySelector('.pwa-steps-note').textContent=note;steps.hidden=false;explained=true;
 primary.querySelector('.pwa-primary-label').textContent='Done';primary.querySelector('span[aria-hidden="true"]').textContent='✓';
}
async function install(){
 if(explained){hide(true);return}if(!promptEvent){showGuide();return}
 const p=promptEvent;promptEvent=null;refreshLabel();
 try{await p.prompt();const result=await p.userChoice;if(result&&result.outcome==='accepted'){save('installed');hide(false)}else hide(true)}catch{showGuide()}
}
function show(force=false){if(standalone()){save('installed');return}if(!force&&choice())return;build();modal.classList.add('is-visible');document.body.style.overflow='hidden';modal.querySelector('.pwa-close').focus({preventScroll:true});refreshLabel()}
function hide(dismiss){if(!modal)return;modal.classList.remove('is-visible');document.body.style.overflow='';if(dismiss)save('dismissed')}
function init(){
 if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(e=>console.warn('PWA worker:',e)),{once:true});
 const footer=document.querySelector('.footer');if(footer&&!footer.querySelector('[data-install]')){const b=document.createElement('button');b.className='pwa-footer-link';b.dataset.install='';b.textContent='＋ Install Moviwatch';b.onclick=()=>show(true);footer.append(document.createElement('br'),b)}
 if(standalone()){save('installed');return}if(!choice())setTimeout(()=>show(),2600)
}
addEventListener('beforeinstallprompt',e=>{e.preventDefault();promptEvent=e;if(!choice()&&!standalone())show();refreshLabel()});
addEventListener('appinstalled',()=>{save('installed');hide(false)});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
(() => {
  'use strict';
  const KEY='moviwatch-install-choice-v1', ua=navigator.userAgent||'';
  const ios=/iPhone|iPad|iPod/i.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const macSafari=/Macintosh/i.test(ua)&&/Safari/i.test(ua)&&!/Chrome|Chromium|Edg|Firefox|OPR/i.test(ua);
  const android=/Android/i.test(ua), edge=/Edg\//i.test(ua), chromium=/Chrome|Chromium/i.test(ua)||edge, firefox=/Firefox/i.test(ua);
  let promptEvent=null, modal=null, steps=null, primary=null, explained=false;
  const installed=()=>matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: minimal-ui)').matches||navigator.standalone===true;
  const choice=()=>{try{return localStorage.getItem(KEY)||''}catch{return ''}};
  const save=v=>{try{localStorage.setItem(KEY,v)}catch{}};
  function guide(){
    if(ios)return ['Add Moviwatch to your Home Screen',['Open this page in Safari.','Tap Share — the square with the upward arrow.','Choose “Add to Home Screen”, then tap “Add”.','If offered, enable “Open as Web App”.'],'iPhone and iPad require this confirmation in the Share menu; websites cannot trigger it automatically.'];
    if(macSafari)return ['Add Moviwatch to your Mac',['Open Moviwatch in Safari 17 or later.','Choose File → Add to Dock from the macOS menu bar.','Confirm Add. Moviwatch appears in your Dock and Applications.'],'Safari controls this step from its own menu.'];
    if(android)return ['Install Moviwatch on Android',['Open the ���q�^
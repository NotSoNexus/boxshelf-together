(function(){"use strict";const api=window.boxshelf,$=id=>document.getElementById(id),url=p=>p?'bsfile://local/'+encodeURIComponent(p):'';
let list=null,started=false,picking=false,confirmPref='auto',prefsRead=false,onlineRegistered=false;
let focusEl=null,gateClosable=false,padRaf=0,padIdx=-1,prevB={},dirHeld=null,dirAt=0,returnTarget='shelf',isGateClosing=false;
const knownPads=new Map(); // index → id: to say "connected" / "disconnected" even when Chromium doesn't fire the event
const fmt=ms=>{ms=+ms||0;const m=Math.round(ms/6e4);if(m<1)return "menos de 1 min";if(m<60)return m+" min";const h=Math.floor(m/60);return h>=100?Math.floor(h/24)+" d "+h%24+" h":h+" h"}; // under an hour says the minutes: "0 h" looked like nothing was ever saved
const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fitFor=(p,k)=>{const f=(p&&p.fit&&p.fit[k])||{};return {z:+f.z||1,x:+f.x||0,y:+f.y||0}};
const fitT=f=>`translate(${f.x}%,${f.y}%) scale(${f.z})`;
const avatar=p=>p.avatar?`<img src="${url(p.avatar)}" alt="" data-fit="avatar" style="transform:${fitT(fitFor(p,'avatar'))}">`:`${String(p.name||"?").slice(0,1).toUpperCase()}`;
const banner=p=>p.banner?`<img class="pg-banner-img" src="${url(p.banner)}" alt="" data-fit="banner" style="transform:${fitT(fitFor(p,'banner'))}">`:'';
const gateOn=()=>{const g=$("profileGate");return !!(g&&g.classList.contains("on"))};
const popOn=()=>{const p=$("profilePopover");return !!(p&&!p.hidden)};
const shown=el=>!!el&&el.offsetParent!==null;
async function syncOnlineReg(){try{const st=await api.onlineStatus();onlineRegistered=!!(st&&st.registered)}catch{onlineRegistered=false}return onlineRegistered}
function openOnlineFromGate(){closeGate();setTimeout(()=>{if(window.BS_ONLINE&&BS_ONLINE.open)BS_ONLINE.open({from:"profiles"})},260)}
async function get(){list=await api.profiles();return list}
// Settings → Controller → Confirm button (auto: the right button confirms on a Nintendo pad, the bottom one elsewhere).
// The gate is up before the shelf applies its settings, so it reads them here itself.
async function prefs(){if(prefsRead)return;prefsRead=true;try{const c=await api.getConfig();confirmPref=(c&&c.config&&c.config.ui&&c.config.ui.confirmButton)||'auto'}catch{}}
// Named like the shelf does it: maker and model from the id Chromium reports, and when Windows only says "XInput"
// (Steam Input, DS4Windows, BetterJoy wrap PlayStation / Switch pads that way), the real pad plugged in — so a
// DualSense or a Switch Pro is never announced as an Xbox controller.
const PAD_MODELS={"054c":{"05c4":"DualShock 4","09cc":"DualShock 4","0ba0":"DualShock 4 (wireless adapter)","0ce6":"DualSense","0df2":"DualSense Edge","0e5f":"Access controller","*":"PlayStation controller"},
  "057e":{"2009":"Switch Pro Controller","2069":"Switch 2 Pro Controller","2006":"Joy-Con (L)","2007":"Joy-Con (R)","200e":"Joy-Con pair","2066":"Joy-Con 2 (R)","2067":"Joy-Con 2 (L)","2017":"SNES controller","2073":"GameCube controller","0337":"GameCube adapter","*":"Nintendo Switch controller"},
  "045e":{"*":"Xbox controller"},"28de":{"1102":"Steam Controller","1142":"Steam Controller","1205":"Steam Deck","*":"Steam controller"},"2dc8":{"*":"8BitDo controller"}};
const PAD_STYLE={"054c":"ps","057e":"nintendo","045e":"xbox","28de":"xbox","2dc8":"xbox"};
let realPads=[],realAt=0;
async function readRealPads(force){if(!api.padsPresent)return;try{const l=await api.padsPresent(!!force);if(Array.isArray(l)&&JSON.stringify(l)!==JSON.stringify(realPads)){realPads=l;padStatus()}}catch{}}
function realPad(){const L=realPads;if(!L.length||L.some(x=>x.style==="xbox"))return null;const kinds=[...new Set(L.map(x=>x.style))];return kinds.length===1?L.find(x=>x.style===kinds[0]):null}
const modelName=(v,p)=>(PAD_MODELS[v]||{})[p]||(PAD_MODELS[v]||{})["*"]||"";
function padInfo(id){id=String(id||"");const m=/vendor:?\s*([0-9a-f]{4})[^0-9a-f]+product:?\s*([0-9a-f]{4})/i.exec(id),v=m&&m[1].toLowerCase(),p=m&&m[2].toLowerCase();
  const guess=/switch|nintendo|joy-?con|pro controller|pokken|gamecube/i.test(id)?"nintendo":/dualsense|dualshock|playstation|ps[345]\b|^wireless controller|sony/i.test(id)?"ps":"xbox";
  if(v&&PAD_MODELS[v])return {style:PAD_STYLE[v]||guess,name:modelName(v,p)||"Controller"}; // the id itself says which pad: DualSense, Switch Pro, Xbox…
  const r=!v||/xinput|virtual/i.test(id)?realPad():null; // wrapped as XInput: the real pad that's plugged in says which it is
  if(r)return {style:r.style,name:(modelName(r.vendor,r.product)||(r.style==="ps"?"PlayStation controller":r.style==="nintendo"?"Nintendo Switch controller":"Xbox controller"))+" (through Steam / DS4Windows)"};
  if(/dualsense|dualshock|playstation|ps[345]\b|sony|054c/i.test(id))return {style:"ps",name:"PlayStation controller"};
  if(/switch|nintendo|joy-?con|pro controller|pokken|gamecube|057e/i.test(id))return {style:"nintendo",name:"Nintendo Switch controller"};
  if(/xbox|xinput|045e/i.test(id))return {style:"xbox",name:/xbox 360/i.test(id)?"Xbox 360 controller":"Xbox controller"};
  if(/8bitdo/i.test(id))return {style:"xbox",name:"8BitDo controller"};
  if(/steam/i.test(id))return {style:"xbox",name:"Steam controller"};
  return {style:"xbox",name:"Controller"};
}
const padName=id=>padInfo(id).name;
const padStyle=id=>padInfo(id).style;
const confirmIdx=gp=>confirmPref==="b"?1:confirmPref==="a"?0:(padStyle(gp&&gp.id)==="nintendo"?1:0);
// the label on the button that confirms, as the pad in hand prints it
function okWord(gp){if(!gp)return "A";const ok=confirmIdx(gp),st=padStyle(gp.id);
  if(st==="ps")return ok?"◯":"✕";if(st==="nintendo")return ok?"A":"B";return ok?"B":"A"}

/* ---------- controller focus ---------- */
function targets(){
  if(gateOn()){const g=$("profileGate");
    if(ed&&ed.adjust)return []; // the picture panel moves the photo with the D-pad, so nothing is focused there
    if(osk)return Array.from(g.querySelectorAll(".pe-key")).filter(shown); // the on-screen keyboard owns the pad while it is up
    const panel=g.querySelector(".profile-editor");
    if(panel){const items=Array.from(panel.querySelectorAll(".pe-field,[data-save],[data-create],[data-cancel],[data-open-online]")).filter(shown);
      const cl=g.querySelector(".pg-close");if(cl&&shown(cl))items.push(cl);
      return items}
    return Array.from(g.querySelectorAll(".pg-card,.pg-add,.pg-close")).filter(shown)}
  if(popOn())return Array.from($("profilePopover").querySelectorAll(".pp-row:not(.current),.pp-manage")).filter(shown);
  return []}
function move(dir){if(osk)oskStep(dir);else step(dir)}
function paint(){const items=targets();
  const root=gateOn()?$("profileGate"):(popOn()?$("profilePopover"):null);
  if(root)root.querySelectorAll(".nav-focus").forEach(el=>el.classList.remove("nav-focus"));
  for(const el of items)el.classList.toggle("nav-focus",el===focusEl);if(focusEl&&!items.includes(focusEl))focusEl=null}
function focusFirst(){focusEl=targets()[0]||null;paint()}
function step(dir){
  const items=targets();if(!items.length)return;
  if(!focusEl||!items.includes(focusEl)){focusEl=items[0];paint();return}
  const r=focusEl.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
  let best=null,score=Infinity;
  for(const el of items){if(el===focusEl)continue;const q=el.getBoundingClientRect(),dx=(q.left+q.width/2)-cx,dy=(q.top+q.height/2)-cy;
    let a,b;
    if(dir==="left"){if(dx>=-4)continue;a=-dx;b=Math.abs(dy)}
    else if(dir==="right"){if(dx<=4)continue;a=dx;b=Math.abs(dy)}
    else if(dir==="up"){if(dy>=-4)continue;a=-dy;b=Math.abs(dx)}
    else{if(dy<=4)continue;a=dy;b=Math.abs(dx)}
    const sc=a+b*2;if(sc<score){score=sc;best=el}}
  // left / right at the ends goes round to the other side (one row of profiles, as on a console)
  if(!best&&(dir==="left"||dir==="right")){let ex=dir==="left"?-Infinity:Infinity;
    for(const el of items){if(el===focusEl)continue;const q=el.getBoundingClientRect(),x=q.left+q.width/2;if(dir==="left"?x>ex:x<ex){ex=x;best=el}}}
  if(best){focusEl=best;paint();try{focusEl.scrollIntoView({block:"nearest",inline:"nearest"})}catch{}}
}
function activate(){if(picking)return;if(!focusEl||!targets().includes(focusEl))focusFirst();const el=focusEl;if(!el)return;
  if(osk){if(el.dataset.k!=null)pressKey(el.dataset.k);return}
  if(el.dataset.field){activateField(el.dataset.field);return}
  if(el.hasAttribute("data-open-online")){openOnlineFromGate();return}
  if(el.hasAttribute("data-save")){saveProfile();return}
  if(el.hasAttribute("data-create")){createProfile();return}
  if(el.hasAttribute("data-cancel")){closeEditor();return}
  if(el.dataset.add!=null){add();return}
  if(el.dataset.close!=null){closeGate();return}
  if(el.dataset.manage!=null){manage();return}
  if(el.dataset.id){choose(el.dataset.id);return}}
// B / Escape / Select: the keyboard first, then the editor, then the gate (only when there is a way back to the shelf)
function back(){
  if(popOn()){$("profilePopover").hidden=true;return}
  if(osk){closeOsk();return}
  if(ed){closeEditor();return}
  if(gateOn()&&gateClosable)closeGate()}
/* Keyboard too (arrows + Enter): the same focus the pad moves. Typing keeps working in the editor. */
document.addEventListener("keydown",e=>{
  if(!gateOn()&&!popOn())return;
  const a=document.activeElement;const typing=!!(a&&/^(input|textarea|select)$/i.test(a.tagName));
  if(!typing&&e.key!=="Tab")e.stopPropagation(); // the shelf under the gate hears nothing (the editor keeps its typing)
  if(typing)return;
  const k=e.key;
  if(osk){
    if(k==="Escape"){e.preventDefault();closeOsk();return}
    if(k==="Enter"){e.preventDefault();pressKey("Listo");return}
    if(k==="Backspace"){e.preventDefault();pressKey("Borrar");return}
    if(k.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();pressKey(k);return} // a real keyboard types too
  }
  if(k==="ArrowLeft"||k==="ArrowRight"||k==="ArrowUp"||k==="ArrowDown"){
    if(ed&&ed.adjust){const p={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[k];e.preventDefault();panFit(p[0],p[1]);return}
    if(!targets().length)return;e.preventDefault();move(k.slice(5).toLowerCase());return}
  if(ed&&ed.adjust){
    if(k==="Enter"||k===" "||k==="Escape"){e.preventDefault();endAdjust();return}
    if(k==="+"||k==="="){e.preventDefault();zoomFit(1);return}
    if(k==="-"||k==="_"){e.preventDefault();zoomFit(-1);return}
  }
  if(k==="Escape"){e.preventDefault();back();return}
  if((k==="Enter"||k===" ")&&!a?.matches?.("button,a")){if(!focusEl)focusFirst();if(focusEl){e.preventDefault();activate()}}
},true);
document.addEventListener("keyup",e=>{if(!gateOn()&&!popOn())return;const a=document.activeElement;if(a&&/^(input|textarea|select)$/i.test(a.tagName))return;e.stopPropagation()},true);

/* ---------- controller read, and the "connected" note on this screen ---------- */
let gateToastT=0;
function gateToast(msg){if(!gateOn())return;let el=$("pgToast");
  if(!el){el=document.createElement("div");el.id="pgToast";el.className="pg-toast";el.setAttribute("role","status");document.body.appendChild(el)}
  el.textContent=msg;el.classList.add("on");clearTimeout(gateToastT);gateToastT=setTimeout(()=>el.classList.remove("on"),3600)}
function updatePopoverHint(){const pop=$("profilePopover");if(!pop||pop.hidden)return;const h=pop.querySelector(".pp-hint");if(!h)return;
  const txt=`D-pad para mover · ${okWord(currentPad())} para elegir`;if(h.textContent!==txt)h.textContent=txt}
function padStatus(){const gp=currentPad();
  const el=$("pgPad");if(el&&gateOn()){const txt=gp?`${padName(gp.id)} · D-pad para mover · ${okWord(gp)} para elegir`:"Conecta un mando para moverte con él";if(el.textContent!==txt)el.textContent=txt}
  const h=$("profileGate")&&$("profileGate").querySelector(".pe-hint");
  if(h){const txt=osk?`D-pad para mover · ${okWord(gp)} para escribir · B para cerrar el teclado`:`D-pad para mover · ${okWord(gp)} para elegir · B para volver`;if(h.textContent!==txt)h.textContent=txt}
  const ah=$("profileGate")&&$("profileGate").querySelector(".pe-adjust-hint");
  if(ah){const txt=gp?`D-pad o stick para moverla · LB/RB para el tamaño · ${okWord(gp)} para aplicar`:"Arrástrala dentro del marco · rueda del ratón o − ＋ para el tamaño · Enter para aplicar";if(ah.textContent!==txt)ah.textContent=txt}
  updatePopoverHint()}
function currentPad(){let L=null;try{L=navigator.getGamepads?navigator.getGamepads():null}catch{}if(!L)return null;
  for(let i=0;i<L.length;i++){const p=L[i];if(p&&p.connected&&!/057e[^0-9a-f]*(0306|0330)/i.test(p.id))return p}return null}
function seedPads(){knownPads.clear();try{for(const p of navigator.getGamepads()||[])if(p&&p.connected)knownPads.set(p.index,p.id)}catch{}}
function startPad(seed){if(seed)seedPads();padIdx=-1;prevB={};dirHeld=null;padStatus();readRealPads();if(!padRaf)padRaf=requestAnimationFrame(tick)}
function stopPad(){if(padRaf)cancelAnimationFrame(padRaf);padRaf=0;dirHeld=null;prevB={};padIdx=-1;
  const t=$("pgToast");if(t){t.classList.remove("on");t.remove()}clearTimeout(gateToastT)}
let lastPadScan=0;
function tick(now){
  padRaf=0;if(!gateOn()&&!popOn()){stopPad();return}
  const gp=currentPad();if(gp&&gp.index!==padIdx){padIdx=gp.index;prevB={};dirHeld=null}
  // pad list changes: the note the shelf itself shows only starts after the gate, so this screen says it here
  // (twice a second is plenty for a cable or a Bluetooth pair)
  if(now-lastPadScan>500){lastPadScan=now;
    if(now-realAt>4000){realAt=now;readRealPads()} // the real pad behind XInput can appear a moment after the virtual one
    const ids=new Map();try{for(const p of navigator.getGamepads()||[])if(p&&p.connected)ids.set(p.index,p.id)}catch{}
    for(const [i,id] of ids){if(knownPads.get(i)!==id){knownPads.set(i,id);readRealPads(true).then(()=>gateToast(`${padName(id)} connected`))}}
    for(const i of Array.from(knownPads.keys()))if(!ids.has(i)){const id=knownPads.get(i);knownPads.delete(i);gateToast(`${padName(id)} disconnected`)}
  }
  if(!picking&&gp&&ed&&ed.adjust){adjustPad(gp,now);padStatus();padRaf=requestAnimationFrame(tick);return} // moving the photo
  if(!picking&&gp){
    const b=gp.buttons||[],ax=gp.axes||[],pressed=i=>!!(b[i]&&b[i].pressed);
    const v=(pressed(13)||ax[1]>.7)?1:(pressed(12)||ax[1]<-.7)?-1:0;
    const h=(pressed(15)||ax[0]>.55)?1:(pressed(14)||ax[0]<-.55)?-1:0;
    const d=v<0?"up":v>0?"down":h<0?"left":h>0?"right":null;
    if(d){if(d!==dirHeld){dirHeld=d;dirAt=now+300;move(d)}else if(now>dirAt){dirAt=now+120;move(d)}}
    else dirHeld=null;
    const ok=confirmIdx(gp),cancel=ok?0:1;
    const edge=(i,fn)=>{const p=pressed(i);if(p&&!prevB[i])fn();prevB[i]=p};
    edge(ok,activate);edge(9,()=>{if(osk)pressKey("Listo");else activate()}); // A (or the pad's own confirm button), and Start
    edge(cancel,back);
    edge(8,back); // Select / View backs out too: the keyboard, then the editor, then the gate
  }else dirHeld=null;
  padStatus();padRaf=requestAnimationFrame(tick);
}
addEventListener("gamepadconnected",()=>{if(gateOn()||popOn())startPad()});
addEventListener("gamepaddisconnected",()=>{if(gateOn()||popOn())startPad()});
// (app.js's pollBody steps aside while the gate or its popover is up: both screens read the pad themselves)

/* ---------- profiles ---------- */
let ed=null,osk=null; // ed: the editor's own copy (edit or create); osk: the on-screen keyboard while it is up
const OSK_LOWER=[["1","2","3","4","5","6","7","8","9","0"],["q","w","e","r","t","y","u","i","o","p"],["a","s","d","f","g","h","j","k","l","'"],["z","x","c","v","b","n","m","-",".","?"]];
const OSK_UPPER=OSK_LOWER.map(r=>r.map(c=>c.toUpperCase()));
const OSK_SYM=[["!","@","#","$","%","^","&","*","(",")"],["\\","/",":",";","_","=","+","{","}","~"],["[","]",",","<",">","|","`","\"","'","\u00bf"],["\u00e1","\u00e9","\u00ed","\u00f3","\u00fa","\u00f1","\u00fc","\u00a1","\u00bf","?"]];
function card(p){return `<button class="pg-card" data-id="${p.id}"><span class="pg-banner">${banner(p)}</span><span class="pg-shade"></span><span class="pp-avatar pg-avatar">${avatar(p)}</span><span class="pg-name">${esc(p.name)}</span><span class="pg-desc">${esc(p.description||"Tu perfil local de Boxshelf")}</span><span class="pg-stats"><span><b>${p.favorites||0}</b>Favoritos</span><span><b>${fmt(p.totalMs)}</b>Tiempo jugado</span></span></button>`}
async function renderGate(edit,closable){
  const gate=$("profileGate");if(!list||!gate)return;
  gateClosable=!!closable;
  await syncOnlineReg();
  if(edit&&(!ed||ed.mode!=="edit")){const p=list.profiles.find(x=>x.id===list.active)||list.profiles[0];
    ed=p?{mode:"edit",id:p.id,name:p.name||"",desc:p.description||"",avatar:p.avatar||"",banner:p.banner||"",fit:{avatar:fitFor(p,"avatar"),banner:fitFor(p,"banner")},field:null,adjust:null}:null;osk=null}
  const head=`<div class="pg-kicker">Boxshelf</div><div class="pg-title">${ed?(ed.mode==="create"?"Nuevo perfil":"Tu perfil"):"¿Quién está jugando?"}</div>`;
  const body=ed?editorHtml():`<div class="pg-pad" id="pgPad"></div><div class="pg-list">${list.profiles.map(card).join('')}<button class="pg-add" data-add>＋<br>Crear perfil</button></div>`;
  gate.innerHTML=`<div class="pg-shell">${head}${body}${closable?'<button class="pg-close" data-close>Volver a la biblioteca</button>':''}</div>`;
  gate.classList.add('on');gate.setAttribute('aria-hidden','false');gate.classList.toggle('editing',!!ed);gate.classList.toggle('adjusting',!!(ed&&ed.adjust));
  gate.querySelectorAll('.pg-card').forEach(b=>b.onclick=()=>{if(b.dataset.id!=="preview")choose(b.dataset.id)});
  const addB=gate.querySelector('[data-add]');if(addB)addB.onclick=add;
  const cl=gate.querySelector('[data-close]');if(cl)cl.onclick=closeGate;
  const saveB=gate.querySelector('[data-save]');if(saveB)saveB.onclick=saveProfile;
  const crB=gate.querySelector('[data-create]');if(crB)crB.onclick=createProfile;
  const onlB=gate.querySelector('[data-open-online]');if(onlB)onlB.onclick=openOnlineFromGate;
  gate.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=closeEditor);
  gate.querySelectorAll('.pe-field').forEach(b=>b.onclick=()=>activateField(b.dataset.field));
  gate.querySelectorAll('.pe-key').forEach(b=>b.onclick=()=>{focusEl=b;paint();pressKey(b.dataset.k)});
  gate.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>pickImage(b.dataset.file));
  gate.querySelectorAll('[data-zoom]').forEach(b=>b.onclick=()=>zoomFit(b.dataset.zoom==="in"?1:-1));
  gate.querySelectorAll('[data-pan]').forEach(b=>b.onclick=()=>panDir(b.dataset.pan));
  const cen=gate.querySelector('[data-center]');if(cen)cen.onclick=()=>{const f=curFit();f.x=0;f.y=0;applyFit()};
  const doneB=gate.querySelector('[data-done]');if(doneB)doneB.onclick=endAdjust;
  measureStrip(gate);bindDrag(gate);sizeCrop(gate);
  bindFiles(gate);
  // focus goes where it was: the keyboard's first key, the field being typed into, or the first profile
  const want=osk?gate.querySelector(".pe-key"):(ed&&ed.field?gate.querySelector(`.pe-field[data-field="${ed.field}"]`):null);
  focusEl=want&&targets().includes(want)?want:null;if(!focusEl)focusFirst();else paint();
  startPad(true);
}
function closeGate(){
  const gate=$("profileGate");
  if(!gate||!gate.classList.contains('on')||isGateClosing)return;
  isGateClosing=true;
  stopPad();
  focusEl=null;
  ed=null;
  osk=null;
  try{if(window.play_)window.play_("back");else if(window.Sound&&Sound.play)Sound.play("back");}catch{}
  gate.classList.add('closing');
  setTimeout(()=>{
    isGateClosing=false;
    gate.classList.remove('on','editing','closing');
    gate.setAttribute('aria-hidden','true');
    const to=returnTarget;
    returnTarget="shelf";
    if(to==="settings"){
      if(window.Shelf&&Shelf.setMode)Shelf.setMode("browse");
      if(window.Setup&&Setup.open)Setup.open({page:"shelf"});
    }else{
      if(window.Shelf&&Shelf.setMode)Shelf.setMode("browse");
      if(window.Shelf&&Shelf.holdInput)Shelf.holdInput();
    }
  },220);
}
function closeEditor(){ed=null;osk=null;renderGate(false,gateClosable)}

/* ---------- the editor: name / description with an on-screen keyboard, picture and banner ---------- */
function fieldBtn(f,label,ph){return `<button class="pe-field" data-field="${f}"><span class="pe-lab">${label}</span><span class="pe-val" data-v="${f}">${esc(ed[f]||ph)}</span></button>`}
// The profile exactly as it will look on the shelf's list, so the picture, its zoom / pan and the banner are seen while
// they are being changed (not after saving).
function previewHtml(){
  const base=(list&&list.profiles.find(x=>x.id===ed.id))||{};
  const p={id:"preview",name:ed.name||"Tu nombre",description:ed.desc||"Tu perfil local de Boxshelf",avatar:ed.avatar,banner:ed.banner,fit:ed.fit,favorites:base.favorites||0,totalMs:base.totalMs||0};
  return `<div class="pe-preview" aria-hidden="true">${card(p)}</div>`}
function adjustHtml(){
  const k=ed.adjust,has=!!(k==="avatar"?ed.avatar:ed.banner);
  if(!has)return `<div class="pe-adjust"><div class="pe-adjust-row"><button class="pe-mini go" data-file="${k}">Elegir imagen</button></div><div class="pe-hint pe-adjust-hint"></div></div>`;
  // Discord-style framing: the picture is dragged inside the circle (the profile picture) or the strip (the banner)
  const src=k==="avatar"?ed.avatar:ed.banner;
  return `<div class="pe-adjust"><div class="pe-canvas ${k==="avatar"?"crop-circle":"crop-strip"}"><img class="pe-canvas-img" src="${url(src)}" alt="" data-fit="${k}" style="transform:${fitT(fitFor(ed,k))}" draggable="false"></div>
  <div class="pe-adjust-row">
    <button class="pe-mini" data-file="${k}">Cambiar imagen</button>
    <button class="pe-mini" data-zoom="out" aria-label="Más pequeña">−</button>
    <button class="pe-mini" data-zoom="in" aria-label="Más grande">＋</button>
    <button class="pe-mini" data-center>Centrar</button>
    <button class="pe-mini go" data-done>Aplicar</button></div>
    <div class="pe-hint pe-adjust-hint"></div></div>`}
function editorHtml(){
  if(!onlineRegistered){
    const lockBox=`<div class="pe-head" style="display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700"><span style="font-size:24px">🔒</span> Personalización bloqueada</div>
    <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:22px;margin:18px 0 22px;text-align:left">
      <div style="font-size:15.5px;font-weight:700;color:#fff;margin-bottom:8px">Cuenta de Boxshelf Online requerida</div>
      <p style="font-size:13px;line-height:1.55;color:rgba(215,230,255,.82);margin:0 0 14px">
        Para personalizar tu perfil (cambiar nombre, foto de perfil, banner y descripción) es obligatorio tener una cuenta iniciada en <b>Boxshelf Online</b>.
      </p>
      <div style="font-size:12px;color:rgba(180,205,255,.65);line-height:1.4">
        Crea tu cuenta gratis para desbloquear la personalización completa de tu perfil y sincronizarla en la nube.
      </div>
    </div>
    <div class="pe-actions" style="margin-top:0">
      <button class="go" data-open-online style="background:#5277ff;color:#fff;font-weight:700;padding:12px 20px;font-size:13.5px;border-radius:10px">Crear cuenta / Iniciar sesión</button>
      <button class="alt" data-cancel style="padding:12px 18px;font-size:13.5px;border-radius:10px">Volver</button>
    </div>`;
    return `<section class="profile-editor"><div class="pe-cols"><div class="pe-left">${previewHtml()}</div><div class="pe-side">${lockBox}</div></div></section>`;
  }
  const tail=`${osk?oskHtml():'<div class="pe-hint"></div>'}<div class="pe-actions">`;
  const inputs=ed.mode==="edit"?`<input id="peAvatarFile" type="file" accept="image/*" hidden><input id="peBannerFile" type="file" accept="image/*" hidden>`:'';
  const grid=ed.mode==="create"
    ?`<div class="pe-head">Elige un nombre</div><div class="pe-grid">${fieldBtn("name","Nombre","Escribe el nombre del perfil")}</div>`
    :`<div class="pe-head">Editar perfil</div><div class="pe-grid">
    ${fieldBtn("name","Nombre","Tu nombre")}${fieldBtn("desc","Descripción","Sin descripción")}
    <button class="pe-field" data-field="avatar"><span class="pe-lab">Foto de perfil</span><span class="pe-val" data-v="avatar">${ed.avatar?"Ajustar la foto":"Elegir una foto"}</span></button>
    <button class="pe-field" data-field="banner"><span class="pe-lab">Banner</span><span class="pe-val" data-v="banner">${ed.banner?"Ajustar el banner":"Elegir un banner"}</span></button>
  </div>`;
  const actions=(ed.mode==="create"
    ?`<button data-create>Crear perfil</button><button class="alt" data-cancel>Cancelar</button>`
    :`<button data-save>Guardar cambios</button><button class="alt" data-cancel>Volver</button>`)+`</div>`;
  // while a picture is being framed the crop canvas takes the preview card's place: it is the same view, bigger
  return `<section class="profile-editor"><div class="pe-cols"><div class="pe-left">${ed.adjust?adjustHtml():previewHtml()}</div><div class="pe-side">${grid}${tail}${actions}</div></div>${inputs}</section>`}
function bindFiles(gate){
  const a=gate.querySelector("#peAvatarFile"),b=gate.querySelector("#peBannerFile");
  // Discord-style: picking a picture opens its framing at once (the crop panel is what you see next)
  const pick=(input,k)=>{const p=input.files&&input.files[0]&&api.pathForFile?api.pathForFile(input.files[0]):null;if(!p)return;
    ed[k]=p;ed.adjust=k;
    (api.stageProfileImage?api.stageProfileImage(p).catch(()=>{}):Promise.resolve()).then(()=>{if(ed&&ed[k]===p)renderGate(false,gateClosable)})};
  if(a)a.onchange=()=>pick(a,"avatar");
  if(b)b.onchange=()=>pick(b,"banner")}
function paintField(f,text){const el=$("profileGate")&&$("profileGate").querySelector(`[data-v="${f}"]`);if(el)el.textContent=text}
function pickImage(k){const i=$(k==="avatar"?"peAvatarFile":"peBannerFile");if(i){try{i.value=""}catch{}i.click()}}
/* zoom 1–3 and pan in % of the picture; the pan is capped by the zoom so no empty edge can ever show */
function curFit(){if(!ed)return {z:1,x:0,y:0};if(!ed.fit)ed.fit={};const k=ed.adjust||"avatar";if(!ed.fit[k])ed.fit[k]={z:1,x:0,y:0};return ed.fit[k]}
function clampFit(f){f.z=Math.min(3,Math.max(1,Math.round(f.z*100)/100));const m=(f.z-1)*50;
  f.x=Math.min(m,Math.max(-m,Math.round(f.x*10)/10));f.y=Math.min(m,Math.max(-m,Math.round(f.y*10)/10));return f}
function applyFit(){if(!ed)return;const gate=$("profileGate");if(!gate)return;
  for(const k of ["avatar","banner"]){const t=fitT(fitFor(ed,k));gate.querySelectorAll(`[data-fit="${k}"]`).forEach(el=>{el.style.transform=t})}}
function panFit(h,v){panBy(h*4,v*4)}
function panBy(dx,dy){const f=curFit();if((dx||dy)&&f.z<=1)f.z=1.15;f.x+=dx;f.y+=dy;clampFit(f);applyFit()} // at zoom 1 the picture fills its frame exactly, so a nudge zooms a little: it can then slide
function panDir(d){panFit(d==="left"?-1:d==="right"?1:0,d==="up"?-1:d==="down"?1:0)}
function zoomFit(d){const f=curFit();f.z+=d*.1;clampFit(f);applyFit()}
// While a picture is being adjusted the D-pad / stick slides it and LB / RB (or the triggers) change its size; A ends.
function adjustPad(gp,now){
  const b=gp.buttons||[],ax=gp.axes||[],pressed=i=>!!(b[i]&&b[i].pressed);
  const edge=(i,fn)=>{const p=pressed(i);if(p&&!prevB[i])fn();prevB[i]=p};
  const v=(pressed(13)||ax[1]>.55)?1:(pressed(12)||ax[1]<-.55)?-1:0;
  const h=(pressed(15)||ax[0]>.45)?1:(pressed(14)||ax[0]<-.45)?-1:0;
  if(v||h){const sig=v+":"+h;if(sig!==dirHeld){dirHeld=sig;dirAt=now+280;panFit(h,v)}else if(now>dirAt){dirAt=now+70;panFit(h,v)}}
  else dirHeld=null;
  edge(4,()=>zoomFit(-1));edge(5,()=>zoomFit(1));edge(6,()=>zoomFit(-1));edge(7,()=>zoomFit(1));
  const ok=confirmIdx(gp);edge(ok,endAdjust);edge(ok?0:1,endAdjust);edge(9,endAdjust);
}
function endAdjust(){if(!ed)return;ed.adjust=null;renderGate(false,gateClosable)}
// Discord-style: dragging the picture inside the circle or the strip slides it; the wheel changes its size.
function bindDrag(gate){if(!ed||!ed.adjust)return;const el=gate.querySelector(`.pe-canvas [data-fit="${ed.adjust}"]`);if(!el)return;
  const box=el.parentElement;let px=0,py=0,drag=false;
  el.addEventListener("pointerdown",e=>{drag=true;px=e.clientX;py=e.clientY;try{el.setPointerCapture(e.pointerId)}catch{}});
  el.addEventListener("pointermove",e=>{if(!drag)return;const r=box.getBoundingClientRect(),w=r.width||1,h=r.height||1;
    if(Math.abs(e.clientX-px)<2&&Math.abs(e.clientY-py)<2)return;
    panBy((e.clientX-px)/w*100,(e.clientY-py)/h*100);px=e.clientX;py=e.clientY});
  const up=()=>drag=false;el.addEventListener("pointerup",up);el.addEventListener("pointercancel",up);
  box.addEventListener("wheel",e=>{e.preventDefault();zoomFit(e.deltaY<0?1:-1)},{passive:false})}
// the banner's crop strip copies the shape of the strip it will land in (the top 55% of the profile card); the card is
// not on screen while framing, so its shape is remembered from the last time it was shown
let stripAspect=2.1;
function measureStrip(gate){const s=gate.querySelector(".pe-preview .pg-banner");if(!s)return;
  const r=s.getBoundingClientRect();if(r.width>4&&r.height>4)stripAspect=r.width/r.height}
function sizeCrop(gate){const c=gate.querySelector(".pe-canvas.crop-strip");if(!c)return;c.style.aspectRatio=String(stripAspect)}
function activateField(f){if(!ed)return;
  if(f==="avatar"||f==="banner"){ed.adjust=f;osk=null;renderGate(false,gateClosable);return} // the picture opens its own zoom / pan panel
  openOsk(f)}
function openOsk(f){if(!ed)return;ed.field=f;osk={layer:0};renderGate(false,gateClosable)}
function closeOsk(){osk=null;renderGate(false,gateClosable)}
function putText(v){if(!ed||!ed.field)return;ed[ed.field]=v;paintField(ed.field,v||(ed.field==="desc"?"Sin descripción":""))}
function pressKey(k){if(!ed)return;
  if(k==="Listo"){closeOsk();return}
  if(k==="Borrar"){putText(String(ed[ed.field]||"").slice(0,-1));return}
  if(k==="Espacio"){putText((ed[ed.field]||"")+" ");return}
  if(k==="Mayús"){osk.layer=osk.layer===1?0:1;renderGate(false,gateClosable);return}
  if(k==="#+="){osk.layer=osk.layer===2?0:2;renderGate(false,gateClosable);return}
  putText((ed[ed.field]||"")+k);if(osk.layer===1){osk.layer=0;renderGate(false,gateClosable)}}
function oskBody(){const rows=(osk.layer===1?OSK_UPPER:osk.layer===2?OSK_SYM:OSK_LOWER).concat([["Mayús","#+=","Espacio","Borrar","Listo"]]);
  return rows.map((row,r)=>`<div class="pe-krow">${row.map((k,c)=>`<button class="pe-key ${k.length>1?"mid":""} ${k==="Listo"?"go":""}" data-k="${esc(k)}" data-r="${r}" data-c="${c}">${esc(k)}</button>`).join('')}</div>`).join('')}
function oskHtml(){return `<div class="pe-osk" role="group" aria-label="Teclado en pantalla">${oskBody()}</div>`}
function oskStep(dir){
  const gate=$("profileGate");if(!gate)return;const keys=Array.from(gate.querySelectorAll(".pe-key"));if(!keys.length)return;
  let i=keys.indexOf(focusEl);if(i<0)i=0;
  const rows={};for(const k of keys)(rows[+k.dataset.r]=rows[+k.dataset.r]||[]).push(k);
  const r=+keys[i].dataset.r,c=+keys[i].dataset.c;let nr=r,nc=c;
  if(dir==="left")nc=c-1<0?rows[r].length-1:c-1;
  else if(dir==="right")nc=c+1>=rows[r].length?0:c+1;
  else if(dir==="up"){nr=r-1;if(!rows[nr])return;nc=Math.min(nc,rows[nr].length-1)}
  else{nr=r+1;if(!rows[nr])return;nc=Math.min(nc,rows[nr].length-1)}
  focusEl=rows[nr][nc];paint();try{focusEl.scrollIntoView({block:"nearest"})}catch{}
}
async function saveProfile(){if(!ed||ed.mode!=="edit")return;
  await syncOnlineReg();
  if(!onlineRegistered){gateToast("Se requiere una cuenta de Boxshelf Online para personalizar el perfil");openOnlineFromGate();return}
  const name=String(ed.name||"").trim();if(!name){gateToast("Escribe un nombre para el perfil");return}
  try{await api.updateProfile(ed.id,{name,description:String(ed.desc||"").trim(),avatar:ed.avatar||"",banner:ed.banner||"",fit:ed.fit||{}});
    await get();ed=null;osk=null;renderGate(false,gateClosable);gateToast("Perfil guardado");
    try{await api.onlineSync()}catch{}}
  catch(e){gateToast(e&&e.message||"No se pudo guardar el perfil")}}
async function createProfile(){if(!ed||ed.mode!=="create")return;
  await syncOnlineReg();
  if(!onlineRegistered){gateToast("Se requiere una cuenta de Boxshelf Online para crear un perfil");openOnlineFromGate();return}
  const name=String(ed.name||"").trim();if(!name){gateToast("Escribe un nombre para el perfil");return}
  try{const p=await api.createProfile(name);await choose(p.id)}catch(e){gateToast(e&&e.message||"No se pudo crear el perfil")}}

// Choosing a profile: hide the cards, say what is happening, and only reload once main has really switched. The reload
// skips the gate (sessionStorage) and the shelf comes up on that profile's library; a second attempt covers a reload the
// page swallowed.
async function choose(id){
  if(picking)return;const gate=$("profileGate"),p=list&&list.profiles.find(x=>x.id===id);
  picking=true;gate&&gate.classList.add('picking');
  const note=$("pgPad");if(note)note.textContent=`Abriendo la biblioteca${p?" de "+p.name:""}…`;
  try{await api.selectProfile(id)}catch(e){picking=false;gate&&gate.classList.remove('picking');padStatus();
    gateToast(e&&e.message?e.message:"No se pudo cambiar el perfil");return}
  try{sessionStorage.setItem('boxshelf-profile-picked','1')}catch{}
  gateMark(); // chosen once: Boxshelf won't ask again on its next starts (the profile button / Settings still open this screen)
  try{if(api.reload)await api.reload();else location.reload()}catch{try{location.reload()}catch{}}
  // if the reload never lands, put the screen back so a second try is possible
  setTimeout(()=>{if(!picking)return;picking=false;try{sessionStorage.removeItem('boxshelf-profile-picked')}catch{}gate&&gate.classList.remove('picking');padStatus();gateToast("No se pudo abrir la biblioteca. Prueba otra vez.")},4000);
}
async function add(){
  await syncOnlineReg();
  if(!onlineRegistered){
    gateToast("Crea una cuenta en Boxshelf Online para personalizar o crear perfiles");
    openOnlineFromGate();
    return;
  }
  ed={mode:"create",name:"",desc:"",avatar:"",banner:"",field:"name"};osk={layer:0};renderGate(false,gateClosable)
}
async function manage(){returnTarget="shelf";const el=$("profilePopover");if(el)el.hidden=true;await syncOnlineReg();await get();ed=null;osk=null;renderGate(true,true)}

async function toggle(){const el=$("profilePopover");if(!el)return;if(!el.hidden){el.hidden=true;return}await prefs();await get();
  el.innerHTML=`<div class="pp-title">Cambiar perfil</div>${list.profiles.map(p=>`<button class="pp-row ${p.id===list.active?'current':''}" data-id="${p.id}"><span class="pp-avatar">${avatar(p)}</span><span><span class="pp-name">${esc(p.name)}</span><span class="pp-desc">${p.favorites||0} favoritos · ${fmt(p.totalMs)}</span></span>${p.id===list.active?'<span class="pp-current">En uso</span>':''}</button>`).join('')}<button class="pp-manage" data-manage>Gestionar perfiles</button><div class="pp-hint">D-pad para mover · ${okWord(currentPad())} para elegir</div>`;
  el.hidden=false;
  el.querySelectorAll('.pp-row:not(.current)').forEach(b=>b.onclick=()=>choose(b.dataset.id));
  el.querySelector('[data-manage]').onclick=manage;
  focusFirst();startPad(true);
}
async function showStartup(){
  if(started)return;started=true;
  // Seen once: a profile was already chosen (this run, or any earlier one), so Boxshelf goes straight to the shelf.
  // It is remembered in localStorage, which outlives the reload of a profile switch and the next starts.
  try{if(sessionStorage.getItem('boxshelf-profile-picked')||gateSeen())return}catch{}
  await new Promise(r=>setTimeout(r,1150));const splash=$("splash");if(splash){splash.classList.add('out');setTimeout(()=>{if(splash.parentNode)splash.remove()},700)}await prefs();await get();renderGate(false);return new Promise(()=>{})}
// "Who is playing?" is a one-time screen: once a profile has been chosen, it never opens by itself again (the profile
// button's menu and Settings → Player profiles still open it whenever you want).
const gateSeen=()=>{try{return localStorage.getItem('boxshelf-profile-gate')==='1'}catch{return false}};
const gateMark=()=>{try{localStorage.setItem('boxshelf-profile-gate','1')}catch{}};
window.BS_PROFILES={showStartup,toggle,openSettings:async(opts)=>{returnTarget=(opts&&opts.from)||"settings";await syncOnlineReg();await prefs();await get();renderGate(true,true)}};
document.addEventListener('click',e=>{const pop=$("profilePopover"),btn=$("profileBtn");if(pop&&!pop.hidden&&!pop.contains(e.target)&&!btn.contains(e.target))pop.hidden=true});
})();

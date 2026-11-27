import { EMBED_SKELETON } from "./booking-skeleton-html";

/** The /embed.js source (see src/app/embed.js/route.ts for the three ways to use it). */
export function embedScript(origin: string): string {
  return `(function(){
  if(window.BiktrixBooking)return;
  var ORIGIN=${JSON.stringify(origin)};
  var SK=${JSON.stringify(EMBED_SKELETON)};
  function clean(v){return (v||"").replace(/[^a-z0-9-]/gi,"");}
  function url(store,type,pre){
    var u=ORIGIN+"/book/"+clean(store)+(clean(type)?"/"+clean(type):"");
    var q=[];
    ["name","email","phone","country"].forEach(function(k){if(pre&&pre[k])q.push(k+"="+encodeURIComponent(pre[k]));});
    return q.length?u+"?"+q.join("&"):u;
  }
  function pre(el){return {name:el.getAttribute("data-name"),email:el.getAttribute("data-email"),phone:el.getAttribute("data-phone"),country:el.getAttribute("data-country")};}
  function frame(src){
    var f=document.createElement("iframe");
    f.src=src;f.title="Book an appointment";
    f.setAttribute("allow","clipboard-write");
    return f;
  }
  // A grey placeholder calendar that pulses until the booking page is ready, so the space never sits blank.
  var css=null;
  function skeleton(h){
    if(!css){css=document.createElement("style");css.textContent="@keyframes bkpulse{50%{opacity:.45}}";document.head.appendChild(css);}
    var bar=function(w,hh,mt){return '<div style="width:'+w+';height:'+hh+'px;margin-top:'+mt+'px;border-radius:6px;background:#e7e5e4"></div>';};
    var dots="";for(var i=0;i<28;i++)dots+='<span style="width:30px;height:30px;border-radius:50%;background:'+(i%7>0&&i%7<6&&i>8?"#fde4d3":"#f1f0ee")+';justify-self:center"></span>';
    var d=document.createElement("div");
    d.setAttribute("role","status");d.setAttribute("aria-label","Loading available times");
    d.style.cssText="box-sizing:border-box;height:"+h+";padding:16px;font-family:system-ui,-apple-system,sans-serif";
    d.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:24px;height:100%;box-sizing:border-box;border:1px solid #e7e5e4;border-radius:16px;background:#fff;padding:24px;animation:bkpulse 1.4s ease-in-out infinite">'
      +'<div style="flex:1 1 200px">'+bar("30%",12,0)+bar("50%",12,14)+bar("80%",26,18)+bar("40%",12,18)+bar("60%",12,12)+'</div>'
      +'<div style="flex:2 1 300px">'+bar("45%",18,0)+'<div style="display:grid;grid-template-columns:repeat(7,1fr);row-gap:14px;margin-top:28px">'+dots+'</div>'
      +'<p style="margin:24px 0 0;color:#78716c;font-size:14px">Loading available times…</p></div></div>';
    return d;
  }
  // Show the frame once the booking page has rendered (it posts its height) or finished loading, whichever is first.
  function reveal(f,ph){
    var done=false;
    function show(){if(done)return;done=true;if(ph&&ph.parentNode)ph.parentNode.removeChild(ph);f.style.position="";f.style.visibility="";f.style.top="";f.style.left="";}
    f.addEventListener("load",show);
    f._bkShow=show;
  }
  // Inline: the card-shaped outline holds the space (from the embed code itself, or added here for older embed
  // codes); the frame loads hidden at the outline's height and takes its place once the calendar is ready, so
  // the page around it doesn't move.
  function mount(el){
    if(el.getAttribute("data-biktrix-mounted"))return;
    var store=clean(el.getAttribute("data-biktrix-booking"));
    if(!store)return;
    var ph=el.querySelector(".bkx-sk");
    if(!ph){el.innerHTML=SK;ph=el.querySelector(".bkx-sk");}
    el.style.minHeight="";
    if(getComputedStyle(el).position==="static")el.style.position="relative";
    var h=ph.offsetHeight||620;
    var f=frame(url(store,el.getAttribute("data-type"),pre(el)));
    f.style.cssText="width:100%;border:0;outline:none !important;min-height:320px;height:"+h+"px;display:block;color-scheme:normal;position:absolute;top:0;left:0;visibility:hidden;transition:height .2s ease";
    el.setAttribute("data-biktrix-mounted","1");
    el.appendChild(f);
    reveal(f,ph);
  }
  var overlay=null,lastFocus=null;
  function close(){
    if(!overlay)return;
    overlay.parentNode.removeChild(overlay);overlay=null;
    document.documentElement.style.overflow="";
    if(lastFocus&&lastFocus.focus)lastFocus.focus();
  }
  function open(store,type,p){
    if(!clean(store))return;
    close();
    lastFocus=document.activeElement;
    overlay=document.createElement("div");
    overlay.setAttribute("role","dialog");overlay.setAttribute("aria-modal","true");overlay.setAttribute("aria-label","Book an appointment");
    overlay.style.cssText="position:fixed;inset:0;z-index:2147483646;background:rgba(23,24,26,.6);display:flex;align-items:center;justify-content:center;padding:16px";
    var box=document.createElement("div");
    box.style.cssText="position:relative;width:100%;max-width:1000px;height:min(760px,calc(100vh - 32px));background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.35)";
    var f=frame(url(store,type,p));
    f.style.cssText="width:100%;height:100%;border:0;outline:none !important;display:block;color-scheme:normal;position:absolute;top:0;visibility:hidden";
    var ph=skeleton("100%");
    var x=document.createElement("button");
    x.type="button";x.setAttribute("aria-label","Close");x.textContent="\\u00d7";
    x.style.cssText="position:absolute;top:8px;right:8px;z-index:1;width:40px;height:40px;border:0;border-radius:50%;background:#17181a;color:#fff;font:600 22px/1 system-ui,sans-serif;cursor:pointer";
    x.onclick=close;
    box.appendChild(x);box.appendChild(ph);box.appendChild(f);overlay.appendChild(box);
    reveal(f,ph);
    overlay.addEventListener("click",function(e){if(e.target===overlay)close();});
    document.body.appendChild(overlay);
    document.documentElement.style.overflow="hidden";
    x.focus();
  }
  function button(el){
    if(el.getAttribute("data-biktrix-mounted"))return;
    var store=clean(el.getAttribute("data-biktrix-popup-button"));
    if(!store)return;
    var b=document.createElement("button");
    b.type="button";b.textContent=el.getAttribute("data-text")||"Book an appointment";
    var bg=el.getAttribute("data-color")||"#ff6b1a",fg=el.getAttribute("data-text-color")||"#17181a";
    b.style.cssText="position:fixed;right:20px;bottom:20px;z-index:2147483645;min-height:48px;padding:0 22px;border:0;border-radius:999px;background:"+bg+";color:"+fg+";font:700 15px/1 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer";
    b.onclick=function(){open(store,el.getAttribute("data-type"),pre(el));};
    el.setAttribute("data-biktrix-mounted","1");
    el.appendChild(b);
  }
  function all(){
    var i,els=document.querySelectorAll("[data-biktrix-booking]");for(i=0;i<els.length;i++)mount(els[i]);
    els=document.querySelectorAll("[data-biktrix-popup-button]");for(i=0;i<els.length;i++)button(els[i]);
  }
  document.addEventListener("click",function(e){
    var el=e.target&&e.target.closest?e.target.closest("[data-biktrix-popup]"):null;
    if(!el)return;
    e.preventDefault();
    open(el.getAttribute("data-biktrix-popup"),el.getAttribute("data-type"),pre(el));
  });
  document.addEventListener("keydown",function(e){if(e.key==="Escape")close();});
  // The frame grows to fit its page, so the page scrolls, not the frame. When the booking moves on to a new step
  // (the form, the confirmation, an error) and the top of the frame is off screen, bring it back into view;
  // otherwise on a phone the customer is left looking at the bottom of a page that has changed above them.
  function scrollTo(f){
    var top=f.getBoundingClientRect().top,off=parseInt(f.parentNode.getAttribute("data-offset")||"80",10)||0;
    if(top<off){
      var y=top+(window.pageYOffset||document.documentElement.scrollTop)-off;
      try{window.scrollTo({top:y,behavior:"smooth"});}catch(_){window.scrollTo(0,y);}
    }
  }
  window.addEventListener("message",function(e){
    if(e.origin!==ORIGIN||!e.data)return;
    var t=e.data.type;
    if(t!=="biktrix-booking:height"&&t!=="biktrix-booking:step")return;
    var frames=document.querySelectorAll("[data-biktrix-booking] iframe, [role=dialog] iframe");
    for(var i=0;i<frames.length;i++){
      var f=frames[i];
      if(f.contentWindow!==e.source)continue;
      var inline=f.parentNode&&f.parentNode.hasAttribute("data-biktrix-booking");
      if(t==="biktrix-booking:step"){if(inline)scrollTo(f);continue;}
      if(f._bkShow)f._bkShow();
      if(inline)f.style.height=Math.max(320,Math.ceil(e.data.height))+"px";
    }
  });
  window.BiktrixBooking={open:open,close:close};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",all);else all();
})();`;
}

export type EmbedHow = "inline" | "button" | "link";
export const EMBED_HOWS: { key: EmbedHow; label: string; hint: string }[] = [
  { key: "inline", label: "Inline", hint: "The calendar sits in the page and grows to fit. Best on a booking or store page." },
  { key: "button", label: "Popup button", hint: "A floating button in the bottom-right corner opens the calendar over the page. Best on product pages." },
  { key: "link", label: "Popup link", hint: "Any text or button you choose opens the calendar over the page." },
];

/** What the inline snippet shows until embed.js takes over: the card's outline, at the card's size. */
export const INLINE_PLACEHOLDER = EMBED_SKELETON;

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The code to paste on the website for one booking type (or a store's whole list when `type` is null). */
export function embedSnippet(args: { root: string; store: string; type: string | null; how: EmbedHow; text: string; color: string; textColor: string }): string {
  const { root, store, type, how } = args;
  const typeAttr = type ? ` data-type="${attr(type)}"` : "";
  const script = `<script src="${root}/embed.js" async></script>`;
  // The placeholder inside the div shows the moment the page's HTML arrives, before embed.js has even loaded
  // (which on a phone, behind the theme's own scripts, can take a second); embed.js replaces it. The preconnect
  // starts the connection to Kickstand early so the calendar itself arrives sooner.
  if (how === "inline") {
    return `<link rel="preconnect" href="${root}">\n<div data-biktrix-booking="${attr(store)}"${typeAttr}>${INLINE_PLACEHOLDER}</div>\n${script}`;
  }
  if (how === "button") {
    return `<div data-biktrix-popup-button="${attr(store)}"${typeAttr} data-text="${attr(args.text)}" data-color="${attr(args.color)}" data-text-color="${attr(args.textColor)}"></div>\n${script}`;
  }
  const href = `${root}/book/${store}${type ? `/${type}` : ""}`;
  return `<a href="${attr(href)}" data-biktrix-popup="${attr(store)}"${typeAttr}>${attr(args.text)}</a>\n${script}`;
}

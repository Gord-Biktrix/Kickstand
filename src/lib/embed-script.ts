/** The /embed.js source (see src/app/embed.js/route.ts for the three ways to use it). */
export function embedScript(origin: string): string {
  return `(function(){
  if(window.BiktrixBooking)return;
  var ORIGIN=${JSON.stringify(origin)};
  function clean(v){return (v||"").replace(/[^a-z0-9-]/gi,"");}
  function url(store,type,pre){
    var u=ORIGIN+"/book/"+clean(store)+(clean(type)?"/"+clean(type):"");
    var q=[];
    ["name","email","phone"].forEach(function(k){if(pre&&pre[k])q.push(k+"="+encodeURIComponent(pre[k]));});
    return q.length?u+"?"+q.join("&"):u;
  }
  function pre(el){return {name:el.getAttribute("data-name"),email:el.getAttribute("data-email"),phone:el.getAttribute("data-phone")};}
  function frame(src){
    var f=document.createElement("iframe");
    f.src=src;f.title="Book an appointment";
    f.setAttribute("allow","clipboard-write");
    return f;
  }
  function mount(el){
    if(el.getAttribute("data-biktrix-mounted"))return;
    var store=clean(el.getAttribute("data-biktrix-booking"));
    if(!store)return;
    var f=frame(url(store,el.getAttribute("data-type"),pre(el)));
    f.loading="lazy";
    f.style.cssText="width:100%;border:0;min-height:480px;display:block;color-scheme:normal";
    el.setAttribute("data-biktrix-mounted","1");
    el.appendChild(f);
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
    f.style.cssText="width:100%;height:100%;border:0;display:block;color-scheme:normal";
    var x=document.createElement("button");
    x.type="button";x.setAttribute("aria-label","Close");x.textContent="\\u00d7";
    x.style.cssText="position:absolute;top:8px;right:8px;z-index:1;width:40px;height:40px;border:0;border-radius:50%;background:#17181a;color:#fff;font:600 22px/1 system-ui,sans-serif;cursor:pointer";
    x.onclick=close;
    box.appendChild(x);box.appendChild(f);overlay.appendChild(box);
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
  window.addEventListener("message",function(e){
    if(e.origin!==ORIGIN||!e.data||e.data.type!=="biktrix-booking:height")return;
    var frames=document.querySelectorAll("[data-biktrix-booking] iframe");
    for(var i=0;i<frames.length;i++){if(frames[i].contentWindow===e.source){frames[i].style.height=Math.max(320,Math.ceil(e.data.height))+"px";}}
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

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The code to paste on the website for one booking type (or a store's whole list when `type` is null). */
export function embedSnippet(args: { root: string; store: string; type: string | null; how: EmbedHow; text: string; color: string; textColor: string }): string {
  const { root, store, type, how } = args;
  const typeAttr = type ? ` data-type="${attr(type)}"` : "";
  const script = `<script src="${root}/embed.js" async></script>`;
  if (how === "inline") return `<div data-biktrix-booking="${attr(store)}"${typeAttr}></div>\n${script}`;
  if (how === "button") {
    return `<div data-biktrix-popup-button="${attr(store)}"${typeAttr} data-text="${attr(args.text)}" data-color="${attr(args.color)}" data-text-color="${attr(args.textColor)}"></div>\n${script}`;
  }
  const href = `${root}/book/${store}${type ? `/${type}` : ""}`;
  return `<a href="${attr(href)}" data-biktrix-popup="${attr(store)}"${typeAttr}>${attr(args.text)}</a>\n${script}`;
}

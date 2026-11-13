import { baseUrl } from "@/lib/messages";

/**
 * The website embed. On any page of an allowed site (see BOOKING_EMBED_ORIGINS in next.config.ts):
 *
 *   <div data-biktrix-booking="vancouver" data-type="test-ride"></div>
 *   <script src="https://<kickstand>/embed.js" async></script>
 *
 * Each div becomes an iframe of /book/<store>[/<type>] that grows to its content's height (the booking
 * pages post their height to the parent). data-type is optional: without it the store's list of types shows.
 */
export function GET() {
  const origin = baseUrl();
  const js = `(function(){
  var ORIGIN=${JSON.stringify(origin)};
  function mount(el){
    if(el.getAttribute("data-biktrix-mounted"))return;
    var store=(el.getAttribute("data-biktrix-booking")||"").replace(/[^a-z0-9-]/gi,"");
    if(!store)return;
    var type=(el.getAttribute("data-type")||"").replace(/[^a-z0-9-]/gi,"");
    var f=document.createElement("iframe");
    f.src=ORIGIN+"/book/"+store+(type?"/"+type:"");
    f.title="Book an appointment";
    f.loading="lazy";
    f.style.cssText="width:100%;border:0;min-height:480px;display:block;color-scheme:normal";
    f.setAttribute("allow","clipboard-write");
    el.setAttribute("data-biktrix-mounted","1");
    el.appendChild(f);
  }
  function all(){var els=document.querySelectorAll("[data-biktrix-booking]");for(var i=0;i<els.length;i++)mount(els[i]);}
  window.addEventListener("message",function(e){
    if(e.origin!==ORIGIN||!e.data||e.data.type!=="biktrix-booking:height")return;
    var frames=document.querySelectorAll("[data-biktrix-booking] iframe");
    for(var i=0;i<frames.length;i++){if(frames[i].contentWindow===e.source){frames[i].style.height=Math.max(320,Math.ceil(e.data.height))+"px";}}
  });
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",all);else all();
})();`;
  return new Response(js, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}

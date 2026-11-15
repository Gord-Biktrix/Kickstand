/**
 * The booking card's loading outline, as plain HTML + CSS so it can go anywhere: inside the website embed code
 * (shows before embed.js has even loaded), in embed.js, and as the booking page's own loading screen. It has the
 * same shape and height as the real card (three columns when the card is at least 896px wide, stacked below
 * that), so when the calendar arrives it lands in the same space and nothing on the page moves. Heights were
 * measured from the real page; if the card's layout changes, re-measure and update them here.
 */
const CSS = `.bkx-sk{container-type:inline-size;box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.bkx-sk.bkx-pad{padding:24px 16px;max-width:1024px;margin:0 auto}
.bkx-sk *{box-sizing:border-box}
.bkx-b{background:linear-gradient(90deg,#eeece9 25%,#f7f6f4 50%,#eeece9 75%);background-size:200% 100%;animation:bkx-sh 1.4s linear infinite;border-radius:6px}
.bkx-t{background:linear-gradient(90deg,#fde7d8 25%,#fef3ec 50%,#fde7d8 75%);background-size:200% 100%;animation:bkx-sh 1.4s linear infinite}
@keyframes bkx-sh{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.bkx-b,.bkx-t{animation:none}}
.bkx-card{margin-top:7px;border:1px solid #e7e5e4;border-radius:16px;background:#fff;display:grid;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.bkx-info{height:270px;padding:24px;border-bottom:1px solid #e7e5e4}
.bkx-cal{height:440px;padding:24px;border-bottom:1px solid #e7e5e4;overflow:hidden}
.bkx-times{height:505px;padding:24px;overflow:hidden}
@container (min-width:928px){.bkx-card{grid-template-columns:minmax(240px,300px) minmax(0,1fr) 220px;height:506px}.bkx-info,.bkx-cal,.bkx-times{height:auto;border-bottom:0}.bkx-info,.bkx-cal{border-right:1px solid #e7e5e4}}
.bkx-grid{display:grid;grid-template-columns:repeat(7,1fr);row-gap:12px;max-width:384px;margin:22px auto 0}
.bkx-dot{width:36px;height:36px;border-radius:50%;justify-self:center}
.bkx-slot{height:44px;border-radius:8px;margin-top:10px}
.bkx-msg{margin:18px 0 0;font-size:13px;color:#78716c}`;

const bar = (w: string, h: number, mt = 0, extra = "") => `<div class="bkx-b" style="width:${w};height:${h}px;margin-top:${mt}px${extra}"></div>`;

function body(): string {
  let dots = "";
  for (let i = 0; i < 35; i++) dots += `<span class="bkx-dot ${i % 7 > 0 && i % 7 < 6 && i > 13 && i < 33 ? "bkx-t" : "bkx-b"}"></span>`;
  let slots = "";
  for (let i = 0; i < 8; i++) slots += `<div class="bkx-b bkx-slot"></div>`;
  return (
    bar("150px", 17) +
    `<div class="bkx-card">` +
    `<div class="bkx-info">${bar("70px", 12)}${bar("110px", 12, 14)}${bar("80%", 26, 16)}${bar("90px", 12, 18)}${bar("100px", 12, 12)}</div>` +
    `<div class="bkx-cal">${bar("170px", 18)}${bar("140px", 16, 26, ";margin-left:auto;margin-right:auto")}<div class="bkx-grid">${dots}</div><p class="bkx-msg">Loading available times…</p></div>` +
    `<div class="bkx-times">${bar("140px", 16)}${slots}</div>` +
    `</div>`
  );
}

/** For the website: with the page padding the booking frame has around the card. */
export const EMBED_SKELETON = `<div class="bkx-sk bkx-pad" role="status" aria-label="Loading available times"><style>${CSS}</style>${body()}</div>`;

/** For the booking page's own loading screen (the page already has its padding). */
export const PAGE_SKELETON = `<div class="bkx-sk" role="status" aria-label="Loading available times"><style>${CSS}</style>${body()}</div>`;

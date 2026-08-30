import { EDITORIAL_SHOWCASE_PROFILE_V1 } from '../../../../packages/api-contract/report-editorial-showcase.ts';

export const EDITORIAL_SHOWCASE_PROFILE_ID = EDITORIAL_SHOWCASE_PROFILE_V1;

/**
 * Portable design profile extracted from the approved editorial reference.
 * Runtime code intentionally contains no reference to a generated example file.
 */
export const EDITORIAL_SHOWCASE_PROFILE_CSS = String.raw`
:root{
  color-scheme:light;
  --paper:oklch(95.5% .014 82);
  --paper-deep:oklch(92.8% .019 78);
  --surface:oklch(98.8% .006 78);
  --ink:oklch(20.5% .013 54);
  --ink-soft:oklch(31% .014 54);
  --muted:oklch(49% .018 55);
  --line:oklch(85.5% .018 76);
  --red:oklch(55% .22 28);
  --red-deep:oklch(40% .16 28);
  --red-soft:oklch(94.5% .034 28);
  --amber:oklch(55% .13 65);
  --amber-deep:oklch(39% .09 62);
  --amber-soft:oklch(95% .052 82);
  --green:oklch(45% .105 162);
  --green-deep:oklch(34% .075 162);
  --green-soft:oklch(94.5% .033 157);
  --blue:oklch(43% .09 242);
  --blue-soft:oklch(94% .028 238);
  --body:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;
  --display:"Songti SC","STSong","Noto Serif CJK SC","Source Han Serif SC",serif;
  --mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html{background:var(--paper);scroll-behavior:smooth}
body{margin:0;color:var(--ink);background:var(--paper);font-family:var(--body);font-size:15px;line-height:1.76;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
a{color:inherit}p,li,td{overflow-wrap:anywhere}h1,h2,h3,p{margin-top:0}h1,h2{font-family:var(--display)}
.skip-link{position:absolute;left:8px;top:-60px;padding:9px 13px;color:white;background:var(--ink);z-index:20}.skip-link:focus{top:8px}
.shell{width:min(1480px,100%);margin:0 auto;padding:28px 32px 90px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:32px}
.toc{position:sticky;top:24px;align-self:start;height:calc(100vh - 48px);display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:9px;font-weight:900}.brand-dot{width:10px;height:10px;border-radius:50%;background:var(--red)}
.brand small{display:block;margin-left:19px;color:var(--muted);font:700 10px/1.4 var(--mono);letter-spacing:.11em;text-transform:uppercase}
.toc ol{list-style:none;margin:30px 0 0;padding:0}.toc a{display:grid;grid-template-columns:28px 1fr;min-height:38px;align-items:center;color:var(--muted);text-decoration:none;border-top:1px solid transparent;font-size:12px}.toc a:hover,.toc a:focus-visible{color:var(--ink);border-top-color:var(--red)}.toc .index{color:var(--red);font:800 9px/1 var(--mono)}
.toc-note{color:var(--muted);font-size:10px}.report{min-width:0;background:var(--surface);box-shadow:0 20px 60px rgba(46,36,28,.09)}
.cover{min-height:720px;padding:58px;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr);gap:48px;align-items:center;color:oklch(96.5% .009 72);background:var(--ink)}
.cover-kicker{color:oklch(77% .14 29);font:850 11px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase}.cover h1{margin:16px 0 24px;font-size:clamp(48px,6vw,80px);line-height:1.08}.cover-deck{max-width:680px;color:oklch(82% .013 72);font-size:18px}.cover-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}.cover-chip{padding:5px 9px;border:1px solid rgba(255,255,255,.2);border-radius:999px;color:oklch(88% .012 72);font:700 11px/1.4 var(--mono)}
.cover-panel{padding:27px;border:1px solid rgba(255,255,255,.19);background:rgba(255,255,255,.035)}.cover-panel h2{font-size:30px;line-height:1.35}.cover-panel p{color:oklch(82% .012 72);font-size:12px}.cover-panel .status{margin-top:12px}
.chapter{padding:62px 58px 70px;border-bottom:1px solid var(--line);scroll-margin-top:18px}.chapter-head{display:grid;grid-template-columns:88px minmax(0,1fr);gap:18px;margin-bottom:34px}.chapter-index{padding-top:6px;color:var(--red);font:850 10px/1.4 var(--mono);letter-spacing:.1em}.chapter h2{margin-bottom:8px;font-size:clamp(29px,3.2vw,42px);line-height:1.25}.chapter-lead{max-width:850px;color:var(--muted);font-size:13px}
.component-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}.showcase-component{min-width:0;grid-column:span 12}.span-wide{grid-column:span 8}.span-half{grid-column:span 6}.span-third{grid-column:span 4}.emphasis-primary{padding:25px;background:var(--paper)}.emphasis-secondary{padding:20px;border-top:1px solid var(--line)}
.component-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px}.component-head h3{margin:0;font-family:var(--display);font-size:23px}.component-provenance{margin-top:15px;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font:10px/1.6 var(--mono);overflow-wrap:anywhere}
.status{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:850;white-space:nowrap}.status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.status-supported{color:var(--green-deep);background:var(--green-soft)}.status-provisional{color:var(--amber-deep);background:var(--amber-soft)}.status-unanswered{color:var(--red-deep);background:var(--red-soft)}.status-method{color:var(--blue);background:var(--blue-soft)}
.showcase-editorial-hero blockquote{margin:0;font-family:var(--display);font-size:clamp(28px,3.4vw,46px);line-height:1.42}.showcase-editorial-hero .hero-context{margin-top:18px;color:var(--muted)}
.showcase-evidence-boundary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.boundary-column{min-height:190px;padding:20px}.boundary-column h4{margin:0 0 9px;font-family:var(--display);font-size:20px}.boundary-supported{color:var(--green-deep);background:var(--green-soft)}.boundary-provisional{color:var(--amber-deep);background:var(--amber-soft)}.boundary-unanswered{color:var(--red-deep);background:var(--red-soft)}
.showcase-profile-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}.profile-card{grid-column:span 6;min-height:180px;padding:20px;border-top:4px solid var(--amber);background:var(--surface)}.profile-card:nth-child(4n+1){grid-column:span 7;border-top-color:var(--green)}.profile-card:nth-child(4n+2){grid-column:span 5}.profile-card:nth-child(4n+3){grid-column:span 5;border-top-color:var(--blue)}.profile-card:nth-child(4n){grid-column:span 7;border-top-color:var(--red)}.variant-columns .profile-card:nth-child(n){grid-column:span 4}.variant-list .profile-card:nth-child(n){grid-column:span 12;min-height:auto}.profile-card h4{margin:0 0 8px;font-family:var(--display);font-size:20px}.profile-card p{color:var(--muted);font-size:12px}.profile-relations{margin:12px 0 0;padding:13px 18px 13px 34px;background:var(--paper);color:var(--muted);font-size:11px}
.table-wrap{overflow-x:auto}.showcase-table{width:100%;border-collapse:collapse;font-size:12px}.showcase-table caption{padding-bottom:9px;color:var(--muted);text-align:left}.showcase-table th,.showcase-table td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.showcase-table thead th{color:var(--surface);background:var(--ink)}.showcase-table tbody th{color:var(--red-deep)}
.showcase-stage-flow{display:flex;gap:7px;align-items:stretch;overflow-x:auto}.stage-card{position:relative;flex:1 0 140px;min-height:155px;padding:18px 14px;border-top:4px solid var(--amber);background:var(--paper)}.stage-card:not(:last-child)::after{content:"→";position:absolute;right:-8px;top:61px;z-index:2;color:var(--red);font-weight:900}.stage-card h4{margin:10px 0 7px;font-size:14px}.stage-card p{color:var(--muted);font-size:11px}
.showcase-tension-map{display:grid;grid-template-columns:1fr 220px 1fr;gap:16px;align-items:center}.tension-side{display:grid;gap:8px}.tension-item{padding:14px;background:var(--paper);font-size:12px}.tension-core{aspect-ratio:1;border-radius:50%;display:grid;place-content:center;padding:20px;color:white;background:var(--ink);text-align:center;font-family:var(--display);font-size:22px}
.showcase-principle-list{border-top:1px solid var(--ink)}.principle-row{display:grid;grid-template-columns:55px minmax(170px,.6fr) minmax(0,1fr);gap:15px;padding:18px 0;border-bottom:1px solid var(--line)}.principle-no{color:var(--red);font-family:var(--display);font-size:27px}.principle-row p{margin:0;color:var(--muted);font-size:12px}
.showcase-priority-lanes{display:grid;grid-template-columns:1.3fr 1fr .75fr;gap:12px}.priority-lane{border-top:5px solid var(--red);background:var(--paper)}.priority-lane:nth-child(2){border-top-color:var(--amber)}.priority-lane:nth-child(3){border-top-color:var(--blue)}.priority-lane h4{padding:18px;margin:0;font-family:var(--display);font-size:30px}.priority-action{padding:15px 18px;border-top:1px solid var(--line);font-size:12px}
.showcase-confidence-bars{display:grid;gap:11px}.confidence-row{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(160px,1fr) 45px;gap:12px;align-items:center;font-size:12px}.confidence-track{height:7px;border-radius:999px;background:var(--paper-deep);overflow:hidden}.confidence-fill{height:100%;background:var(--amber)}.confidence-value{text-align:right;font:10px/1 var(--mono)}
.showcase-validation-list,.showcase-narrative-list{display:grid;gap:0;border-top:1px solid var(--ink)}.list-row{display:grid;grid-template-columns:minmax(160px,.4fr) minmax(0,1fr);gap:18px;padding:17px 0;border-bottom:1px solid var(--line)}.list-row h4{margin:0;font-size:13px}.list-row p{margin:0;color:var(--muted);font-size:12px}.record-fields{margin:8px 0 0;display:grid;grid-template-columns:100px 1fr;gap:5px 10px;font-size:11px}.record-fields dt{color:var(--muted);font-weight:800}.record-fields dd{margin:0}
.appendix-disclosure{border-top:1px solid var(--line);padding-top:14px}.appendix-disclosure>summary{cursor:pointer;color:var(--blue);font-weight:800}.appendix-disclosure>summary:focus-visible{outline:3px solid var(--blue);outline-offset:3px}.appendix-disclosure>.component-grid{margin-top:20px}
.showcase-source-register{font-size:11px}.source-row{display:grid;grid-template-columns:75px 110px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.source-id{font-family:var(--mono);color:var(--red-deep)}
.report-footer{padding:32px 58px 44px;color:var(--muted);background:var(--paper-deep);font-size:10px}
@media print{
  @page{size:A4;margin:13mm}
  body{background:white;font-size:9.5pt}.shell{display:block;width:auto;padding:0}.toc{display:none}.report{box-shadow:none}.cover{min-height:245mm;padding:18mm 12mm;color:var(--ink);background:white;border:1px solid var(--line);break-after:page}.cover-deck,.cover-panel p{color:var(--muted)}.cover-panel{border-color:var(--line);background:var(--paper)}.cover-chip{color:var(--ink);border-color:var(--line)}.chapter{padding:10mm 7mm 12mm}.appendix-disclosure>summary{display:none!important}.appendix-disclosure>*{display:block!important}.showcase-component,.profile-card,.stage-card,.priority-lane,.list-row,tr{break-inside:avoid}.showcase-stage-flow{display:grid;grid-template-columns:repeat(3,1fr);overflow:visible}.stage-card:not(:last-child)::after{display:none}.report-footer{padding:8mm}
}
`;

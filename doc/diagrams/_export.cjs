#!/usr/bin/env node
// 逐图导出 SVG + 高清 PNG。连 localhost:9222 的 Chrome。
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(process.env.HOME, '.claude/skills/browser/node_modules/ws'));

const OUT = '/Users/heyunshen/work/PROJECT/jdc/ai-x/doc/diagrams';
const FILE = 'file://' + encodeURI('/Users/heyunshen/work/PROJECT/jdc/ai-x/doc/diagrams/_render.html');
const NAMES = {
  '01': '01_系统架构',
  '02': '02_四段协作流',
  '03': '03_渐进加载',
  '04': '04_数据模型',
  '05': '05_功能架构'
};
const SCALE = 2; // 2x 高清

function httpJSON(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: 9222, path: pathname, method }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject); req.end();
  });
}

async function main() {
  const targets = await httpJSON('/json');
  let page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const events = {};
  ws.on('message', m => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
    else if (msg.method && events[msg.method]) events[msg.method](msg.params);
  });
  await new Promise(r => ws.on('open', r));

  await send('Page.enable');
  await send('Runtime.enable');
  // 大视口,避免 mermaid 把图缩进窄容器
  await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 2000, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise(r => { events['Page.loadEventFired'] = r; });
  await send('Page.navigate', { url: FILE });
  await loaded;

  // 等 mermaid 渲染完
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__mmReady === true && document.querySelectorAll(".mermaid svg").length', returnByValue: true });
    if (r.result && r.result.value) break;
    await new Promise(r => setTimeout(r, 300));
  }

  for (const key of Object.keys(NAMES)) {
    const base = path.join(OUT, NAMES[key]);
    // 1) 导出 SVG(直接取 DOM 的 outerHTML,补 xmlns)
    const svgRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const svg = document.querySelector('#shot-${key} svg');
        if (!svg) return null;
        svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
        svg.setAttribute('xmlns:xlink','http://www.w3.org/1999/xlink');
        const bb = svg.getBBox ? null : null;
        return svg.outerHTML;
      })()`, returnByValue: true
    });
    if (svgRes.result && svgRes.result.value) {
      fs.writeFileSync(base + '.svg', '<?xml version="1.0" encoding="UTF-8"?>\n' + svgRes.result.value);
      console.log('SVG  ✓', NAMES[key] + '.svg');
    } else { console.log('SVG  ✗', key, '(no svg found)'); continue; }

    // 2) 高清 PNG:按 .shot 容器的精确矩形做 clip 截图
    const rectRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('#shot-${key}');
        const r = el.getBoundingClientRect();
        return JSON.stringify({x:r.x, y:r.y, width:r.width, height:r.height});
      })()`, returnByValue: true
    });
    const rect = JSON.parse(rectRes.result.value);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: SCALE },
      captureBeyondViewport: true
    });
    fs.writeFileSync(base + '.png', Buffer.from(shot.data, 'base64'));
    console.log('PNG  ✓', NAMES[key] + '.png', `(${Math.round(rect.width)}x${Math.round(rect.height)} @${SCALE}x)`);
  }
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });

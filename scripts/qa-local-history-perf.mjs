import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:4321';
const server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--config','vite.renderer.config.ts','--port','4321'],{cwd:root,windowsHide:true,stdio:'ignore'});let browser;
try {
  for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1200,height:850}});
  await page.route('**/__perf**',r=>r.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/src/local-control.qa.tsx");</script></body></html>'}));
  await page.goto(base+'/__perf?performance=1');await page.getByRole('heading',{name:'边界状态合成验收'}).waitFor();
  const started=Date.now();
  for(let i=0;i<30;i++){await page.getByRole('button',{name:'加载更早的本地记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.lcr-older')?.disabled)}
  const report={stage:process.argv[2]||'after',elapsedMs:Date.now()-started,...await page.evaluate(()=>({renderedRows:document.querySelectorAll('.lcr-message').length,domNodes:document.querySelectorAll('*').length,first:document.querySelector('.lcr-message')?.textContent,heapBytes:performance.memory?.usedJSHeapSize}))};
  if(report.stage==='after'){
    await page.evaluate(()=>window.localQa.delay(150));
    const anchor=await page.evaluate(()=>{const box=document.querySelector('.lcr-history');box.scrollTop=0;const row=box.querySelector('[data-event-seq]');return {seq:row.dataset.eventSeq,top:row.getBoundingClientRect().top}});
    await page.waitForFunction(seq=>Number(document.querySelector('[data-event-seq]').dataset.eventSeq)<Number(seq)&&!document.querySelector('.lcr-older')?.disabled,anchor.seq);
    const top=await page.locator(`[data-event-seq="${anchor.seq}"]`).evaluate(row=>row.getBoundingClientRect().top);
    report.anchorShiftPx=Math.abs(top-anchor.top);if(report.anchorShiftPx>2)throw new Error('Prepend moved the reading anchor');
  }
  const dir=path.join(root,'output/playwright/history-performance');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,report.stage+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();server.kill()}

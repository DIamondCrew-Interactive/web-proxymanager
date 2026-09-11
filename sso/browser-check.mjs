import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('.build/sso-frontend/dist');
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root))throw Error();let file;try{file=await readFile(path);}catch{file=await readFile(resolve(root,'index.html'));res.setHeader('Content-Type','text/html');}const mime={'.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.html':'text/html'};if(file&&!res.hasHeader('Content-Type'))res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(file);}catch{res.writeHead(404).end();}});
server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();let callbackCount=0,enabled=true;
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());let body={};if(url.pathname==='/api/'||url.pathname==='/api')body={status:'OK',setup:true,version:{major:2,minor:15,revision:1}};else if(url.pathname==='/api/sso/status')body={enabled};else if(url.pathname==='/api/sso/callback'){callbackCount++;assert.equal(route.request().postDataJSON().ticket,'t'.repeat(43));body={requires_2fa:true,challenge:'c'.repeat(43)};}else if(url.pathname==='/api/sso/2fa'){assert.equal(route.request().postDataJSON().code,'123456');return route.fulfill({status:401,json:{}});}await route.fulfill({json:body});});
 const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base);await page.getByRole('button',{name:'Continue with DiamondCrew Interactive'}).waitFor();await page.locator('input[name="password"]').waitFor();
 enabled=false;await page.reload();await page.locator('input[name="password"]').waitFor();assert.equal(await page.getByRole('button',{name:'Continue with DiamondCrew Interactive'}).count(),0);
 await page.goto(base+'/auth/sso/callback?ticket='+'t'.repeat(43)+'&state='+'s'.repeat(43));await page.getByLabel('NPM verification code').waitFor();assert.equal(callbackCount,1);assert.equal(new URL(page.url()).search,'');
 await page.getByLabel('NPM verification code').fill('123456');await page.getByRole('button',{name:'Verify',exact:true}).click();await page.getByRole('alert').waitFor();await page.getByRole('link',{name:'Use password sign-in'}).click();await page.locator('input[name="password"]').waitFor();
 console.log('PASS: SSO enabled/disabled login, password fallback, callback consumed once, URL scrub, 2FA form/error fallback (mock APIs).');
}finally{await browser.close();await new Promise(r=>server.close(r));}

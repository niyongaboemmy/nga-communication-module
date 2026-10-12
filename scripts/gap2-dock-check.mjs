import { chromium } from 'playwright'; import jwt from 'jsonwebtoken'; import pg from 'pg'; import { readFileSync } from 'node:fs'; import { randomBytes } from 'node:crypto'; import { purgeUsers } from './lib/purge.mjs';
const env = Object.fromEntries(readFileSync('apps/api/.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')]));
const pool=new pg.Pool({connectionString:env.DATABASE_URL}); const ids=[]; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const {rows:[r]}=await pool.query(`SELECT id FROM roles WHERE name='Staff'`); const perms=(await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id WHERE rp.role_id=$1`,[r.id])).rows.map(x=>x.key);
const mk=async n=>{const id='gapd-'+randomBytes(4).toString('hex');ids.push(id);await pool.query(`INSERT INTO users (id,mis_user_id,name,email,role,role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,[id,n,id+'@amashuri.com',r.id]);const user={id,misUserId:id,name:n,email:id+'@amashuri.com',role:'staff'};return {id,user,token:jwt.sign(user,env.JWT_SECRET)}};
const call=async(u,m,p,b)=>(await fetch('http://localhost:5190'+p,{method:m,headers:{authorization:'Bearer '+u.token,'content-type':'application/json'},body:b&&JSON.stringify(b)})).json();
const A=await mk('Dock A'),B=await mk('Dock B'); const b=await chromium.launch();
try{
 const dm=(await call(A,'POST','/api/chat/conversations/direct',{userId:B.id})).data.conversation.id;
 await call(A,'POST',`/api/chat/conversations/${dm}/messages`,{body:'first',nonce:randomBytes(6).toString('hex')});
 for (const vp of [{width:390,height:844},{width:1280,height:860}]) {
  const ctx=await b.newContext({viewport:vp}); await ctx.addInitScript(kv=>{for(const[k,v]of Object.entries(kv))localStorage.setItem(k,v);sessionStorage.setItem('nga.installDismissedThisSession','1')},{tupo_token:B.token,tupo_user:JSON.stringify(B.user),tupo_permissions:'[]',tupo_role_permissions:JSON.stringify({keys:perms,name:'Staff'}),'nga.appInstalled':'1'});
  await ctx.route('**/api/sso/verify-mis**',x=>x.fulfill({status:200,contentType:'application/json',body:'{"success":true}'}));
  const p=await ctx.newPage(); await p.goto('http://localhost:5194/app/feed'); await p.waitForLoadState('networkidle').catch(()=>{}); await sleep(2500);
  const lab=()=>p.evaluate(()=>[...document.querySelectorAll('button[aria-haspopup="dialog"]')].map(x=>x.getAttribute('aria-label')).join('|'));
  console.log(vp.width,'on load (1 pre-existing unread):',await lab());
  await call(A,'POST',`/api/chat/conversations/${dm}/messages`,{body:'live',nonce:randomBytes(6).toString('hex')}); await sleep(4000);
  console.log(vp.width,'after live message:',await lab());
  const rail=await p.evaluate(()=>[...document.querySelectorAll('a[href="/app/chat"]')].map(a=>a.innerText.replace(/\s+/g,' ')+'['+(a.querySelector('[aria-label*=unread]')?.textContent??'')+']').join(' | '));
  console.log(vp.width,'nav chat links:',rail);
  await p.screenshot({path:process.env.OUT+`/dock-${vp.width}.png`}); await ctx.close();
 }
} finally { await b.close(); await purgeUsers(pool,ids,{quiet:true}); await pool.end(); }

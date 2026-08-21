#!/usr/bin/env node
/**
 * The device check, in a browser.
 *
 * This screen is the last thing between someone and a lesson, so the checks
 * are about whether it answers the questions people actually arrive with:
 * will they hear me, will they see me, what is this called, how do I send it
 * to anyone, and how do I call the whole thing off.
 *
 *   npm run verify:meet:prejoin      (needs `npm run dev` running)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('apps/api/.env','utf8').split('\n')
  .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
  .map(l => [l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const pass=[],fail=[]; const check=(n,ok,d='')=>{(ok?pass:fail).push(n);console.log(`${ok?'✅':'❌'} ${n}${d?`  — ${d}`:''}`);};

const id = `pj-${randomBytes(4).toString('hex')}`;
const { rows } = await pool.query(`SELECT id FROM roles WHERE name='Staff'`);
await pool.query(`INSERT INTO users (id,mis_user_id,name,email,role,role_id) VALUES ($1,$1,'Aline Uwase',$2,'staff',$3)`,
  [id, `${id}@amashuri.com`, rows[0]?.id ?? null]);
const perms=(await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id WHERE rp.role_id=$1`,[rows[0].id])).rows.map(r=>r.key);
const user={id,misUserId:id,name:'Aline Uwase',email:`${id}@amashuri.com`,role:'staff'};
const token=jwt.sign(user,env.JWT_SECRET,{expiresIn:'20m'});
const seed={tupo_token:token,tupo_user:JSON.stringify(user),tupo_permissions:JSON.stringify([]),
  tupo_role_permissions:JSON.stringify({keys:perms,name:'Staff'})};
const api=(p,init={})=>fetch(`http://localhost:5190${p}`,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(init.headers||{})}}).then(r=>r.json());
const m=(await api('/api/meet',{method:'POST',body:JSON.stringify({title:'Device check meeting',
  scheduledStart:new Date(Date.now()+3600e3).toISOString()})})).data;

const browser = await chromium.launch({ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport:{width:1280,height:900}, deviceScaleFactor:2, permissions:['camera','microphone'] });
await ctx.addInitScript(kv=>{for(const [k,v] of Object.entries(kv)) localStorage.setItem(k,v);}, seed);
const page = await ctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
await page.goto(`http://localhost:5194/app/meet/${m.id}`,{waitUntil:'networkidle'});
await page.locator('video').first().waitFor({state:'visible',timeout:20000});
await page.waitForTimeout(1000);
await page.screenshot({path:'.meet-ui-shots/prejoin-host.png'});

check('the mic test is offered', await page.getByRole('button',{name:/Test mic/i}).isVisible());
check('the speaker test is offered', await page.getByRole('button',{name:/Test sound/i}).isVisible());
check('the host can share from here', await page.getByRole('button',{name:'Share',exact:true}).isVisible());
check('the host can cancel the meeting', await page.getByRole('button',{name:/Cancel meeting/i}).isVisible());

// Rename
await page.getByRole('button',{name:/Rename this meeting/i}).click({force:true});
await page.waitForTimeout(300);
const nameField = page.getByLabel('Meeting name');
check('the name can be edited here', await nameField.isVisible());
await nameField.fill('Renamed before joining');
await page.getByRole('button',{name:'Save the name'}).click();
await page.waitForTimeout(900);
check('renaming sticks', (await page.locator('h1').first().textContent())?.includes('Renamed before joining'),
  await page.locator('h1').first().textContent());

// Share panel
await page.getByRole('button',{name:'Share',exact:true}).click();
await page.waitForTimeout(400);
await page.screenshot({path:'.meet-ui-shots/prejoin-share.png'});
check('the share panel opens', await page.getByRole('dialog',{name:/Share this meeting/i}).isVisible());
check('it offers the link and the code',
  (await page.getByRole('button',{name:'Copy link'}).isVisible()) &&
  (await page.getByRole('button',{name:'Copy code'}).isVisible()));
check('it says what the link actually grants',
  await page.getByText(/can join|ask to join|will not let anyone else in/i).first().isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('escape closes it', !(await page.getByRole('dialog').isVisible().catch(()=>false)));

// Mic test runs
await page.getByRole('button',{name:/Test mic/i}).click();
await page.waitForTimeout(1200);
const recording = await page.getByRole('button',{name:/Recording/i}).isVisible().catch(()=>false);
check('the mic test records', recording);
await page.waitForTimeout(5000);
const backToIdle = await page.getByRole('button',{name:/Test mic|Playing…/i}).isVisible();
check('and returns to a usable state', backToIdle);

// Cancel confirmation
await page.getByRole('button',{name:/Cancel meeting/i}).click();
await page.waitForTimeout(400);
await page.screenshot({path:'.meet-ui-shots/prejoin-cancel.png'});
check('cancelling asks first', await page.getByRole('dialog',{name:/Cancel this meeting/i}).isVisible());
await page.getByRole('button',{name:'Keep it'}).click();
await page.waitForTimeout(400);
check('and can be backed out of', !(await page.getByRole('dialog').isVisible().catch(()=>false)));

check('no page errors', errors.length===0, errors.slice(0,2).join(' | '));
await browser.close();
await pool.query(`DELETE FROM meetings WHERE host_id=$1`,[id]);
await pool.query(`DELETE FROM users WHERE id=$1`,[id]);
await pool.end();
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length?1:0);

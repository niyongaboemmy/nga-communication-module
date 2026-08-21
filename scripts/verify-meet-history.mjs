#!/usr/bin/env node
/**
 * Meeting history, the scheduler, and the share panel — against the running stack.
 *
 * The history view is mostly a query, and the parts of a query worth pinning
 * are the ones that fail quietly: a date window that drops half the rows
 * because it filtered on the wrong column, a search that matches nothing, a
 * page that returns the same rows as the last one, and an unparseable date
 * reaching the database instead of being ignored.
 *
 *   npm run verify:meet:history      (needs `npm run dev` running)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { purgeUsers } from './lib/purge.mjs';
const env = Object.fromEntries(readFileSync('apps/api/.env','utf8').split('\n')
  .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
  .map(l => [l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const pass=[],fail=[]; const check=(n,ok,d='')=>{(ok?pass:fail).push(`${ok?'✅':'❌'} ${n}${d?`  — ${d}`:''}`);console.log(`${ok?'✅':'❌'} ${n}${d?`  — ${d}`:''}`);};

const id = `v3-${randomBytes(4).toString('hex')}`;
const { rows } = await pool.query(`SELECT id FROM roles WHERE name='Staff'`);
await pool.query(`INSERT INTO users (id,mis_user_id,name,email,role,role_id) VALUES ($1,$1,'Aline Uwase',$2,'staff',$3)`,
  [id, `${id}@amashuri.com`, rows[0]?.id ?? null]);
const perms=(await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id WHERE rp.role_id=$1`,[rows[0].id])).rows.map(r=>r.key);
const user={id,misUserId:id,name:'Aline Uwase',email:`${id}@amashuri.com`,role:'staff'};
const token=jwt.sign(user,env.JWT_SECRET,{expiresIn:'25m'});
const seed={tupo_token:token,tupo_user:JSON.stringify(user),tupo_permissions:JSON.stringify([]),
  tupo_role_permissions:JSON.stringify({keys:perms,name:'Staff'})};
const api=(p,init={})=>fetch(`http://localhost:5190${p}`,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(init.headers||{})}}).then(r=>r.json());

/*
 * try/finally, because there was none: any check that threw left the test
 * account in the users table. Three of these leaked to *production* and showed
 * up in the people picker as duplicate "Aline Uwase" rows.
 */
// Declared out here so the `finally` below can still close it.
let browser;
try {

// History fixtures: meetings spread across months, then ended.
const ago=(days,h)=>{const d=new Date();d.setDate(d.getDate()-days);d.setHours(h,0,0,0);return d;};
for (const [d,t] of [[2,'Governors meeting'],[9,'Parents evening'],[40,'Budget review'],[100,'Induction day'],[200,'Old assembly']]) {
  const m=(await api('/api/meet',{method:'POST',body:JSON.stringify({title:t,scheduledStart:ago(d,10).toISOString(),scheduledEnd:ago(d,11).toISOString()})})).data;
  await pool.query(`UPDATE meetings SET status='ended', started_at=$2, ended_at=$3 WHERE id=$1`,
    [m.id, ago(d,10), ago(d,11)]);
}

// --- API: date range + search ---
const all = await api('/api/meet?scope=past&limit=50');
check('history returns past meetings', (all.data??[]).length >= 5, `${(all.data??[]).length} rows`);
const from30 = new Date(); from30.setDate(from30.getDate()-30);
const recent = await api(`/api/meet?scope=past&from=${from30.toISOString()}&limit=50`);
const titles=(recent.data??[]).map(m=>m.title);
check('a date range narrows the window',
  titles.includes('Governors meeting') && !titles.includes('Budget review'),
  titles.join(', '));
const searched = await api('/api/meet?scope=past&q=Budget&limit=50');
check('search matches by name', (searched.data??[]).every(m=>/budget/i.test(m.title)) && (searched.data??[]).length>=1,
  `${(searched.data??[]).length} hit(s)`);
const page1 = await api('/api/meet?scope=past&limit=2&offset=0');
const page2 = await api('/api/meet?scope=past&limit=2&offset=2');
check('paging returns different rows',
  page1.data?.[0]?.id && page2.data?.[0]?.id && page1.data[0].id !== page2.data[0].id);
const bad = await api('/api/meet?scope=past&from=not-a-date&limit=5');
check('an unparseable date is ignored, not fatal', bad.data !== undefined, `status ${bad.success}`);

// --- Browser: history page + share panel + scheduler ---
browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1440,height:1000}, deviceScaleFactor:2 });
await ctx.addInitScript(kv=>{for(const [k,v] of Object.entries(kv)) localStorage.setItem(k,v);}, seed);
const page = await ctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message));

await page.goto('http://localhost:5194/app/meet',{waitUntil:'networkidle'});
await page.waitForTimeout(800);
check('the home page offers the full history',
  await page.getByRole('button',{name:/Full history/i}).isVisible().catch(()=>false));
await page.getByRole('button',{name:/Full history/i}).click();
await page.waitForURL(/\/meet\/history$/,{timeout:10000});
await page.waitForTimeout(1200);
await page.screenshot({path:'.meet-ui-shots/history.png'});
check('the history page loads', await page.getByRole('heading',{name:/Meeting history/i}).isVisible());
check('it groups by month',
  (await page.locator('section h2').count()) >= 1,
  `${await page.locator('section h2').count()} group(s)`);
check('the range presets are offered',
  await page.getByRole('button',{name:'Last 7 days'}).isVisible());
await page.getByRole('button',{name:'All time'}).click();
await page.waitForTimeout(900);
const allCount = await page.locator('section button').count();
await page.getByRole('button',{name:'Last 7 days'}).click();
await page.waitForTimeout(900);
const weekCount = await page.locator('section button').count();
check('changing the range changes the results', allCount > weekCount, `all=${allCount} week=${weekCount}`);
await page.getByRole('button',{name:/Custom/i}).click();
await page.waitForTimeout(300);
check('custom shows two date inputs', (await page.locator('input[type="date"]').count()) === 2);

// Scheduler
await page.goto('http://localhost:5194/app/meet/new',{waitUntil:'networkidle'});
await page.waitForTimeout(800);
await page.screenshot({path:'.meet-ui-shots/scheduler.png', fullPage:true});
const toggles = await page.locator('input[type="checkbox"]').count();
check('the scheduler exposes the full settings surface', toggles >= 20, `${toggles} switches`);
check('it groups them into sections',
  (await page.getByRole('heading',{level:2}).count()) >= 4,
  `${await page.getByRole('heading',{level:2}).count()} sections`);

check('no page errors', errors.length===0, errors.slice(0,2).join(' | '));
} catch (err) {
  fail.push('threw');
  console.error(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  await browser.close().catch(() => {});
  try { await pool.query(`DELETE FROM meetings WHERE host_id=$1`, [id]); } catch { /* nothing to remove */ }
  await purgeUsers(pool, [id]);
  await pool.end();
}
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length?1:0);

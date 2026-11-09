import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=path.join(os.homedir(),'.sclaw','agent','scnet-credentials');
const key=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8')).scnet.key;
const BASE='https://api.scnet.cn/api/llm/v1';
const chat=(body)=>fetch(BASE+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json().catch(()=>undefined)}));
const summarize=(r)=>r.status===200?{status:200,reasoningTokens:r.json?.usage?.completion_tokens_details?.reasoning_tokens,completion:r.json?.usage?.completion_tokens,content:r.json?.choices?.[0]?.message?.content?.slice(0,60)}:{status:r.status,error:JSON.stringify(r.json?.error).slice(0,200)};

// invalid reasoning_effort values
for (const v of ['bogus','off','disabled','on','default','auto','minimal ']) {
  const r=await chat({model:'SCNet-Max',messages:[{role:'user',content:'回复ok'}],max_tokens:32,reasoning_effort:v});
  console.log('effort='+JSON.stringify(v), summarize(r));
}

// effort effect on reasoning tokens (same hard prompt)
const hard='一个农夫有17只羊，除了9只以外都死了，还剩几只？请只给答案。';
for (const e of ['none','minimal','low','medium','high','max','xhigh']) {
  const r=await chat({model:'SCNet-Max',messages:[{role:'user',content:hard}],max_tokens:1024,reasoning_effort:e});
  console.log('effort='+e, summarize(r));
}

// burst 8 (cheap, thinking off)
const t0=Date.now();
const rs=await Promise.all(Array.from({length:8},(_,i)=>chat({model:'SCNet-Max',messages:[{role:'user',content:`只输出数字 ${i}`}],max_tokens:8,reasoning_effort:'none'}).catch(e=>({status:'ERR',error:String(e).slice(0,100)})).then(r=>({...summarize(r),i}))));
console.log('burst8 totalMs='+ (Date.now()-t0));
console.log(rs.map(r=>`#${r.i} ${r.status} ${r.error??''}`).join('\n'));

import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=path.join(os.homedir(),'.sclaw','agent','scnet-credentials');
const key=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8')).scnet.key;
const BASE='https://api.scnet.cn/api/llm/v1';
const img=fs.readFileSync('tools/repro/pixel.png').toString('base64');
const chat=(body)=>fetch(BASE+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>({status:r.status,text:await r.text()}));

// image input
let r=await chat({model:'SCNet-Max',max_tokens:128,messages:[{role:'user',content:[{type:'text',text:'这张图是什么颜色？只答颜色'},{type:'image_url',image_url:{url:`data:image/png;base64,${img}`}}]}]});
console.log('image input ->',r.status, r.text.slice(0,500));
fs.writeFileSync('.research/scnet-probe/10-image-input.json', r.text);

// tool follow-up (assistant tool_calls -> tool result)
r=await chat({model:'SCNet-Max',max_tokens:128,messages:[
 {role:'user',content:'杭州天气？调用工具'},
 {role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'get_weather',arguments:'{"city":"杭州"}'}}]},
 {role:'tool',tool_call_id:'call_1',content:'{"temp":21,"weather":"晴"}'}
],tools:[{type:'function',function:{name:'get_weather',description:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}]});
console.log('tool-follow-up ->',r.status, r.text.slice(0,500));
fs.writeFileSync('.research/scnet-probe/11-tool-followup.json', r.text);

// burst 16 minimal
const t0=Date.now();
const rs=await Promise.all(Array.from({length:16},(_,i)=>chat({model:'SCNet-Max',max_tokens:8,reasoning_effort:'none',messages:[{role:'user',content:`ok ${i}`}]}).catch(e=>({status:'ERR',text:String(e)})).then(x=>({i,...x}))));
console.log('burst16 totalMs='+(Date.now()-t0));
for(const x of rs) console.log(`#${x.i} ${x.status} ${x.status===429?x.text.slice(0,300):''}`);
fs.writeFileSync('.research/scnet-probe/12-burst16.json', JSON.stringify(rs.map(({i,status,text})=>({i,status,body:status===200?JSON.parse(text):text})),null,2));


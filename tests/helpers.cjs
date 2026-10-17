const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
const root=path.resolve(__dirname,'..');
function loader(mocks={}){
 const cache=new Map();
 function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  const source=fs.readFileSync(file,'utf8');const module={exports:{}};cache.set(file,module);
  const requireLocal=id=>{
   if(Object.hasOwn(mocks,id))return mocks[id];
   if(id.startsWith('.')||id.startsWith('@/')){
    let target=id.startsWith('@/')?path.join(root,'src',id.slice(2)):path.resolve(path.dirname(file),id);
    if(Object.hasOwn(mocks,target))return mocks[target];
    if(!path.extname(target))target+='.ts';
    if(Object.hasOwn(mocks,target))return mocks[target];
    return load(target);
   }
   return require(id);
  };
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',code)(requireLocal,module,module.exports);return module.exports;
 }
 return load;
}
function fixture(base=1.1){
 const seconds={'15m':900,'1h':3600,'4h':14400,'1d':86400};const now=Math.floor(Date.now()/1000);
 return Object.fromEntries(Object.entries(seconds).map(([tf,step])=>[tf,Array.from({length:tf==='1d'?400:250},(_,i)=>{
  const n=tf==='1d'?400:250;const open=base*(1+i*0.0002+Math.sin(i/6)*0.003);const close=open+base*Math.cos(i/4)*0.001;
  return {timestamp:Math.floor(now/step)*step-(n-1-i)*step,open,close,high:Math.max(open,close)+base*0.001,low:Math.min(open,close)-base*0.001,volume:1000+i%50};
 })]));
}
function fakeDb(resolve){return {from(table){const q={table,operation:'select',filters:[]};const b={};for(const method of ['select','eq','in','upsert','update','insert','or'])b[method]=(...args)=>{if(['upsert','update','insert'].includes(method)){q.operation=method;q.payload=args[0];q.options=args[1];}else if(method==='select')q.columns=args[0];else q.filters.push([method,...args]);return b;};b.maybeSingle=()=>b;b.then=(yes,no)=>Promise.resolve(resolve(q)).then(yes,no);return b;}};}
module.exports={loader,fixture,fakeDb,root};

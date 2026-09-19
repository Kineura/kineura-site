const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const types = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.woff2':'font/woff2','.xml':'application/xml','.txt':'text/plain','.ico':'image/x-icon'};
http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err,data)=>{
    if (err) { fs.readFile(path.join(root,'404.html'), (e2,d2)=>{ res.writeHead(404,{'Content-Type':'text/html'}); res.end(d2||'Not found'); }); return; }
    const ext = path.extname(fp);
    res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
    res.end(data);
  });
}).listen(8099, ()=>console.log('serving on 8099'));

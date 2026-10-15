// Exercise the downloader's actual proxy bootstrap API in a child process.
// No external network is contacted: .invalid requests must reach our proxy fixture.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const proxy = createServer((request, response) => {
  assert.equal(request.url, 'http://release-proxy.invalid/probe');
  response.end('PROXY_ROUTE_OK');
});
const direct = createServer((request, response) => response.end('NO_PROXY_OK'));
await Promise.all([proxy, direct].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const directUrl = `http://127.0.0.1:${direct.address().port}/direct`;
const code = `
 const {createRequire}=require('node:module');
 const fromBuilder=createRequire(require.resolve('app-builder-lib/package.json'));
 fromBuilder('@electron/get').initializeProxy();
 const http=require('node:http');
 const get=url=>new Promise((resolve,reject)=>{http.get(url,res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve(body));}).on('error',reject);});
 (async()=>{const values=await Promise.all([get('http://release-proxy.invalid/probe'),get(process.argv[1])]);if(values[0]!=='PROXY_ROUTE_OK'||values[1]!=='NO_PROXY_OK')throw Error(JSON.stringify(values));console.log('Downloader proxy and NO_PROXY checks passed');})().catch(e=>{console.error(e);process.exitCode=1;});
`;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, directUrl], {
      env: { ...process.env, GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE: 'GLOBAL_AGENT_', GLOBAL_AGENT_HTTP_PROXY: proxyUrl, GLOBAL_AGENT_HTTPS_PROXY: proxyUrl, GLOBAL_AGENT_NO_PROXY: '127.0.0.1', GLOBAL_AGENT_FORCE_GLOBAL_AGENT: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Proxy bootstrap check timed out')); }, 10000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? (console.log(stdout.trim()), resolve()) : reject(new Error(stderr || stdout)); });
  });
} finally { proxy.closeAllConnections(); direct.closeAllConnections(); proxy.close(); direct.close(); }

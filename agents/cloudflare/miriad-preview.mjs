#!/usr/bin/env node
const port=Number(process.argv[2]);
if (!Number.isInteger(port) || port<1024 || port>65535 || port===3000) throw new Error('Usage: miriad-preview <port>, excluding Sandbox control port 3000');
const config=JSON.parse(process.env.MIRIAD_CONFIG ?? '{}');
if (!config.credentials?.secret || !config.credentials?.apiUrl) throw new Error('Miriad runtime credentials are required');
const response=await fetch(`${config.credentials.apiUrl}/api/previews`,{method:'POST',headers:{Authorization:`Server ${config.credentials.secret}`,'Content-Type':'application/json'},body:JSON.stringify({port})});
if (!response.ok) throw new Error(`Preview registration failed (${response.status})`);
console.log((await response.json()).url);

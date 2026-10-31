import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { authorizeRequest, type RequestAccessConfig } from '../src/http-access.js';

const issuer = 'https://example.cloudflareaccess.com';
const config: RequestAccessConfig = { teamDomain: issuer, mcpAudience: 'mcp-aud', adminAudience: 'admin-aud', lanHosts: ['terminology-mcp.localdomain'] };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
async function token(aud = 'mcp-aud', overrides: Record<string, unknown> = {}, key = privateKey) {
  return new SignJWT({ sub: 'user', email: 'owner@example.com', iss: issuer, aud,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
}
const request = (headers: Record<string, string> = {}, peer = '127.0.0.1') => ({
  headers: { host: 'public.example', ...headers }, socket: { remoteAddress: peer },
}) as IncomingMessage;

test('Access enforces distinct MCP and administration audiences, including APIs and assets', async () => {
  const mcp = request({ 'cf-access-jwt-assertion': await token() });
  const admin = request({ 'cf-access-jwt-assertion': await token('admin-aud') });
  assert.equal((await authorizeRequest(mcp, '/mcp', config, keys)).via, 'access');
  for (const path of ['/admin', '/', '/api/state', '/app.js']) {
    assert.equal((await authorizeRequest(admin, path, config, keys)).via, 'access');
    await assert.rejects(authorizeRequest(mcp, path, config, keys), { status: 403 });
  }
  await assert.rejects(authorizeRequest(admin, '/mcp', config, keys), { status: 403 });
});

test('Access rejects expired, premature, wrong-issuer, forged and incomplete JWTs', async () => {
  const other = await generateKeyPair('RS256');
  for (const value of [
    await token('mcp-aud', { exp: 1 }), await token('mcp-aud', { nbf: Math.floor(Date.now()/1000)+600 }),
    await token('mcp-aud', { iss: 'https://evil.example' }), await token('mcp-aud', {}, other.privateKey),
    await token('mcp-aud', { sub: '' }), await token('mcp-aud', { exp: undefined }), 'invalid',
  ]) await assert.rejects(authorizeRequest(request({ 'cf-access-jwt-assertion': value }), '/mcp', config, keys), { status: 403 });
});

test('only direct private peers naming a LAN host can bypass Access; proxy headers and public hosts cannot', async () => {
  for (const [host, peer] of [['localhost', '127.0.0.1'], ['terminology-mcp.localdomain:8000', '192.168.1.20'], ['[::1]:8000', '::1']])
    assert.equal((await authorizeRequest(request({ host }, peer), '/mcp', config, keys)).via, 'lan');
  const proxyHeaders: Record<string, string>[] = [{}, { host: 'localhost', 'cf-ray': 'edge' }, { host: 'localhost', 'cf-access-jwt-assertion': '' },
    {host:'localhost','cf-connecting-ip':'192.168.1.2'}, {host:'localhost','cdn-loop':'cloudflare'}];
  for (const headers of proxyHeaders)
    await assert.rejects(authorizeRequest(request(headers), '/mcp', config, keys), { status: 401 });
  await assert.rejects(authorizeRequest(request({host:'localhost'}, '203.0.113.1'), '/mcp', config, keys), {status:401});
  await assert.rejects(authorizeRequest(request({host:'evil.example@localhost'}), '/mcp', config, keys), {status:400});
  await assert.rejects(authorizeRequest(request({'cf-access-jwt-assertion':await token()}), '/mcp', {...config,mcpAudience:undefined}, keys), {status:503});
});


#!/usr/bin/env node
'use strict';

/**
 * serve-verify.js
 *
 * Zero-dependency local HTTP server for the verification page.
 * Serves tools/verify.html and data/ files.
 *
 * Usage:
 *   node scripts/pipeline/serve-verify.js
 *   # Open http://localhost:3456
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 3456;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function serveFile(filePath, res) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let reqPath = decodeURIComponent(url.pathname);

  // Routes
  if (reqPath === '/' || reqPath === '/index.html') {
    serveFile(path.join(ROOT, 'tools/verify.html'), res);
  } else if (reqPath === '/api/database') {
    serveFile(path.join(ROOT, 'data/database.json'), res);
  } else if (reqPath === '/api/wiki-mappings') {
    serveFile(path.join(ROOT, 'data/wiki-mappings.json'), res);
  } else if (reqPath === '/api/progress') {
    serveFile(path.join(ROOT, 'data/batch-progress.json'), res);
  } else if (reqPath.startsWith('/data/images/')) {
    // Serve images from data/images/
    const imgPath = path.join(ROOT, reqPath.slice(1)); // remove leading /
    serveFile(imgPath, res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  VoiceCast Verification Server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);
});

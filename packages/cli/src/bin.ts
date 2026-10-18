#!/usr/bin/env node
import { run } from './program.js';

const interrupted = new Promise<void>((resolve) => { process.once('SIGINT', () => { resolve(); }); });

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const code = await run(process.argv.slice(2), {
  out: (t) => { process.stdout.write(`${t}\n`); },
  err: (t) => { process.stderr.write(`${t}\n`); },
  readStdin,
  env: process.env,
  interrupted,
});
process.exit(code);

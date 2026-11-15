import { createHmac, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

function hiddenInput(prompt) {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question('', (value) => { rl.close(); resolve(value); });
      return;
    }
    let value = '';
    const finish = () => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', onData);
  });
}

const password = await hiddenInput('Admin password (20+ characters; input hidden): ');
if (password.length < 20) throw new Error('Use a long random passphrase of at least 20 characters.');
const pepper = randomBytes(32);
const digest = createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
console.log('\nAdd these values as GitHub Actions / Cloudflare Worker Secrets. Never commit them:');
console.log('ADMIN_PASSWORD_HASH=' + digest);
console.log('ADMIN_PASSWORD_PEPPER=' + pepper.toString('hex'));

'use strict';
// mailer.send against a minimal fake SMTP server on localhost: what actually
// goes over the wire (envelope, subject, body, and whether it authenticates).
// Pins the SMTP behaviour across nodemailer upgrades.
const net = require('net');
const config = require('config');
const mailer = require('../../../lib/util/mailer');

function fakeSmtp() {
  const seen = { commands: [], data: '' };
  const server = net.createServer((sock) => {
    let inData = false, buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 OK queued\r\n'); }
          else seen.data += line + '\n';
          continue;
        }
        seen.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'HELO') sock.write('250 fake\r\n');
        else if (verb === 'AUTH') sock.write('235 Authentication successful\r\n');
        else if (verb === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

describe('mailer.send over SMTP', () => {
  let smtp, savedMail;
  beforeEach(async () => {
    smtp = await fakeSmtp();
    savedMail = config.app.mail;
  });
  afterEach(() => {
    config.app.mail = savedMail;
    smtp.server.close();
  });

  it('sends the message with the configured from, to, subject and body', async () => {
    config.app.mail = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'Trinket <noreply@example.test>' };
    await mailer.send('student@example.test', 'Your export is ready', { text: 'Download it here.' });

    const cmds = smtp.seen.commands.join('\n');
    expect(cmds).toMatch(/^MAIL FROM:<noreply@example\.test>/m);
    expect(cmds).toMatch(/^RCPT TO:<student@example\.test>/m);
    expect(smtp.seen.data).toMatch(/^Subject: Your export is ready$/m);
    expect(smtp.seen.data).toContain('Download it here.');
    expect(cmds, 'no credentials configured, so no AUTH').not.toMatch(/^AUTH/m);
  });

  it('authenticates when a user and password are configured', async () => {
    config.app.mail = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'noreply@example.test', user: 'mailer', pass: 'pw' };
    await mailer.send('student@example.test', 'Hi', { text: 'x' });
    expect(smtp.seen.commands.join('\n')).toMatch(/^AUTH (PLAIN|LOGIN)/m);
  });

  it('rejects when the server refuses the recipient', async () => {
    smtp.server.removeAllListeners('connection');
    smtp.server.on('connection', (sock) => {
      sock.write('220 fake\r\n');
      sock.on('data', (c) => {
        for (const line of c.toString().split('\r\n').filter(Boolean)) {
          const v = line.split(' ')[0].toUpperCase();
          if (v === 'EHLO' || v === 'HELO') sock.write('250 fake\r\n');
          else if (v === 'RCPT') sock.write('550 no such user\r\n');
          else if (v === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
    });
    config.app.mail = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'noreply@example.test' };
    await expect(mailer.send('nobody@example.test', 'Hi', { text: 'x' })).rejects.toMatchObject({ responseCode: 550 });
  });
});

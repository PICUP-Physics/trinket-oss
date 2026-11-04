'use strict';
// mailer.send against a minimal fake SMTP server on localhost: what actually
// goes over the wire (envelope, subject, body, and whether it authenticates).
// Pins the SMTP behaviour across nodemailer upgrades.
const net = require('net');
const config = require('config');
const mailer = require('../../../lib/util/mailer');

// `reply` answers one command line; the default plays a cooperative server.
function defaultReply(verb, sock) {
  if (verb === 'EHLO') sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
  else if (verb === 'HELO') sock.write('250 fake\r\n');
  else if (verb === 'AUTH') sock.write('235 Authentication successful\r\n');
  else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
  else sock.write('250 OK\r\n');
}

function fakeSmtp(reply = defaultReply) {
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
        if (verb === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else reply(verb, sock);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

describe('mailer.send over SMTP', () => {
  let smtp, savedMail;
  const start = async (reply) => { smtp = await fakeSmtp(reply); return smtp; };
  beforeEach(() => {
    smtp = null;
    savedMail = config.app.mail;
  });
  afterEach(async () => {
    config.app.mail = savedMail;
    if (smtp) await new Promise((resolve) => smtp.server.close(resolve));
  });

  it('sends the message with the configured from, to, subject and body', async () => {
    await start();
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
    await start();
    config.app.mail = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'noreply@example.test', user: 'mailer', pass: 'pw' };
    await mailer.send('student@example.test', 'Hi', { text: 'x' });
    expect(smtp.seen.commands.join('\n')).toMatch(/^AUTH (PLAIN|LOGIN)/m);
  });

  it('does not authenticate with a user but no password', async () => {
    await start();
    config.app.mail = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'noreply@example.test', user: 'mailer' };
    await mailer.send('student@example.test', 'Hi', { text: 'x' });
    expect(smtp.seen.commands.join('\n')).not.toMatch(/^AUTH/m);
  });

  it('rejects when the server refuses the recipient', async () => {
    await start((verb, sock) => {
      if (verb === 'RCPT') sock.write('550 no such user\r\n');
      else defaultReply(verb, sock);
    });
    config.app.mail = { host: '127.0.0.1', port: smtp.port, secure: false, from: 'noreply@example.test' };
    await expect(mailer.send('nobody@example.test', 'Hi', { text: 'x' })).rejects.toMatchObject({ responseCode: 550 });
  });
});

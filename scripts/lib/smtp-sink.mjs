/**
 * A throwaway SMTP server for the mail verify scripts.
 *
 * Speaks just enough of RFC 5321 to accept a message from Nodemailer and hand
 * the envelope + raw DATA back to the test. No TLS, no auth — it exists only on
 * 127.0.0.1 for the duration of one verify run.
 */
import net from 'node:net';

export function startSmtpSink(port = 5195) {
  /** @type {Array<{from:string,to:string[],data:string}>} */
  const received = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    let inData = false;
    let msg = { from: '', to: [], data: '' };
    sock.write('220 sink.local ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf(inData ? '\r\n.\r\n' : '\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (inData ? 5 : 2));
        if (inData) {
          msg.data = line;
          received.push(msg);
          msg = { from: '', to: [], data: '' };
          inData = false;
          sock.write('250 OK queued\r\n');
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) sock.write('250-sink.local\r\n250 OK\r\n');
        else if (upper.startsWith('MAIL FROM')) { msg.from = line.slice(line.indexOf('<') + 1, line.indexOf('>')); sock.write('250 OK\r\n'); }
        else if (upper.startsWith('RCPT TO')) { msg.to.push(line.slice(line.indexOf('<') + 1, line.indexOf('>'))); sock.write('250 OK\r\n'); }
        else if (upper.startsWith('DATA')) { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (upper.startsWith('QUIT')) { sock.write('221 Bye\r\n'); sock.end(); }
        else if (upper.startsWith('RSET')) { msg = { from: '', to: [], data: '' }; sock.write('250 OK\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      received,
      // Force-close: the worker's Nodemailer pool holds connections open, so a
      // graceful server.close() would wait on them forever.
      close: () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    }));
  });
}

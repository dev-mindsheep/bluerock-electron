// IMAP intake: polls a designated inbox, pulls PDF/image attachments from
// authorized senders into the local document queue, marks messages seen.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { addDocument, mimeFor } from './store.js';

/**
 * Check the inbox once. Returns { added, checked }.
 */
export async function checkEmail(settings) {
  const { email, general } = settings;
  if (!email.host || !email.user || !email.password) {
    throw new Error('Email settings incomplete (host, user, password required)');
  }
  const client = new ImapFlow({
    host: email.host,
    port: Number(email.port) || 993,
    secure: email.secure !== false,
    auth: { user: email.user, pass: email.password },
    logger: false,
  });

  const authorized = (general.authorizedSenders || [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let added = 0;
  let checked = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false });
      for (const uid of uids || []) {
        checked++;
        const { content } = await client.download(uid);
        const chunks = [];
        for await (const c of content) chunks.push(c);
        const parsed = await simpleParser(Buffer.concat(chunks));

        const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
        if (authorized.length && !authorized.includes(fromAddr)) {
          // Not an authorized sender — leave unseen so a human can review it in the mail client.
          continue;
        }

        let tookAttachment = false;
        for (const att of parsed.attachments || []) {
          const name = att.filename || `attachment-${uid}`;
          if (!mimeFor(name)) continue;
          addDocument({
            buffer: att.content,
            fileName: name,
            source: 'email',
            meta: {
              from: fromAddr,
              subject: parsed.subject || '',
              receivedAt: (parsed.date || new Date()).toISOString(),
            },
          });
          added++;
          tookAttachment = true;
        }
        if (tookAttachment) {
          await client.messageFlagsAdd(uid, ['\\Seen']);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { added, checked };
}

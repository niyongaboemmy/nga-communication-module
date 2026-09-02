/** Subject prefixing, mirrored from `@tupo/mail`'s render helpers. */
export const replySubject = (s: string) => (/^\s*re\s*:/i.test(s) ? s : `Re: ${s}`);
export const forwardSubject = (s: string) => (/^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`);

/**
 * Advisory checks for text that tries to steer the AI or the approval process.
 * Nothing here changes who may approve or how much is refunded. It only adds warnings
 * a person can see.
 */

const MESSAGE_PATTERNS: Array<{ re: RegExp; warning: string }> = [
  {
    re: /\b(ignore|forget|disregard)\b[^.]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.]{0,30}\b(instruction|rule|prompt|polic)/i,
    warning: "The message tells the AI to ignore its instructions or rules.",
  },
  {
    re: /\b(system|developer)\s+(prompt|message|instruction)/i,
    warning: "The message mentions the AI's system prompt.",
  },
  {
    re: /\b(skip|bypass|override|disable|without|no need for)\b[^.]{0,25}\b(approval|approver|owner|review|rules?|check)/i,
    warning: "The message asks to skip approval or the rules.",
  },
  {
    re: /\bauto[- ]?approve|\bapprove (it|this|the refund)\b[^.]{0,20}\b(now|immediately|automatically)/i,
    warning: "The message asks for automatic approval.",
  },
  {
    re: /\b(you are now|act as|pretend (to be|you are)|new instructions?)\b/i,
    warning: "The message tries to give the AI a new role or new instructions.",
  },
];

export function messageWarnings(customerMessage: string): string[] {
  const out: string[] = [];
  for (const { re, warning } of MESSAGE_PATTERNS) {
    if (re.test(customerMessage) && !out.includes(warning)) out.push(warning);
  }
  return out;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Warn when a draft reply names a dollar amount above the case amount. */
export function replyWarnings(reply: string, caseAmountCents: number): string[] {
  const out: string[] = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const dollars = Number(m[1].replace(/,/g, ""));
    const cents = dollars * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
    if (cents > caseAmountCents) {
      const w = `The draft reply names ${money(cents)}, which is more than the case amount of ${money(caseAmountCents)}.`;
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}
